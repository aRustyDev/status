import { createRemoteJWKSet, jwtVerify } from 'jose'
import { endpointFingerprint, parseEndpoints } from './endpoint-config'
import { getGatusSnapshot, type GatusBinding, type GatusCatalogEntry } from './gatus'
import { parsePersistedHttpConfig } from '../../probe/src/http-monitor'
import { ProbeTestTimeout, requestProbeTest } from './probe-test'
import { getSystemHealthReport } from './system-health'
import { vaultApi, vaultKeyReady, VaultError } from './vault'
import { boundedBody, receiptContext, findReceipt, receiptClaim, receiptFinish, ReceiptError, type Receipt, type ReceiptContext } from './idempotency'

interface Env {
  DB: D1Database
  VAULT_ENCRYPTION_KEY?: string
  ASSETS: Fetcher
  PROBE?: Fetcher
  MONITOR_MODAL?: string
  ACCESS_TEAM_DOMAIN: string
  ACCESS_AUD: string
  ENDPOINTS: string
  GATUS?: GatusBinding
  GATUS_REQUIRED?: string
  BACKUPS?: Fetcher
  BACKUPS_READY?: string
}

type Role = 'viewer' | 'operator' | 'admin'
type User = { id: string; issuer: string; subject: string; email: string; role: Role; version: number }
type Json = Record<string, unknown>
type Row = Record<string, unknown>

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
const roles: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 }
const incidentStatuses = ['investigating', 'identified', 'monitoring', 'resolved']
const impacts = ['minor', 'major', 'critical']
const healthStatuses = ['operational', 'degraded', 'down']
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })
const bad = (message: string): never => { throw new HttpError(400, message) }
const id = () => crypto.randomUUID()
function serializeAdvancedConfig(value: unknown, endpointId: string, expectedStatus: number): string | null {
  if (value === null) return null
  if (!parsePersistedHttpConfig(value, endpointId, 'validation', expectedStatus)) return bad('Invalid advanced check settings')
  const serialized = JSON.stringify(value)
  if (serialized.length > 32_000) return bad('Invalid advanced check settings')
  return serialized
}
// Reuse jose's issuer-scoped JWKS cache across requests in this isolate. The
// resolver retains jose's freshness and key-rotation behavior; it never stores
// request identities or tokens.
const accessKeySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

function accessKeySet(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  let keys = accessKeySets.get(issuer)
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`))
    accessKeySets.set(issuer, keys)
  }
  return keys
}

function string(value: unknown, field: string, max = 4000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return bad(`Invalid ${field}`)
  return value.trim()
}
function choice(value: unknown, field: string, options: string[]): string {
  if (typeof value !== 'string' || !options.includes(value)) return bad(`Invalid ${field}`)
  return value
}
function version(body: Json): number {
  if (!Number.isSafeInteger(body.version) || Number(body.version) < 1) return bad('Invalid version')
  return Number(body.version)
}
function timestamp(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return bad(`Invalid ${field}`)
  return Number(value)
}
function componentIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100 || value.some(item => typeof item !== 'string' || !item)) return bad('Invalid componentIds')
  return [...new Set(value as string[])]
}
async function parseBody(request: Request): Promise<Json> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Expected application/json')
  const raw = await boundedBody(request, false)
  if (raw.length > 64_000) throw new HttpError(413, 'Request body too large')
  let body: unknown
  try { body = JSON.parse(raw) } catch { return bad('Invalid JSON') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('Expected a JSON object')
  return body as Json
}

// Stable key order makes a reordered, otherwise unchanged config a no-op.
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Json)[key])}`).join(',')}}`
  return JSON.stringify(value)
}
async function authenticate(request: Request, env: Env): Promise<User> {
  const token = request.headers.get('Cf-Access-Jwt-Assertion')
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) throw new HttpError(401, 'Access authentication required')
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '')}`
  let subject: string
  let email: string
  try {
    const { payload } = await jwtVerify(token, accessKeySet(issuer), { issuer, audience: env.ACCESS_AUD })
    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string' || !payload.email) throw new Error('Missing human identity')
    subject = payload.sub
    email = payload.email
  } catch { throw new HttpError(401, 'Invalid Access identity') }
  await env.DB.prepare('INSERT INTO users (id, issuer, subject, email) VALUES (?, ?, ?, ?) ON CONFLICT(issuer, subject) DO UPDATE SET email=excluded.email').bind(id(), issuer, subject, email).run()
  const user = await env.DB.prepare('SELECT * FROM users WHERE issuer=? AND subject=?').bind(issuer, subject).first<User>()
  if (!user) throw new Error('User lookup failed')
  return user
}
function requireRole(user: User, role: Role) {
  if (roles[user.role] < roles[role]) throw new HttpError(403, 'Insufficient role')
}
function stmt(db: D1Database, sql: string, ...params: unknown[]): D1PreparedStatement { return db.prepare(sql).bind(...params) }
// Audit output is deliberately an allowlist: older records may contain arbitrary
// user-supplied text or credentials, and new records must not persist them.
function safeAuditDetails(input: unknown): Json {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const value = input as Json
  const result: Json = {}
  const enums: Record<string, string[]> = { status: [...healthStatuses, ...incidentStatuses], impact: impacts, role: ['viewer', 'operator', 'admin'] }
  for (const [key, choices] of Object.entries(enums)) if (typeof value[key] === 'string' && choices.includes(value[key] as string)) result[key] = value[key]
  for (const key of ['position', 'version', 'startsAt', 'endsAt', 'intervalMinutes', 'expectedStatus']) {
    if (Number.isSafeInteger(value[key]) && Number(value[key]) >= 0) result[key] = value[key]
  }
  // Only retain a validated monitor UUID, never an arbitrary user-supplied string.
  if (typeof value.componentId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.componentId)) result.componentId = value.componentId
  if (typeof value.enabled === 'boolean') result.enabled = value.enabled
  return result
}
function parsedAuditDetails(value: unknown): Json {
  try { return safeAuditDetails(JSON.parse(String(value))) } catch { return {} }
}
async function auditPage(db: D1Database, request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams
  const number = (key: string, fallback: number, min: number, max: number) => {
    const raw = params.get(key)
    if (raw === null) return fallback
    if (!/^\d+$/.test(raw)) return bad(`Invalid ${key}`)
    const result = Number(raw)
    if (!Number.isSafeInteger(result) || result < min || result > max) return bad(`Invalid ${key}`)
    return result
  }
  const page = number('page', 1, 1, 1000000), limit = number('limit', 50, 1, 100)
  const from = number('from', 0, 0, Number.MAX_SAFE_INTEGER), to = number('to', Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER)
  if (from > to) return bad('Invalid date range')
  const clauses = ['created_at>=?', 'created_at<=?'], values: unknown[] = [from, to]
  for (const [key, column] of [['userEmail', 'actor_email'], ['entityType', 'entity_type'], ['action', 'action']] as const) {
    const value = params.get(key)
    if (value === null || value === '') continue
    if (value.length > 200) return bad(`Invalid ${key}`)
    if (key === 'userEmail') { clauses.push(`${column} LIKE ? ESCAPE '\\'`); values.push(`%${value.replace(/[\\%_]/g, '\\$&')}%`) }
    else { clauses.push(`${column}=?`); values.push(value) }
  }
  const where = clauses.join(' AND ')
  const count = await stmt(db, `SELECT COUNT(*) AS count FROM audit_events WHERE ${where}`, ...values).first<{count:number}>()
  const rows = await stmt(db, `SELECT id, actor_email AS userEmail, action, entity_type AS entityType, entity_id AS entityId, created_at AS timestamp, details FROM audit_events WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`, ...values, limit, (page - 1) * limit).all<{id:string; userEmail:string; action:string; entityType:string; entityId:string; timestamp:number; details:string}>()
  const total = count?.count ?? 0
  return json({ entries: rows.results.map(({ details, ...row }) => ({ ...row, entityName: row.entityId, diff: parsedAuditDetails(details) })), total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) })
}
function audit(db: D1Database, user: User, action: string, entityType: string, entityId: string, details: Json, guard?: { table: string; token: string; id?: string }): D1PreparedStatement {
  const values = [id(), user.email, action, entityType, entityId, Date.now(), JSON.stringify(safeAuditDetails(details))]
  if (!guard) return stmt(db, 'INSERT INTO audit_events (id, actor_email, action, entity_type, entity_id, created_at, details) VALUES (?, ?, ?, ?, ?, ?, ?)', ...values)
  return stmt(db, `INSERT INTO audit_events (id, actor_email, action, entity_type, entity_id, created_at, details) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM ${guard.table} WHERE id=? AND mutation_key=?)`, ...values, guard.id ?? entityId, guard.token)
}
async function replayReceipt(db: D1Database, ctx: ReceiptContext, row: Receipt): Promise<Response> {
  const body = ctx.body, id = row.result_id, version = row.result_version
  const path = ctx.path.replace(/^\/api\/v1\/bsp\//, '/api/v1/')
  if ((ctx.method === 'POST' && path === '/api/v1/admin/monitors') || (ctx.method === 'PATCH' && /^\/api\/v1\/admin\/monitors\/[^/]+$/.test(path))) return json({ id: row.result_alias, version }, row.status)
  if (ctx.method === 'POST' && path === '/api/v1/admin/components') return json({ id, name: string(body.name, 'name', 200), position: body.position ?? 0, manualStatus: body.manualStatus ?? 'operational', version }, row.status)
  if (ctx.method === 'PATCH' && /^\/api\/v1\/admin\/components\/[^/]+$/.test(path)) return json({ id, name: string(body.name, 'name', 200), manualStatus: body.manualStatus, position: body.position, version }, row.status)
  if (ctx.method === 'POST' && path === '/api/v1/admin/incidents') {
    if (ctx.path.startsWith('/api/v1/bsp/')) return json({ id: row.result_alias, version }, row.status)
    return json({ id, title: string(body.title, 'title', 200), impact: body.impact ?? 'minor', status: 'investigating', draft: true, componentIds: componentIds(body.componentIds ?? []), version }, row.status)
  }
  if (ctx.method === 'POST' && path === '/api/v1/admin/maintenance') {
    let ids = componentIds(body.componentIds ?? [])
    if (ctx.path.startsWith('/api/v1/bsp/') && Array.isArray(body.monitorIds)) {
      const aliases = [...new Set(body.monitorIds.map(Number))]
      const rows = aliases.length ? (await db.prepare(`SELECT alias,entity_id FROM entity_aliases WHERE entity_type='component' AND alias IN (${aliases.map(() => '?').join(',')})`).bind(...aliases).all<{alias:number;entity_id:string}>()).results : []
      const byAlias = new Map(rows.map(item => [item.alias, item.entity_id]))
      ids = aliases.map(alias => byAlias.get(alias)!).filter(Boolean)
    }
    return json({ id, name: string(body.name, 'name', 200), description: body.description ? string(body.description, 'description') : '', startsAt: body.startsAt, endsAt: body.endsAt, componentIds: ids, version }, row.status)
  }
  if (ctx.method === 'PATCH' && /^\/api\/v1\/admin\/users\/[^/]+$/.test(path)) return json({ id, role: body.role, version }, row.status)
  return json({ id, version }, row.status)
}

async function commitMutation(db: D1Database, statements: D1PreparedStatement[], ctx: ReceiptContext | null,
  resultId: string, resultVersion: number, status: number, guardSql: string, guardValues: unknown[], aliasType?: string): Promise<Receipt | null> {
  if (!ctx) { if (statements.length) await db.batch(statements); return null }
  const token = id()
  try {
    await db.batch([db.prepare('DELETE FROM mutation_receipts WHERE rowid IN (SELECT rowid FROM mutation_receipts WHERE expires_at<=? LIMIT 100)').bind(Date.now()), receiptClaim(db, ctx, token), ...statements, receiptFinish(db, ctx, token, status, resultId, resultVersion, guardSql, guardValues, aliasType)])
    return null
  } catch (error) {
    const existing = await findReceipt(db, ctx)
    if (existing) return existing
    if (error instanceof Error && error.message.includes('NOT NULL constraint failed: mutation_receipts.status')) throw new HttpError(409, 'This record changed. Reload and try again.')
    if (error instanceof Error && error.message.includes('Mutation identity changed')) throw new HttpError(403, 'Insufficient role')
    throw error
  }
}

async function mutate(db: D1Database, first: D1PreparedStatement, rest: D1PreparedStatement[], ctx: ReceiptContext | null,
  resultId: string, resultVersion: number, guardSql: string, guardValues: unknown[]): Promise<Receipt | null> {
  if (ctx) return commitMutation(db, [first, ...rest], ctx, resultId, resultVersion, 200, guardSql, guardValues)
  const result = await db.batch([first, ...rest])
  if (!result[0].meta.changes) throw new HttpError(409, 'This record changed. Reload and try again.')
  return null
}
async function validateComponents(db: D1Database, ids: string[]) {
  if (!ids.length) return
  const result = await stmt(db, `SELECT COUNT(*) AS count FROM components WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids).first<{ count: number }>()
  if (result?.count !== ids.length) bad('Unknown component')
}
function links(db: D1Database, table: 'incident_components' | 'maintenance_components', key: string, owner: string, ids: string[], guardTable?: string, token?: string): D1PreparedStatement[] {
  return ids.map(component => guardTable
    ? stmt(db, `INSERT INTO ${table} (${key}, component_id) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM ${guardTable} WHERE id=? AND mutation_key=?) AND NOT EXISTS (SELECT 1 FROM ${table} WHERE ${key}=? AND component_id=?)`, owner, component, owner, token, owner, component)
    : stmt(db, `INSERT INTO ${table} (${key}, component_id) VALUES (?, ?)`, owner, component))
}
async function listIncidents(db: D1Database, admin: boolean): Promise<Json[]> {
  const visibility = admin ? '' : 'AND draft=0'
  const selected = `SELECT * FROM incidents WHERE 1=1 ${visibility} AND (
    status <> 'resolved' OR id IN (
      SELECT id FROM incidents WHERE status='resolved' ${visibility} ORDER BY created_at DESC, id DESC LIMIT 200
    )
  )`
  const [records, related, updates] = await Promise.all([
    db.prepare(`WITH selected AS (${selected}) SELECT * FROM selected ORDER BY created_at DESC, id DESC`).all<Row>(),
    db.prepare(`WITH selected AS (${selected}) SELECT ic.incident_id, ic.component_id, c.name AS component_name FROM incident_components ic JOIN selected i ON i.id=ic.incident_id JOIN components c ON c.id=ic.component_id`).all<{incident_id:string;component_id:string;component_name:string}>(),
    db.prepare(`WITH selected AS (${selected}) SELECT u.incident_id, u.id, u.body, u.status, u.posted_at AS postedAt FROM incident_updates u JOIN selected i ON i.id=u.incident_id ORDER BY u.posted_at, u.rowid`).all<{incident_id:string}>(),
  ])
  return records.results.map(row => ({ id:row.id,title:row.title,status:row.status,impact:row.impact,draft:Boolean(row.draft),createdAt:row.created_at,updatedAt:row.updated_at,resolvedAt:row.resolved_at,version:row.version,componentIds:related.results.filter(r=>r.incident_id===row.id).map(r=>r.component_id),componentNames:Object.fromEntries(related.results.filter(r=>r.incident_id===row.id).map(r=>[r.component_id,r.component_name])),updates:updates.results.filter(r=>r.incident_id===row.id) }))
}
async function listMaintenance(db: D1Database, admin: boolean): Promise<Json[]> {
  const now = Date.now()
  const visibility = admin ? '' : 'AND cancelled=0'
  const selected = `SELECT * FROM maintenance WHERE 1=1 ${visibility} AND (
    (cancelled=0 AND ends_at>?) OR id IN (
      SELECT id FROM maintenance WHERE (cancelled=1 OR ends_at<=?) ${visibility}
      ORDER BY starts_at DESC, id DESC LIMIT 200
    )
  )`
  const [rows, related] = await Promise.all([
    stmt(db, `WITH selected AS (${selected}) SELECT * FROM selected ORDER BY starts_at DESC, id DESC`, now, now).all<Row>(),
    stmt(db, `WITH selected AS (${selected}) SELECT mc.maintenance_id, mc.component_id, c.name AS component_name FROM maintenance_components mc JOIN selected m ON m.id=mc.maintenance_id JOIN components c ON c.id=mc.component_id`, now, now).all<{maintenance_id:string;component_id:string;component_name:string}>(),
  ])
  return rows.results.map(row => ({ id:row.id,name:row.name,description:row.description,startsAt:row.starts_at,endsAt:row.ends_at,componentIds:related.results.filter(r=>r.maintenance_id===row.id).map(r=>r.component_id),componentNames:Object.fromEntries(related.results.filter(r=>r.maintenance_id===row.id).map(r=>[r.component_id,r.component_name])),state:row.cancelled ? 'cancelled' : Number(row.starts_at)>now ? 'upcoming' : Number(row.ends_at)>now ? 'active' : 'past',version:row.version }))
}
async function listComponents(db: D1Database, incidents: Json[], maintenance: Json[], env: Env): Promise<Json[]> {
  const rows = await db.prepare(`SELECT c.*, h.endpoint_id, h.enabled AS check_enabled, h.last_status, h.last_effective_status, h.last_effective_scheduled_at, h.last_scheduled_at, h.last_result_at,
    h.interval_minutes, r.fingerprint AS registered_fingerprint, g.source_id, g.kind AS source_kind,
    g.source_key, g.source_name, g.source_group, g.stale_after_seconds, g.advisory
    FROM components c LEFT JOIN http_checks h ON h.component_id=c.id
    LEFT JOIN endpoint_registry r ON r.endpoint_id=h.endpoint_id
    LEFT JOIN gatus_sources g ON g.component_id=c.id
    WHERE g.component_id IS NULL OR g.active=1 ORDER BY position, name`).all<Row>()
  const sourceRows = rows.results.filter(row => row.source_id != null)
  if (env.GATUS_REQUIRED !== undefined && !['true', 'false'].includes(env.GATUS_REQUIRED)) throw new HttpError(503, 'Invalid Gatus configuration')
  if ((env.GATUS || env.GATUS_REQUIRED === 'true') && !sourceRows.length) throw new HttpError(503, 'Gatus catalog is not configured')
  const catalog: GatusCatalogEntry[] = sourceRows.map(row => ({
    kind: row.source_kind as 'endpoint' | 'suite', key: String(row.source_key), name: String(row.source_name),
    group: String(row.source_group), staleAfterSeconds: Number(row.stale_after_seconds), advisory: Boolean(row.advisory),
  }))
  const gatus = env.GATUS && catalog.length ? await getGatusSnapshot(env.GATUS, catalog) : undefined
  if (sourceRows.length && (!env.GATUS || !gatus?.available)) console.error(JSON.stringify({ event: 'gatus_snapshot_unavailable' }))
  const gatusById = new Map(gatus?.monitors.map(monitor => [monitor.sourceId, monitor]) ?? [])
  const configured = parseEndpoints(env.ENDPOINTS)
  const fingerprints = new Map(await Promise.all([...configured].map(async ([id, endpoint]) => [id, await endpointFingerprint(endpoint)] as const)))
  const severity: Record<string, number> = { operational: 0, unknown: 1, degraded: 2, down: 3 }
  return rows.results.map(row => {
    let state = String(row.manual_status)
    let checkStatus: string | null = null
    const isGatus = row.source_id != null
    const source = isGatus ? gatusById.get(String(row.source_id)) : undefined
    if (isGatus) {
      checkStatus = source?.health === 'up' ? 'operational' : source?.health === 'down' ? 'down' : source?.health === 'degraded' ? 'degraded' : 'unknown'
      if (severity[checkStatus] > severity[state]) state = checkStatus
    }
    const matches = Boolean(row.registered_fingerprint) && fingerprints.get(String(row.endpoint_id)) === row.registered_fingerprint
    if (row.check_enabled) {
      const stale = !matches || !row.last_result_at || Date.now() - Number(row.last_result_at) > Number(row.interval_minutes) * 180_000
      const effective = row.last_effective_scheduled_at != null && row.last_effective_scheduled_at === row.last_scheduled_at ? row.last_effective_status ?? row.last_status : row.last_status
      checkStatus = stale ? 'unknown' : effective === 'up' ? 'operational' : effective === 'degraded' ? 'degraded' : 'down'
      if (severity[checkStatus] > severity[state]) state = checkStatus
    }
    for (const incident of incidents) {
      if (incident.status === 'resolved' || ((incident.componentIds as string[]).length > 0 && !(incident.componentIds as string[]).includes(String(row.id)))) continue
      const impact = incident.impact === 'minor' ? 'degraded' : 'down'
      if (severity[impact] > severity[state]) state = impact
    }
    const underMaintenance = maintenance.some(window => window.state === 'active' && (!(window.componentIds as string[]).length || (window.componentIds as string[]).includes(String(row.id))))
    return { id: row.id, name: row.name, position: row.position, manualStatus: row.manual_status, tags: isGatus ? [] : JSON.parse(String(row.tags)), status: state, checkStatus, lastCheckedAt: isGatus ? source?.lastCheckedAt ?? null : matches ? row.last_result_at ?? null : null, underMaintenance, version: row.version, ...(isGatus ? { source: 'gatus', group: row.source_group } : {}) }
  })
}

function serializeMonitorTags(value: unknown): string {
  if (!Array.isArray(value) || value.length > 20) return bad('Invalid tags')
  const labels = new Set<string>()
  const tags = value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return bad('Invalid tag')
    const tag = item as Json
    if (typeof tag.label !== 'string' || !tag.label.trim() || tag.label.trim().length > 40 ||
      typeof tag.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(tag.color)) return bad('Invalid tag')
    const label = tag.label.trim()
    if (labels.has(label)) return bad('Duplicate tag')
    labels.add(label)
    return { label, color: tag.color }
  })
  return JSON.stringify(tags)
}

type Endpoint = { id: string; name?: string }
function approvedEndpoints(env: Env): Endpoint[] {
  try {
    return [...parseEndpoints(env.ENDPOINTS).values()]
  } catch { throw new Error('Invalid ENDPOINTS configuration') }
}

async function api(request: Request, env: Env, user: User, path: string, receipt: ReceiptContext | null = null): Promise<Response> {
  const method = request.method
  const db = env.DB
  if (path === '/api/v1/auth/me' && method === 'GET') return json({ id: user.id, email: user.email, role: user.role, version: user.version, serverTime: Date.now() })
  if (path.startsWith('/api/v1/public/') && method === 'GET') {
    if (path === '/api/v1/public/incidents') return json(await listIncidents(db, false))
    if (path === '/api/v1/public/maintenances') return json(await listMaintenance(db, false))
    if (path === '/api/v1/public/status') {
      const [incidents, maintenance] = await Promise.all([listIncidents(db, false), listMaintenance(db, false)])
      return json({ components: await listComponents(db, incidents, maintenance, env), activeIncidents: incidents.filter(i => i.status !== 'resolved'), activeMaintenanceWindows: maintenance.filter(m => m.state === 'active') })
    }
  }
  if (!path.startsWith('/api/v1/admin/')) throw new HttpError(404, 'Not found')
  const parts = path.slice('/api/v1/admin/'.length).split('/')
  const [resource, recordId, action] = parts
  if (parts.length > 3) throw new HttpError(404, 'Not found')
  requireRole(user, resource === 'users' || resource === 'audit' || resource === 'checks' || resource === 'endpoints' ? 'admin' : 'operator')
  if (method === 'GET') {
    if (resource === 'incidents' && !recordId) return json(await listIncidents(db, true))
    if (resource === 'maintenance' && !recordId) return json(await listMaintenance(db, true))
    if (resource === 'components' && !recordId) return json(await listComponents(db, await listIncidents(db, false), await listMaintenance(db, false), env))
    if (resource === 'users' && !recordId) return json((await db.prepare('SELECT id, email, role, version FROM users ORDER BY email').all()).results)
    if (resource === 'audit' && !recordId) {
      const rows = await db.prepare('SELECT id, actor_email AS actorEmail, action, entity_type AS entityType, entity_id AS entityId, created_at AS createdAt, details FROM audit_events ORDER BY created_at DESC LIMIT 200').all<Row>()
      return json(rows.results.map(row => ({ ...row, details: JSON.stringify(parsedAuditDetails(row.details)) })))
    }
    if (resource === 'checks' && !recordId) {
      const checks = (await db.prepare('SELECT id, component_id AS componentId, endpoint_id AS endpointId, enabled, interval_minutes AS intervalMinutes, expected_status AS expectedStatus, config_version AS version, advanced_config AS advancedConfig FROM http_checks').all<Row>()).results
      return json(checks.map(check => {
        if (check.advancedConfig === null) return check
        try {
          const advanced = JSON.parse(String(check.advancedConfig)) as unknown
          return parsePersistedHttpConfig(advanced, String(check.endpointId), 'validation', Number(check.expectedStatus))
            ? { ...check, advancedConfig: advanced }
            : { ...check, advancedConfig: null, advancedConfigInvalid: true }
        } catch { return { ...check, advancedConfig: null, advancedConfigInvalid: true } }
      }))
    }
    if (resource === 'endpoints' && !recordId) return json(approvedEndpoints(env).map(endpoint => ({ id: endpoint.id, name: endpoint.name ?? endpoint.id })))
    throw new HttpError(404, 'Not found')
  }
  if (resource === 'components' && recordId && method !== 'GET' && await stmt(db, 'SELECT component_id FROM gatus_sources WHERE component_id=?', recordId).first()) throw new HttpError(403, 'Gatus-managed component is read-only')
  const body = await parseBody(request)
  const now = Date.now()
  if (resource === 'components') {
    if (method === 'POST' && !recordId) {
      const componentId = id()
      const name = string(body.name, 'name', 200)
      const status = choice(body.manualStatus ?? 'operational', 'manualStatus', healthStatuses)
      const position = body.position === undefined ? 0 : timestamp(body.position, 'position')
      const replay = await commitMutation(db, [stmt(db, 'INSERT INTO components (id,name,position,manual_status,updated_at) VALUES (?,?,?,?,?)', componentId, name, position, status, now), audit(db,user,'create','component',componentId,{name,status})], receipt, componentId, 1, 201, 'SELECT 1 FROM components WHERE id=?', [componentId])
      if (replay) return replayReceipt(db, receipt!, replay)
      return json({ id: componentId, name, position, manualStatus: status, version: 1 }, 201)
    }
    if (method === 'PATCH' && recordId && !action) {
      if (receipt && (!Object.hasOwn(body, 'name') || !Object.hasOwn(body, 'manualStatus') || !Object.hasOwn(body, 'position'))) return bad('Idempotent component edits require all component fields')
      const current = await stmt(db, 'SELECT * FROM components WHERE id=?', recordId).first<Row>()
      if (!current) throw new HttpError(404, 'Component not found')
      const name = body.name === undefined ? current.name : string(body.name, 'name', 200)
      const status = body.manualStatus === undefined ? current.manual_status : choice(body.manualStatus, 'manualStatus', healthStatuses)
      const position = body.position === undefined ? current.position : timestamp(body.position, 'position')
      const token = id()
      const replay = await mutate(db, stmt(db, 'UPDATE components SET name=?, manual_status=?, position=?, updated_at=?, version=version+1, mutation_key=? WHERE id=? AND version=?', name,status,position,now,token,recordId,version(body)), [audit(db,user,'update','component',recordId,{name,status,position},{table:'components',token})], receipt, recordId, Number(body.version)+1, 'SELECT 1 FROM components WHERE id=? AND mutation_key=?', [recordId,token])
      if (replay) return replayReceipt(db, receipt!, replay)
      return json({ id:recordId,name,manualStatus:status,position,version:Number(body.version)+1 })
    }
  }
  if (resource === 'incidents') {
    if (method === 'POST' && !recordId) {
      const incidentId = id()
      const title = string(body.title, 'title', 200)
      const impact = choice(body.impact ?? 'minor', 'impact', impacts)
      const message = string(body.body, 'body')
      const ids = componentIds(body.componentIds ?? [])
      await validateComponents(db, ids)
      const replay = await commitMutation(db, [
        stmt(db,'INSERT INTO incidents (id,title,status,impact,draft,created_at,updated_at) VALUES (?,?,?,?,1,?,?)',incidentId,title,'investigating',impact,now,now),
        stmt(db,'INSERT INTO incident_updates (id,incident_id,body,status,posted_at) VALUES (?,?,?,?,?)',id(),incidentId,message,'investigating',now),
        ...links(db,'incident_components','incident_id',incidentId,ids),audit(db,user,'create','incident',incidentId,{title,impact})
      ], receipt, incidentId, 1, 201, 'SELECT 1 FROM incidents WHERE id=?', [incidentId])
      if (replay) return replayReceipt(db, receipt!, replay)
      return json({ id:incidentId,title,impact,status:'investigating',draft:true,componentIds:ids,version:1 },201)
    }
    if (recordId && (method === 'PATCH' || method === 'POST')) {
      const current = await stmt(db,'SELECT * FROM incidents WHERE id=?',recordId).first<Row>()
      if (!current) throw new HttpError(404,'Incident not found')
      const token = id()
      let title = current.title, impact = current.impact, status = current.status, draft = current.draft, resolved = current.resolved_at
      let ids: string[] | undefined
      const extra: D1PreparedStatement[] = []
      let event = 'update'
      if (method === 'POST' && action === 'publish') {
        if (!draft) throw new HttpError(409,'Incident already published')
        draft = 0
        event = 'publish'
      } else if (method === 'POST' && action === 'updates') {
        const message = string(body.body,'body')
        status = choice(body.status,'status',incidentStatuses)
        resolved = status === 'resolved' ? now : null
        event = 'timeline_update'
        extra.push(stmt(db,'INSERT INTO incident_updates (id,incident_id,body,status,posted_at) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM incidents WHERE id=? AND mutation_key=?)',id(),recordId,message,status,now,recordId,token))
      } else if (method === 'PATCH' && !action) {
        if (body.title !== undefined) title = string(body.title,'title',200)
        if (body.impact !== undefined) impact = choice(body.impact,'impact',impacts)
        if (body.body !== undefined) {
          if (!draft) throw new HttpError(409, 'Only draft opening messages can be edited')
          const opening = string(body.body, 'body')
          extra.push(stmt(db, `UPDATE incident_updates SET body=?
            WHERE id=(SELECT id FROM incident_updates WHERE incident_id=? ORDER BY rowid LIMIT 1)
            AND EXISTS (SELECT 1 FROM incidents WHERE id=? AND mutation_key=? AND draft=1)`,
          opening, recordId, recordId, token))
        }
        if (body.componentIds !== undefined) { ids = componentIds(body.componentIds); await validateComponents(db,ids) }
      } else throw new HttpError(404,'Not found')
      if (ids) {
        extra.push(stmt(db,`DELETE FROM incident_components WHERE incident_id=? AND NOT EXISTS (SELECT 1 FROM json_each(?) WHERE value=incident_components.component_id) AND EXISTS (SELECT 1 FROM incidents WHERE id=? AND mutation_key=?)`,recordId,JSON.stringify(ids),recordId,token))
        extra.push(...links(db,'incident_components','incident_id',recordId,ids,'incidents',token))
      }
      extra.push(audit(db,user,event,'incident',recordId,{title,status,impact},{table:'incidents',token}))
      const replay = await mutate(db,stmt(db,'UPDATE incidents SET title=?,impact=?,status=?,draft=?,resolved_at=?,updated_at=?,version=version+1,mutation_key=? WHERE id=? AND version=?',title,impact,status,draft,resolved,now,token,recordId,version(body)),extra,receipt,recordId,Number(body.version)+1,'SELECT 1 FROM incidents WHERE id=? AND mutation_key=?',[recordId,token])
      if (replay) return replayReceipt(db, receipt!, replay)
      return json({id:recordId,version:Number(body.version)+1})
    }
  }
  if (resource === 'maintenance') {
    if (method === 'POST' && !recordId) {
      const maintenanceId = id()
      const name = string(body.name,'name',200)
      const description = body.description === undefined || body.description === '' ? '' : string(body.description,'description')
      const starts = timestamp(body.startsAt,'startsAt'), ends = timestamp(body.endsAt,'endsAt')
      if (ends <= starts) bad('End must be after start')
      const ids = componentIds(body.componentIds ?? [])
      await validateComponents(db,ids)
      const replay = await commitMutation(db,[stmt(db,'INSERT INTO maintenance (id,name,description,starts_at,ends_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',maintenanceId,name,description,starts,ends,now,now),...links(db,'maintenance_components','maintenance_id',maintenanceId,ids),audit(db,user,'create','maintenance',maintenanceId,{name,startsAt:starts,endsAt:ends})],receipt,maintenanceId,1,201,'SELECT 1 FROM maintenance WHERE id=?',[maintenanceId])
      if (replay) return replayReceipt(db, receipt!, replay)
      return json({id:maintenanceId,name,description,startsAt:starts,endsAt:ends,componentIds:ids,version:1},201)
    }
    if (recordId && (method === 'PATCH' || method === 'POST')) {
      const current = await stmt(db,'SELECT * FROM maintenance WHERE id=?',recordId).first<Row>()
      if (!current) throw new HttpError(404,'Maintenance not found')
      const token = id()
      let name = current.name, description = current.description, starts = Number(current.starts_at), ends = Number(current.ends_at), cancelled = current.cancelled
      let ids: string[] | undefined
      let event = 'update'
      if (method === 'POST' && action === 'cancel') {
        if (cancelled || starts <= now) throw new HttpError(409,'Only upcoming windows can be cancelled')
        cancelled = 1; event = 'cancel'
      } else if (method === 'POST' && action === 'end') {
        if (cancelled || starts > now || ends <= now) throw new HttpError(409,'Only active windows can be ended')
        ends = Math.max(starts + 1, now); event = 'end'
      } else if (method === 'PATCH' && !action) {
        if (cancelled) throw new HttpError(409,'Cancelled windows cannot be edited')
        if (body.name !== undefined) name = string(body.name,'name',200)
        if (body.description !== undefined) description = body.description === '' ? '' : string(body.description,'description')
        if (body.startsAt !== undefined) starts = timestamp(body.startsAt,'startsAt')
        if (body.endsAt !== undefined) ends = timestamp(body.endsAt,'endsAt')
        if (body.componentIds !== undefined) { ids = componentIds(body.componentIds); await validateComponents(db,ids) }
      } else throw new HttpError(404,'Not found')
      if (ends <= starts) bad('End must be after start')
      const extra: D1PreparedStatement[] = []
      if (ids) {
        extra.push(stmt(db,`DELETE FROM maintenance_components WHERE maintenance_id=? AND NOT EXISTS (SELECT 1 FROM json_each(?) WHERE value=maintenance_components.component_id) AND EXISTS (SELECT 1 FROM maintenance WHERE id=? AND mutation_key=?)`,recordId,JSON.stringify(ids),recordId,token))
        extra.push(...links(db,'maintenance_components','maintenance_id',recordId,ids,'maintenance',token))
      }
      extra.push(audit(db,user,event,'maintenance',recordId,{name,startsAt:starts,endsAt:ends},{table:'maintenance',token}))
      const replay = await mutate(db,stmt(db,'UPDATE maintenance SET name=?,description=?,starts_at=?,ends_at=?,cancelled=?,updated_at=?,version=version+1,mutation_key=? WHERE id=? AND version=?',name,description,starts,ends,cancelled,now,token,recordId,version(body)),extra,receipt,recordId,Number(body.version)+1,'SELECT 1 FROM maintenance WHERE id=? AND mutation_key=?',[recordId,token])
      if (replay) return replayReceipt(db, receipt!, replay)
      return json({id:recordId,version:Number(body.version)+1})
    }
  }

  if (resource === 'checks' && method === 'PUT' && recordId && action === 'advanced') {
    if (Object.keys(body).some(key => key !== 'version' && key !== 'advancedConfig') || !Object.hasOwn(body, 'advancedConfig')) return bad('Invalid advanced check settings')
    const submittedVersion = version(body)
    const current = await stmt(db, 'SELECT c.endpoint_id AS endpointId, c.expected_status AS expectedStatus, c.config_version AS version, c.advanced_config AS advancedConfig, g.component_id AS gatusComponent FROM http_checks c LEFT JOIN gatus_sources g ON g.component_id=c.component_id WHERE c.id=?', recordId).first<{ endpointId:string; expectedStatus:number; version:number; advancedConfig:string | null; gatusComponent:string | null }>()
    if (!current) throw new HttpError(404, 'Check not found')
    if (current.gatusComponent) throw new HttpError(403, 'Gatus-managed component is read-only')
    if (current.version !== submittedVersion) throw new HttpError(409, 'This record changed. Reload and try again.')
    const candidate = body.advancedConfig
    const serialized = serializeAdvancedConfig(candidate, current.endpointId, current.expectedStatus)
    let unchanged = serialized === null && current.advancedConfig === null
    if (serialized !== null && current.advancedConfig !== null) {
      try { unchanged = stableJson(candidate) === stableJson(JSON.parse(current.advancedConfig)) } catch { unchanged = false }
    }
    if (unchanged) {
      const replay = await commitMutation(db, [], receipt, recordId, submittedVersion, 200, 'SELECT 1 FROM http_checks WHERE id=? AND config_version=?', [recordId, submittedVersion])
      if (replay) return replayReceipt(db, receipt!, replay)
      return json({ id:recordId, version:submittedVersion })
    }
    const token = id()
    const replay = await mutate(db, stmt(db, 'UPDATE http_checks SET advanced_config=?, mutation_key=? WHERE id=? AND config_version=?', serialized, token, recordId, submittedVersion), [audit(db,user,'update','check',recordId,{version:submittedVersion+1},{table:'http_checks',token})],receipt,recordId,submittedVersion+1,'SELECT 1 FROM http_checks WHERE id=? AND mutation_key=?',[recordId,token])
    if (replay) return replayReceipt(db, receipt!, replay)
    return json({ id:recordId, version:submittedVersion+1 })
  }

  if (resource === 'checks' && (method === 'POST' && !recordId || method === 'PATCH' && recordId && !action)) {
    const componentId = string(body.componentId, 'componentId', 100)
    if (await stmt(db, 'SELECT component_id FROM gatus_sources WHERE component_id=?', componentId).first()) throw new HttpError(403, 'Gatus-managed component is read-only')
    if (recordId && await stmt(db, 'SELECT c.id FROM http_checks c JOIN gatus_sources g ON g.component_id=c.component_id WHERE c.id=?', recordId).first()) throw new HttpError(403, 'Gatus-managed component is read-only')
    const endpointId = string(body.endpointId, 'endpointId', 100)
    if (!approvedEndpoints(env).some(endpoint => endpoint.id === endpointId)) bad('Unknown approved endpoint')
    await validateComponents(db, [componentId])
    if (typeof body.enabled !== 'boolean') bad('Invalid enabled')
    if (body.intervalMinutes !== 1 && body.intervalMinutes !== 5) bad('Invalid intervalMinutes')
    if (!Number.isInteger(body.expectedStatus) || Number(body.expectedStatus) < 100 || Number(body.expectedStatus) > 599) bad('Invalid expectedStatus')
    if (method === 'POST') {
      const checkId = id()
      const replay = await commitMutation(db,[stmt(db, 'INSERT INTO http_checks (id,component_id,endpoint_id,enabled,interval_minutes,expected_status,config_version) VALUES (?,?,?,?,?,?,1)',checkId,componentId,endpointId,body.enabled ? 1 : 0,body.intervalMinutes,body.expectedStatus),audit(db,user,'create','check',checkId,{componentId,enabled:body.enabled,intervalMinutes:body.intervalMinutes,expectedStatus:body.expectedStatus})],receipt,checkId,1,201,'SELECT 1 FROM http_checks WHERE id=?',[checkId])
      if (replay) return replayReceipt(db, receipt!, replay)
      return json({id:checkId,version:1},201)
    }
    const token = id()
    const replay = await mutate(db,stmt(db,'UPDATE http_checks SET component_id=?,endpoint_id=?,enabled=?,interval_minutes=?,expected_status=?,config_version=config_version+1,last_scheduled_at=NULL,last_result_at=NULL,last_status=NULL,mutation_key=? WHERE id=? AND config_version=?',componentId,endpointId,body.enabled ? 1 : 0,body.intervalMinutes,body.expectedStatus,token,recordId,version(body)),[audit(db,user,'update','check',recordId,{componentId,enabled:body.enabled,intervalMinutes:body.intervalMinutes,expectedStatus:body.expectedStatus},{table:'http_checks',token})],receipt,recordId,Number(body.version)+1,'SELECT 1 FROM http_checks WHERE id=? AND mutation_key=?',[recordId,token])
    if (replay) return replayReceipt(db, receipt!, replay)
    return json({id:recordId,version:Number(body.version)+1})
  }

  if (resource === 'users' && method === 'PATCH' && recordId && !action) {
    const role = choice(body.role,'role',['viewer','operator','admin'])
    if (recordId === user.id && role !== 'admin') throw new HttpError(409,'An admin cannot remove their own admin role')
    const token = id()
    // Check the actor and the administrator count in the same transaction as
    // the update. Concurrent administrators must not demote each other and
    // leave the board without an administrator.
    const replay = await mutate(db,stmt(db,`UPDATE users SET role=?,version=version+1,mutation_key=?
      WHERE id=? AND version=?
      AND EXISTS (SELECT 1 FROM users actor WHERE actor.id=? AND actor.role='admin' AND actor.version=?)
      AND (?='admin' OR role<>'admin' OR (SELECT COUNT(*) FROM users WHERE role='admin')>1)`,
    role,token,recordId,version(body),user.id,user.version,role),[audit(db,user,'update','user',recordId,{role},{table:'users',token})],receipt,recordId,Number(body.version)+1,'SELECT 1 FROM users WHERE id=? AND mutation_key=?',[recordId,token])
    if (replay) return replayReceipt(db, receipt!, replay)
    return json({id:recordId,role,version:Number(body.version)+1})
  }
  throw new HttpError(404, 'Not found')
}

async function bspApi(request: Request, env: Env, user: User, path: string, receipt: ReceiptContext | null = null): Promise<Response> {
  const db = env.DB
  const method = request.method
  const route = path.slice('/api/v1/bsp'.length)
  if (route === '/admin/system-health' && method === 'GET') {
    requireRole(user, 'admin')
    return json(await getSystemHealthReport(env))
  }
  if (route === '/admin/vaults' || route.startsWith('/admin/vaults/')) {
    requireRole(user, 'admin')
    try { return await vaultApi(request, db, env.VAULT_ENCRYPTION_KEY, user, route) }
    catch (error) {
      if (error instanceof VaultError || error instanceof ReceiptError) throw error
      if (error instanceof Error && error.message.includes('NOT NULL constraint failed: audit_events.details')) throw new HttpError(403, 'Identity changed; refresh and try again')
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed: vault')) throw new HttpError(409, 'A vault or secret with this name already exists')
      // Never log provider, request or database errors from secret handling.
      throw new HttpError(500, 'Vault operation failed')
    }
  }
  if (route === '/admin/audit-log' && method === 'GET') {
    requireRole(user, 'admin')
    return auditPage(db, request)
  }
  const aliasRows = await db.prepare('SELECT alias, entity_type, entity_id FROM entity_aliases').all<{alias:number;entity_type:string;entity_id:string}>()
  const aliases = aliasRows.results
  const refreshAliases = async () => {
    const current = await db.prepare('SELECT alias, entity_type, entity_id FROM entity_aliases').all<{alias:number;entity_type:string;entity_id:string}>()
    for (const row of current.results) {
      if (!aliases.some(existing => existing.alias === row.alias)) aliases.push(row)
    }
  }
  const numberId = (type: string, uuid: unknown): number => {
    const entry = aliases.find(row => row.entity_type === type && row.entity_id === uuid)
    if (!entry) throw new Error(`Missing ${type} alias`)
    return entry.alias
  }
  const uuidId = (type: string, value: unknown): string => {
    const entry = aliases.find(row => row.entity_type === type && row.alias === Number(value))
    if (!entry) throw new HttpError(404, `Unknown ${type}`)
    return entry.entity_id
  }
  const componentUuids = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.length > 100) return bad('Invalid monitorIds')
    return [...new Set(value.map(item => uuidId('component', item)))]
  }
  const incidents = async (admin: boolean) => {
    const records = await listIncidents(db, admin)
    await refreshAliases()
    return records.map(record => ({
    ...record,
    id: numberId('incident', record.id),
    startedAt: record.createdAt,
    status: record.status,
    autoMonitorId: null,
    monitorIds: (record.componentIds as string[]).map(value => numberId('component', value)),
    monitorNames: Object.fromEntries((record.componentIds as string[]).map(value => [numberId('component', value), (record.componentNames as Record<string, string>)[value]])),
    updates: (record.updates as Json[]).map(update => ({
      ...update,
      id: numberId('update', update.id),
      incidentId: numberId('incident', record.id),
    })),
    }))
  }
  const maintenance = async (admin: boolean) => {
    const records = await listMaintenance(db, admin)
    await refreshAliases()
    return records.map(record => ({
    ...record,
    id: numberId('maintenance', record.id),
    state: record.state,
    monitorIds: (record.componentIds as string[]).map(value => numberId('component', value)),
    monitorNames: Object.fromEntries((record.componentIds as string[]).map(value => [numberId('component', value), (record.componentNames as Record<string, string>)[value]])),
    recurrence: 'none',
    recurrenceDays: [],
    recurrenceUntil: null,
    timezone: 'UTC',
    occurrence: { startsAt: record.startsAt, endsAt: record.endsAt },
    }))
  }
  const monitors = async (admin = false) => {
    const [activeIncidents, windows] = await Promise.all([listIncidents(db, false), listMaintenance(db, false)])
    const components = await listComponents(db, activeIncidents, windows, env)
    await refreshAliases()
    const endpoints = admin ? parseEndpoints(env.ENDPOINTS) : new Map()
    const now = Date.now()
    return Promise.all(components.map(async component => {
      const check = admin && component.source !== 'gatus' ? await stmt(db, 'SELECT endpoint_id, interval_minutes FROM http_checks WHERE component_id=?', component.id)
        .first<{endpoint_id:string;interval_minutes:number}>() : null
      const samples = admin && check ? (await checkResults(String(component.id), now - 24 * 3600000)).results : []
      const passed = samples.filter(sample => sample.status === 'up').length
      const responseTrend = Array.from({ length: 24 }, (_, index) => {
        const start = now - (24 - index) * 3600000
        const bucket = samples.filter(sample => sample.completed_at >= start && sample.completed_at < start + 3600000)
        return bucket.length ? bucket.reduce((sum, sample) => sum + sample.latency_ms, 0) / bucket.length : null
      })
      return {
        id: numberId('component', component.id),
        uuid: component.id,
        name: component.name,
        key: component.id,
        type: component.source === 'gatus' ? 'gatus' : 'https',
        ...(component.source === 'gatus' ? { source: 'gatus' } : {}),
        currentStatus: component.status === 'operational' ? 'up' : component.status === 'unknown' ? 'pending' : component.status,
        lastCheckedAt: component.lastCheckedAt,
        version: component.version,
        manualStatus: component.manualStatus,
        position: component.position,
        intervalSecs: check ? check.interval_minutes * 60 : null,
        config: { url: check ? endpoints.get(check.endpoint_id)?.name ?? '' : '' },
        tags: component.tags,
        group: component.source === 'gatus' ? component.group : null,
        activity: { maintenance: component.underMaintenance, windows: [], incident: null },
        health: {
          uptime24h: samples.length ? passed * 100 / samples.length : null,
          avgResponseMs: samples.length ? samples.reduce((sum, sample) => sum + sample.latency_ms, 0) / samples.length : null,
          responseTrend,
          failureRunSince: null,
          latencyRatio: null,
        },
      }
    }))
  }
  const checkResults = async (component: string, start: number) => {
    const check = await stmt(db, `SELECT c.endpoint_id, c.enabled, r.fingerprint FROM http_checks c
      LEFT JOIN endpoint_registry r ON r.endpoint_id = c.endpoint_id WHERE c.component_id = ?`, component)
      .first<{endpoint_id:string;enabled:number;fingerprint:string | null}>()
    const configured = check ? parseEndpoints(env.ENDPOINTS).get(check.endpoint_id) : undefined
    const matches = check?.enabled && check.fingerprint && configured && await endpointFingerprint(configured) === check.fingerprint
    return matches ? await stmt(db, `SELECT r.completed_at, COALESCE(r.effective_status, r.status) AS status, r.http_status, r.latency_ms FROM http_check_results r
      JOIN http_checks c ON c.id = r.check_id AND c.config_version = r.config_version
      JOIN endpoint_registry registry ON registry.endpoint_id = c.endpoint_id
      WHERE c.component_id = ? AND c.enabled = 1 AND registry.fingerprint = ? AND r.completed_at >= ? ORDER BY r.completed_at`, component, check!.fingerprint, start).all<{completed_at:number;status:string;http_status:number | null;latency_ms:number}>() : { results: [] }
  }
  if (route === '/admin/monitors/test' && method === 'POST') {
    requireRole(user, 'admin')
    const body = await parseBody(request)
    const endpointId = string(body.endpointId, 'endpointId', 100)
    if (!approvedEndpoints(env).some(endpoint => endpoint.id === endpointId)) return bad('Unknown approved endpoint')
    if (!Number.isInteger(body.expectedStatus) || Number(body.expectedStatus) < 100 || Number(body.expectedStatus) > 599) return bad('Invalid expectedStatus')
    serializeAdvancedConfig(body.advancedConfig, endpointId, Number(body.expectedStatus))
    if (!env.PROBE) throw new HttpError(503, 'Monitor testing is unavailable')
    try { return await requestProbeTest(env.PROBE, { endpointId, expectedStatus: body.expectedStatus, advancedConfig: body.advancedConfig }, request.signal) }
    catch (error) { if (error instanceof ProbeTestTimeout) throw new HttpError(504, 'Monitor test timed out'); throw error }
  }
  if ((route === '/admin/monitors' && method === 'POST') || (/^\/admin\/monitors\/[^/]+$/.test(route) && method === 'PATCH')) {
    requireRole(user, 'operator')
    if (!receipt) return bad('Idempotency-Key is required')
    const body = receipt.body
    const name = string(body.name, 'name', 200)
    const manualStatus = choice(body.manualStatus ?? 'operational', 'manualStatus', healthStatuses)
    const position = body.position === undefined ? 0 : timestamp(body.position, 'position')
    const creating = method === 'POST'
    const tags = body.tags === undefined ? (creating ? '[]' : null) : serializeMonitorTags(body.tags)
    const componentId = creating ? id() : uuidId('component', route.split('/').at(-1))
    if (!creating && await stmt(db, 'SELECT component_id FROM gatus_sources WHERE component_id=?', componentId).first()) throw new HttpError(403, 'Gatus-managed component is read-only')
    const componentVersion = creating ? 0 : version(body)
    const token = id()
    const check = body.check
    type StoredCheck = { id: string; endpoint_id: string; enabled: number; interval_minutes: number; expected_status: number; config_version: number; advanced_config: string | null }
    let current: StoredCheck | null = null
    let checkData: { id: string; endpointId: string; enabled: boolean; intervalMinutes: number; expectedStatus: number; advancedConfig: string | null; changed: boolean } | null = null
    if (check !== undefined) {
      requireRole(user, 'admin')
      if (!check || typeof check !== 'object' || Array.isArray(check)) return bad('Invalid check')
      const input = check as Json
      const endpointId = string(input.endpointId, 'endpointId', 100)
      if (!approvedEndpoints(env).some(endpoint => endpoint.id === endpointId)) return bad('Unknown approved endpoint')
      if (typeof input.enabled !== 'boolean' || (input.intervalMinutes !== 1 && input.intervalMinutes !== 5)) return bad('Invalid check settings')
      if (!Number.isInteger(input.expectedStatus) || Number(input.expectedStatus) < 100 || Number(input.expectedStatus) > 599) return bad('Invalid expectedStatus')
      const advanced = input.advancedConfig ?? null
      const serialized = serializeAdvancedConfig(advanced, endpointId, Number(input.expectedStatus))
      current = creating ? null : await stmt(db, 'SELECT * FROM http_checks WHERE component_id=?', componentId).first<StoredCheck>()
      if (current && (input.id !== current.id || input.version !== current.config_version)) throw new HttpError(409, 'This check changed. Reload and try again.')
      if (!current && (input.id !== undefined || input.version !== undefined)) throw new HttpError(409, 'This check changed. Reload and try again.')
      const changed = !current || current.endpoint_id !== endpointId || Boolean(current.enabled) !== input.enabled || current.interval_minutes !== input.intervalMinutes || current.expected_status !== input.expectedStatus || current.advanced_config !== serialized
      checkData = { id: current?.id ?? id(), endpointId, enabled: input.enabled, intervalMinutes: Number(input.intervalMinutes), expectedStatus: Number(input.expectedStatus), advancedConfig: serialized, changed }
    }
    const checkGuard = checkData ? current ? ' AND EXISTS (SELECT 1 FROM http_checks WHERE id=? AND config_version=?)' : ' AND NOT EXISTS (SELECT 1 FROM http_checks WHERE component_id=?)' : ''
    const guardValues = checkData ? current ? [current.id, current.config_version] : [componentId] : []
    const operations: D1PreparedStatement[] = [
      db.prepare('DELETE FROM mutation_receipts WHERE rowid IN (SELECT rowid FROM mutation_receipts WHERE expires_at<=? LIMIT 100)').bind(Date.now()),
      receiptClaim(db, receipt, token),
    ]
    if (creating) operations.push(stmt(db, 'INSERT INTO components (id,name,position,manual_status,updated_at,mutation_key,tags) VALUES (?,?,?,?,?,?,?)', componentId, name, position, manualStatus, Date.now(), token, tags))
    else operations.push(stmt(db, `UPDATE components SET name=?,manual_status=?,position=?,updated_at=?,version=version+1,mutation_key=?,tags=COALESCE(?,tags) WHERE id=? AND version=? AND NOT EXISTS (SELECT 1 FROM gatus_sources WHERE component_id=components.id)${checkGuard}`, name, manualStatus, position, Date.now(), token, tags, componentId, componentVersion, ...guardValues))
    if (checkData && checkData.changed) {
      if (!current) operations.push(stmt(db, `INSERT INTO http_checks (id,component_id,endpoint_id,enabled,interval_minutes,expected_status,advanced_config) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM components WHERE id=? AND mutation_key=?)`, checkData.id, componentId, checkData.endpointId, checkData.enabled ? 1 : 0, checkData.intervalMinutes, checkData.expectedStatus, checkData.advancedConfig, componentId, token))
      else operations.push(stmt(db, `UPDATE http_checks SET endpoint_id=?,enabled=?,interval_minutes=?,expected_status=?,advanced_config=?, config_version=config_version + CASE WHEN advanced_config IS ? THEN 1 ELSE 0 END,last_scheduled_at=NULL,last_result_at=NULL,last_status=NULL,mutation_key=? WHERE id=? AND config_version=? AND EXISTS (SELECT 1 FROM components WHERE id=? AND mutation_key=?)`, checkData.endpointId, checkData.enabled ? 1 : 0, checkData.intervalMinutes, checkData.expectedStatus, checkData.advancedConfig, checkData.advancedConfig, token, current.id, current.config_version, componentId, token))
      operations.push(audit(db, user, current ? 'update' : 'create', 'check', checkData.id, { componentId, enabled: checkData.enabled, intervalMinutes: checkData.intervalMinutes, expectedStatus: checkData.expectedStatus }, { table: 'components', id: componentId, token }))
    }
    operations.push(audit(db, user, creating ? 'create' : 'update', 'component', componentId, { name, status: manualStatus, position }, { table: 'components', token }))
    operations.push(receiptFinish(db, receipt, token, creating ? 201 : 200, componentId, componentVersion + 1, 'SELECT 1 FROM components WHERE id=? AND mutation_key=?', [componentId, token], 'component'))
    try { await db.batch(operations) } catch (error) {
      const replay = await findReceipt(db, receipt)
      if (replay) return json({ id: replay.result_alias, version: replay.result_version }, replay.status)
      if (error instanceof Error && error.message.includes('NOT NULL constraint failed: mutation_receipts.status')) throw new HttpError(409, 'This record changed. Reload and try again.')
      throw error
    }
    const saved = await findReceipt(db, receipt)
    if (!saved) throw new Error('Missing mutation receipt')
    return json({ id: saved.result_alias, version: saved.result_version }, saved.status)
  }
  if (route === '/auth/me' && method === 'GET') return json({ id: user.id, email: user.email, role: user.role, version: user.version, serverTime: Date.now() })
  if (route === '/capabilities' && method === 'GET') {
    const vaultAvailable = await vaultKeyReady(db, env.VAULT_ENCRYPTION_KEY)
    return json({ supportedRoutes: ['/admin/', '/admin/monitors', '/admin/incidents', '/admin/maintenance', '/admin/users', '/admin/audit-log', '/admin/system-health', ...(env.BACKUPS && env.BACKUPS_READY === 'true' ? ['/admin/backups'] : []), ...(vaultAvailable ? ['/admin/vault'] : [])], vault: vaultAvailable, subscriptions: false, notifications: false, dependencies: false, templates: false, recurringMaintenance: false, retentionDays: 14, monitorModal: env.MONITOR_MODAL === 'upstream' })
  }
  if (method === 'GET' && route === '/public/locales') return json([])
  if (method === 'GET' && route.startsWith('/public/locales/')) return json({ translations: {} })
  if (method === 'GET' && route === '/public/access') return json({ private: true, signedIn: true, email: user.email, role: user.role, passwordChangeRequired: false, branding: null })
  if (method === 'GET' && route === '/public/status') {
    const [items, incidentList, windows] = await Promise.all([monitors(), incidents(false), maintenance(false)])
    return json({ branding: null, monitors: items, activeIncidents: incidentList.filter(item => item.status !== 'resolved'), activeMaintenanceWindows: windows.filter(item => item.state === 'active'), monitorDependencies: [] })
  }
  if (method === 'GET' && route === '/public/layout') {
    const items = await monitors()
    const children: Json[] = []
    const groups = new Map<string, Json>()
    for (const item of items) {
      const node = { id: `component-${item.id}`, type: 'monitor', monitorId: item.id, showUptimeBar: item.source !== 'gatus' }
      if (item.source !== 'gatus' || typeof item.group !== 'string' || !item.group) { children.push(node); continue }
      let group = groups.get(item.group)
      if (!group) {
        group = { id: `gatus-group-${item.id}`, type: 'group', label: item.group, collapsible: false, children: [] }
        groups.set(item.group, group)
        children.push(group)
      }
      ;(group.children as Json[]).push(node)
    }
    children.push({ id: 'incidents', type: 'incidents', filter: 'all', limit: 20 }, { id: 'maintenance', type: 'maintenance', filter: 'all', limit: 200 })
    return json({ branding: null, tree: { id: 'page', type: 'page', children } })
  }
  if (method === 'GET' && route === '/public/incidents') return json(await incidents(false))
  if (method === 'GET' && route === '/public/maintenances') return json(await maintenance(false))
  const uptime = /^\/public\/monitor\/(\d+)\/uptime$/.exec(route)
  if (method === 'GET' && uptime) {
    const component = uuidId('component', uptime[1])
    const params = new URL(request.url).searchParams
    const days = Math.min(14, Math.max(1, Number(params.get('days')) || 14))
    const now = Date.now()
    const start = Math.floor(now / 86400000) * 86400000 - (days - 1) * 86400000
    const results = await checkResults(component, start)
    let total = 0
    let up = 0
    const daily = Array.from({ length: days }, (_, index) => {
      const from = start + index * 86400000
      const samples = results.results.filter(result => result.completed_at >= from && result.completed_at < from + 86400000)
      const passed = samples.filter(result => result.status === 'up').length
      total += samples.length
      up += passed
      return { date: new Date(from).toISOString().slice(0, 10), status: !samples.length ? 'no-data' : samples.some(sample => sample.status === 'down') ? 'down' : passed === samples.length ? 'up' : 'degraded', uptimePct: samples.length ? 100 * passed / samples.length : 0, checksTotal: samples.length, checksUp: passed }
    })
    return json({ monitorId: Number(uptime[1]), days: daily, overallUptimePct: total ? 100 * up / total : null })
  }
  if (!route.startsWith('/admin/')) throw new HttpError(404, 'Not found')
  const parts = route.slice('/admin/'.length).split('/')
  const [resource, recordId, action] = parts
  if (parts.length > 3 || parts.some(part => !part)) throw new HttpError(404, 'Not found')
  requireRole(user, ['checks', 'endpoints', 'users', 'audit'].includes(resource!) ? 'admin' : 'operator')
  if (method === 'GET') {
    if (resource === 'monitors' && recordId && action === 'history' && parts.length === 3) {
      const component = uuidId('component', recordId)
      if (await stmt(db, 'SELECT component_id FROM gatus_sources WHERE component_id=?', component).first()) return json({ source: 'gatus', historyAvailable: false, retentionDays: 0, results: [] })
      const results = await checkResults(component, Date.now() - 14 * 86400000)
      return json({ retentionDays: 14, results: results.results.map(result => ({ completedAt: result.completed_at, status: result.status, httpStatus: result.http_status, latencyMs: result.latency_ms })) })
    }
    if (resource === 'monitors' && !recordId) return json(await monitors(true))
    if (resource === 'incidents' && !recordId) return json(await incidents(true))
    if (resource === 'maintenance' && !recordId) return json(await maintenance(true))
  }
  if (resource === 'incidents' && method === 'POST' && !recordId) {
    const body = await parseBody(request)
    const incidentId = id()
    const title = string(body.title, 'title', 200)
    const impact = choice(body.impact ?? 'minor', 'impact', impacts)
    const status = choice(body.status ?? 'investigating', 'status', incidentStatuses.slice(0, 3))
    const message = string(body.body, 'body')
    if (typeof body.draft !== 'boolean') bad('Invalid draft')
    const ids = componentUuids(body.monitorIds ?? [])
    await validateComponents(db, ids)
    const now = Date.now()
    const replay = await commitMutation(db, [
      stmt(db, 'INSERT INTO incidents (id,title,status,impact,draft,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', incidentId,title,status,impact,body.draft ? 1 : 0,now,now),
      stmt(db, 'INSERT INTO incident_updates (id,incident_id,body,status,posted_at) VALUES (?,?,?,?,?)', id(),incidentId,message,status,now),
      ...links(db,'incident_components','incident_id',incidentId,ids),
      audit(db,user,'create','incident',incidentId,{title,impact}),
      ...(!body.draft ? [audit(db,user,'publish','incident',incidentId,{title,status,impact})] : []),
    ], receipt, incidentId, 1, 201, "SELECT 1 FROM incidents i JOIN entity_aliases a ON a.entity_id=i.id AND a.entity_type='incident' WHERE i.id=?", [incidentId], 'incident')
    if (replay) return replayReceipt(db, receipt!, replay)
    const alias = await stmt(db, 'SELECT alias FROM entity_aliases WHERE entity_type=? AND entity_id=?', 'incident', incidentId).first<{alias:number}>()
    return json({ id: alias?.alias, version: 1 }, 201)
  }
  if (resource === 'monitors' && recordId && method !== 'GET') {
    const component = uuidId('component', recordId)
    if (await stmt(db, 'SELECT component_id FROM gatus_sources WHERE component_id=?', component).first()) throw new HttpError(403, 'Gatus-managed component is read-only')
  }
  const supported = ['incidents', 'maintenance', 'components', 'checks', 'endpoints', 'users', 'audit']
  if (!resource || !supported.includes(resource)) throw new HttpError(404, 'Not found')
  let targetId = recordId
  if (recordId && (resource === 'incidents' || resource === 'maintenance')) targetId = uuidId(resource === 'incidents' ? 'incident' : 'maintenance', recordId)
  let payload: Json | undefined
  if (!['GET', 'HEAD'].includes(method)) {
    payload = await parseBody(request)
    if (payload.monitorIds !== undefined) {
      payload.componentIds = componentUuids(payload.monitorIds)
      delete payload.monitorIds
    }
    if (resource === 'maintenance' && payload.description === null) payload.description = ''
  }
  const target = ['/api/v1/admin', resource, targetId, action].filter(Boolean).join('/')
  const forwarded = new Request(request.url, { method, headers: request.headers, ...(payload ? { body: JSON.stringify(payload) } : {}) })
  return api(forwarded, env, user, target, receipt)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let receipt: ReceiptContext | null = null
    try {
      const url = new URL(request.url)
      const user = await authenticate(request, env)
      if (!['GET','HEAD','OPTIONS'].includes(request.method) && request.headers.get('origin') !== url.origin) throw new HttpError(403,'Invalid request origin')
      if (url.pathname === '/api/v1/bsp/admin/backups' || /^\/api\/v1\/bsp\/admin\/backups\/[a-f0-9]{64}\/(verify|download)$/.test(url.pathname)) {
        requireRole(user, 'admin')
        if (!env.BACKUPS || env.BACKUPS_READY !== 'true') throw new HttpError(503, 'Backups are unavailable')
        const path = url.pathname.slice('/api/v1/bsp/admin'.length)
        const headers = new Headers()
        let backupId = ''
        if (request.method === 'POST' && path === '/backups') {
          const intent = await receiptContext(request, user)
          if (!intent || Object.keys(intent.body).length) return bad('An idempotent empty backup request is required')
          const bytes = new TextEncoder().encode(`${user.id}\n${intent.key}`)
          backupId = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('')
          headers.set('x-backup-id', backupId)
          headers.set('x-backup-created-at', intent.key.slice(0, 13))
        } else if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed')
        const result = await env.BACKUPS.fetch(new Request(`https://backup.internal${path}${request.method === 'GET' ? url.search : ''}`, { method: request.method, headers }))
        if (backupId && result.status === 202) {
          await stmt(env.DB, 'INSERT OR IGNORE INTO audit_events (id,actor_email,action,entity_type,entity_id,created_at,details) VALUES (?,?,?,?,?,?,?)', `backup-${backupId}`, user.email, 'create', 'backup', backupId, Date.now(), '{}').run()
        }
        return result
      }
      if (!['GET','HEAD','OPTIONS'].includes(request.method) && request.headers.has('Idempotency-Key')) {
        const normalized = url.pathname.replace(/^\/api\/v1\/bsp\//, '/api/v1/')
        const resource = /^\/api\/v1\/admin\/([^/]+)/.exec(normalized)?.[1]
        if (!resource || !['components','incidents','maintenance','checks','users','monitors'].includes(resource)) throw new HttpError(400, 'Idempotency is not available for this route')
        requireRole(user, ['checks','users'].includes(resource) ? 'admin' : 'operator')
        receipt = await receiptContext(request, user)
        if (receipt) {
          const existing = await findReceipt(env.DB, receipt)
          if (existing) return replayReceipt(env.DB, receipt, existing)
        }
      }
      try {
        if (url.pathname.startsWith('/api/v1/bsp/')) return await bspApi(request,env,user,url.pathname,receipt)
        if (url.pathname.startsWith('/api/')) return await api(request,env,user,url.pathname,receipt)
      } catch (error) {
        if (receipt) {
          const existing = await findReceipt(env.DB, receipt)
          if (existing) return replayReceipt(env.DB, receipt, existing)
        }
        throw error
      }
      if (url.pathname.startsWith('/admin')) requireRole(user,'operator')
      const asset = await env.ASSETS.fetch(request)
      if (asset.status !== 404 || !request.headers.get('accept')?.includes('text/html')) return asset
      const fallback = new URL('/',url)
      return env.ASSETS.fetch(new Request(fallback,request))
    } catch (error) {
      if (error instanceof VaultError) return json({error:error.message},error.status)
      if (error instanceof ReceiptError) return json({error:error.message,...(error.code ? {code:error.code} : {})},error.status)
      if (error instanceof HttpError) return json({error:error.message},error.status)
      if (error instanceof Error && error.message.includes('Inactive Gatus source cannot be associated')) return json({error:'Inactive Gatus source cannot be associated'},409)
      if (error instanceof Error && error.message.includes('Gatus-managed component is read-only')) return json({error:'Gatus-managed component is read-only'},403)
      if (error instanceof Error && (error.message.includes('maximum enabled checks reached') || error.message.includes('UNIQUE constraint failed: http_checks.component_id'))) return json({error:'Check limit reached or component already has a check'},409)
      console.error(JSON.stringify({event:'request_error',message:error instanceof Error ? error.message : 'Unknown error'}))
      return json({error:'Internal server error'},500)
    }
  },
}
