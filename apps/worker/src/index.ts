import { createRemoteJWKSet, jwtVerify } from 'jose'
import { endpointFingerprint, parseEndpoints } from './endpoint-config'

interface Env {
  DB: D1Database
  ASSETS: Fetcher
  ACCESS_TEAM_DOMAIN: string
  ACCESS_AUD: string
  ENDPOINTS: string
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
  const raw = await request.text()
  if (raw.length > 64_000) throw new HttpError(413, 'Request body too large')
  let body: unknown
  try { body = JSON.parse(raw) } catch { return bad('Invalid JSON') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('Expected a JSON object')
  return body as Json
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
function audit(db: D1Database, user: User, action: string, entityType: string, entityId: string, details: Json, guard?: { table: string; token: string }): D1PreparedStatement {
  const values = [id(), user.email, action, entityType, entityId, Date.now(), JSON.stringify(details)]
  if (!guard) return stmt(db, 'INSERT INTO audit_events (id, actor_email, action, entity_type, entity_id, created_at, details) VALUES (?, ?, ?, ?, ?, ?, ?)', ...values)
  return stmt(db, `INSERT INTO audit_events (id, actor_email, action, entity_type, entity_id, created_at, details) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM ${guard.table} WHERE id=? AND mutation_key=?)`, ...values, entityId, guard.token)
}
async function mutate(db: D1Database, first: D1PreparedStatement, rest: D1PreparedStatement[]) {
  const result = await db.batch([first, ...rest])
  if (!result[0].meta.changes) throw new HttpError(409, 'This record changed. Reload and try again.')
}
async function validateComponents(db: D1Database, ids: string[]) {
  if (!ids.length) return
  const result = await stmt(db, `SELECT COUNT(*) AS count FROM components WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids).first<{ count: number }>()
  if (result?.count !== ids.length) bad('Unknown component')
}
function links(db: D1Database, table: 'incident_components' | 'maintenance_components', key: string, owner: string, ids: string[], guardTable?: string, token?: string): D1PreparedStatement[] {
  return ids.map(component => guardTable
    ? stmt(db, `INSERT INTO ${table} (${key}, component_id) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM ${guardTable} WHERE id=? AND mutation_key=?)`, owner, component, owner, token)
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
    db.prepare(`WITH selected AS (${selected}) SELECT ic.incident_id, ic.component_id FROM incident_components ic JOIN selected i ON i.id=ic.incident_id`).all<{incident_id:string;component_id:string}>(),
    db.prepare(`WITH selected AS (${selected}) SELECT u.incident_id, u.id, u.body, u.status, u.posted_at AS postedAt FROM incident_updates u JOIN selected i ON i.id=u.incident_id ORDER BY u.posted_at, u.rowid`).all<{incident_id:string}>(),
  ])
  return records.results.map(row => ({ id:row.id,title:row.title,status:row.status,impact:row.impact,draft:Boolean(row.draft),createdAt:row.created_at,updatedAt:row.updated_at,resolvedAt:row.resolved_at,version:row.version,componentIds:related.results.filter(r=>r.incident_id===row.id).map(r=>r.component_id),updates:updates.results.filter(r=>r.incident_id===row.id) }))
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
    stmt(db, `WITH selected AS (${selected}) SELECT mc.maintenance_id, mc.component_id FROM maintenance_components mc JOIN selected m ON m.id=mc.maintenance_id`, now, now).all<{maintenance_id:string;component_id:string}>(),
  ])
  return rows.results.map(row => ({ id:row.id,name:row.name,description:row.description,startsAt:row.starts_at,endsAt:row.ends_at,componentIds:related.results.filter(r=>r.maintenance_id===row.id).map(r=>r.component_id),state:row.cancelled ? 'cancelled' : Number(row.starts_at)>now ? 'upcoming' : Number(row.ends_at)>now ? 'active' : 'past',version:row.version }))
}
async function listComponents(db: D1Database, incidents: Json[], maintenance: Json[], endpointConfig: string): Promise<Json[]> {
  const rows = await db.prepare('SELECT c.*, h.endpoint_id, h.enabled AS check_enabled, h.last_status, h.last_result_at, h.interval_minutes, r.fingerprint AS registered_fingerprint FROM components c LEFT JOIN http_checks h ON h.component_id=c.id LEFT JOIN endpoint_registry r ON r.endpoint_id=h.endpoint_id ORDER BY position, name').all<Row>()
  const configured = parseEndpoints(endpointConfig)
  const fingerprints = new Map(await Promise.all([...configured].map(async ([id, endpoint]) => [id, await endpointFingerprint(endpoint)] as const)))
  const severity: Record<string, number> = { operational: 0, unknown: 1, degraded: 2, down: 3 }
  return rows.results.map(row => {
    let state = String(row.manual_status)
    let checkStatus: string | null = null
    const matches = Boolean(row.registered_fingerprint) && fingerprints.get(String(row.endpoint_id)) === row.registered_fingerprint
    if (row.check_enabled) {
      const stale = !matches || !row.last_result_at || Date.now() - Number(row.last_result_at) > Number(row.interval_minutes) * 180_000
      checkStatus = stale ? 'unknown' : row.last_status === 'up' ? 'operational' : 'down'
      if (severity[checkStatus] > severity[state]) state = checkStatus
    }
    for (const incident of incidents) {
      if (incident.status === 'resolved' || ((incident.componentIds as string[]).length > 0 && !(incident.componentIds as string[]).includes(String(row.id)))) continue
      const impact = incident.impact === 'minor' ? 'degraded' : 'down'
      if (severity[impact] > severity[state]) state = impact
    }
    const underMaintenance = maintenance.some(window => window.state === 'active' && (!(window.componentIds as string[]).length || (window.componentIds as string[]).includes(String(row.id))))
    return { id: row.id, name: row.name, position: row.position, manualStatus: row.manual_status, status: state, checkStatus, lastCheckedAt: matches ? row.last_result_at ?? null : null, underMaintenance, version: row.version }
  })
}

type Endpoint = { id: string; name?: string }
function approvedEndpoints(env: Env): Endpoint[] {
  try {
    return [...parseEndpoints(env.ENDPOINTS).values()]
  } catch { throw new Error('Invalid ENDPOINTS configuration') }
}

async function api(request: Request, env: Env, user: User, path: string): Promise<Response> {
  const method = request.method
  const db = env.DB
  if (path === '/api/v1/auth/me' && method === 'GET') return json({ id: user.id, email: user.email, role: user.role, version: user.version })
  if (path.startsWith('/api/v1/public/') && method === 'GET') {
    if (path === '/api/v1/public/incidents') return json(await listIncidents(db, false))
    if (path === '/api/v1/public/maintenances') return json(await listMaintenance(db, false))
    if (path === '/api/v1/public/status') {
      const [incidents, maintenance] = await Promise.all([listIncidents(db, false), listMaintenance(db, false)])
      return json({ components: await listComponents(db, incidents, maintenance, env.ENDPOINTS), activeIncidents: incidents.filter(i => i.status !== 'resolved'), activeMaintenanceWindows: maintenance.filter(m => m.state === 'active') })
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
    if (resource === 'components' && !recordId) return json(await listComponents(db, await listIncidents(db, false), await listMaintenance(db, false), env.ENDPOINTS))
    if (resource === 'users' && !recordId) return json((await db.prepare('SELECT id, email, role, version FROM users ORDER BY email').all()).results)
    if (resource === 'audit' && !recordId) return json((await db.prepare('SELECT id, actor_email AS actorEmail, action, entity_type AS entityType, entity_id AS entityId, created_at AS createdAt, details FROM audit_events ORDER BY created_at DESC LIMIT 200').all()).results)
    if (resource === 'checks' && !recordId) return json((await db.prepare('SELECT id, component_id AS componentId, endpoint_id AS endpointId, enabled, interval_minutes AS intervalMinutes, expected_status AS expectedStatus, config_version AS version FROM http_checks').all()).results)
    if (resource === 'endpoints' && !recordId) return json(approvedEndpoints(env).map(endpoint => ({ id: endpoint.id, name: endpoint.name ?? endpoint.id })))
    throw new HttpError(404, 'Not found')
  }
  const body = await parseBody(request)
  const now = Date.now()
  if (resource === 'components') {
    if (method === 'POST' && !recordId) {
      const componentId = id()
      const name = string(body.name, 'name', 200)
      const status = choice(body.manualStatus ?? 'operational', 'manualStatus', healthStatuses)
      const position = body.position === undefined ? 0 : timestamp(body.position, 'position')
      await db.batch([stmt(db, 'INSERT INTO components (id,name,position,manual_status,updated_at) VALUES (?,?,?,?,?)', componentId, name, position, status, now), audit(db,user,'create','component',componentId,{name,status})])
      return json({ id: componentId, name, position, manualStatus: status, version: 1 }, 201)
    }
    if (method === 'PATCH' && recordId && !action) {
      const current = await stmt(db, 'SELECT * FROM components WHERE id=?', recordId).first<Row>()
      if (!current) throw new HttpError(404, 'Component not found')
      const name = body.name === undefined ? current.name : string(body.name, 'name', 200)
      const status = body.manualStatus === undefined ? current.manual_status : choice(body.manualStatus, 'manualStatus', healthStatuses)
      const position = body.position === undefined ? current.position : timestamp(body.position, 'position')
      const token = id()
      await mutate(db, stmt(db, 'UPDATE components SET name=?, manual_status=?, position=?, updated_at=?, version=version+1, mutation_key=? WHERE id=? AND version=?', name,status,position,now,token,recordId,version(body)), [audit(db,user,'update','component',recordId,{name,status,position},{table:'components',token})])
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
      await db.batch([
        stmt(db,'INSERT INTO incidents (id,title,status,impact,draft,created_at,updated_at) VALUES (?,?,?,?,1,?,?)',incidentId,title,'investigating',impact,now,now),
        stmt(db,'INSERT INTO incident_updates (id,incident_id,body,status,posted_at) VALUES (?,?,?,?,?)',id(),incidentId,message,'investigating',now),
        ...links(db,'incident_components','incident_id',incidentId,ids),audit(db,user,'create','incident',incidentId,{title,impact})
      ])
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
        extra.push(stmt(db,'DELETE FROM incident_components WHERE incident_id=? AND EXISTS (SELECT 1 FROM incidents WHERE id=? AND mutation_key=?)',recordId,recordId,token))
        extra.push(...links(db,'incident_components','incident_id',recordId,ids,'incidents',token))
      }
      extra.push(audit(db,user,event,'incident',recordId,{title,status,impact},{table:'incidents',token}))
      await mutate(db,stmt(db,'UPDATE incidents SET title=?,impact=?,status=?,draft=?,resolved_at=?,updated_at=?,version=version+1,mutation_key=? WHERE id=? AND version=?',title,impact,status,draft,resolved,now,token,recordId,version(body)),extra)
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
      await db.batch([stmt(db,'INSERT INTO maintenance (id,name,description,starts_at,ends_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',maintenanceId,name,description,starts,ends,now,now),...links(db,'maintenance_components','maintenance_id',maintenanceId,ids),audit(db,user,'create','maintenance',maintenanceId,{name,startsAt:starts,endsAt:ends})])
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
        extra.push(stmt(db,'DELETE FROM maintenance_components WHERE maintenance_id=? AND EXISTS (SELECT 1 FROM maintenance WHERE id=? AND mutation_key=?)',recordId,recordId,token))
        extra.push(...links(db,'maintenance_components','maintenance_id',recordId,ids,'maintenance',token))
      }
      extra.push(audit(db,user,event,'maintenance',recordId,{name,startsAt:starts,endsAt:ends},{table:'maintenance',token}))
      await mutate(db,stmt(db,'UPDATE maintenance SET name=?,description=?,starts_at=?,ends_at=?,cancelled=?,updated_at=?,version=version+1,mutation_key=? WHERE id=? AND version=?',name,description,starts,ends,cancelled,now,token,recordId,version(body)),extra)
      return json({id:recordId,version:Number(body.version)+1})
    }
  }

  if (resource === 'checks' && (method === 'POST' && !recordId || method === 'PATCH' && recordId && !action)) {
    const componentId = string(body.componentId, 'componentId', 100)
    const endpointId = string(body.endpointId, 'endpointId', 100)
    if (!approvedEndpoints(env).some(endpoint => endpoint.id === endpointId)) bad('Unknown approved endpoint')
    await validateComponents(db, [componentId])
    if (typeof body.enabled !== 'boolean') bad('Invalid enabled')
    if (body.intervalMinutes !== 1 && body.intervalMinutes !== 5) bad('Invalid intervalMinutes')
    if (!Number.isInteger(body.expectedStatus) || Number(body.expectedStatus) < 100 || Number(body.expectedStatus) > 599) bad('Invalid expectedStatus')
    if (method === 'POST') {
      const checkId = id()
      await db.batch([stmt(db, 'INSERT INTO http_checks (id,component_id,endpoint_id,enabled,interval_minutes,expected_status,config_version) VALUES (?,?,?,?,?,?,1)',checkId,componentId,endpointId,body.enabled ? 1 : 0,body.intervalMinutes,body.expectedStatus),audit(db,user,'create','check',checkId,{componentId,endpointId})])
      return json({id:checkId,version:1},201)
    }
    const token = id()
    await mutate(db,stmt(db,'UPDATE http_checks SET component_id=?,endpoint_id=?,enabled=?,interval_minutes=?,expected_status=?,config_version=config_version+1,last_scheduled_at=NULL,last_result_at=NULL,last_status=NULL,mutation_key=? WHERE id=? AND config_version=?',componentId,endpointId,body.enabled ? 1 : 0,body.intervalMinutes,body.expectedStatus,token,recordId,version(body)),[audit(db,user,'update','check',recordId,{componentId,endpointId},{table:'http_checks',token})])
    return json({id:recordId,version:Number(body.version)+1})
  }

  if (resource === 'users' && method === 'PATCH' && recordId && !action) {
    const role = choice(body.role,'role',['viewer','operator','admin'])
    if (recordId === user.id && role !== 'admin') throw new HttpError(409,'An admin cannot remove their own admin role')
    const token = id()
    // Check the actor and the administrator count in the same transaction as
    // the update. Concurrent administrators must not demote each other and
    // leave the board without an administrator.
    await mutate(db,stmt(db,`UPDATE users SET role=?,version=version+1,mutation_key=?
      WHERE id=? AND version=?
      AND EXISTS (SELECT 1 FROM users actor WHERE actor.id=? AND actor.role='admin' AND actor.version=?)
      AND (?='admin' OR role<>'admin' OR (SELECT COUNT(*) FROM users WHERE role='admin')>1)`,
    role,token,recordId,version(body),user.id,user.version,role),[audit(db,user,'update','user',recordId,{role},{table:'users',token})])
    return json({id:recordId,role,version:Number(body.version)+1})
  }
  throw new HttpError(404, 'Not found')
}

async function bspApi(request: Request, env: Env, user: User, path: string): Promise<Response> {
  const db = env.DB
  const method = request.method
  const route = path.slice('/api/v1/bsp'.length)
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
    recurrence: 'none',
    recurrenceDays: [],
    recurrenceUntil: null,
    timezone: 'UTC',
    occurrence: { startsAt: record.startsAt, endsAt: record.endsAt },
    }))
  }
  const monitors = async (admin = false) => {
    const [activeIncidents, windows] = await Promise.all([listIncidents(db, false), listMaintenance(db, false)])
    const components = await listComponents(db, activeIncidents, windows, env.ENDPOINTS)
    await refreshAliases()
    const endpoints = admin ? parseEndpoints(env.ENDPOINTS) : new Map()
    const now = Date.now()
    return Promise.all(components.map(async component => {
      const check = admin ? await stmt(db, 'SELECT endpoint_id, interval_minutes FROM http_checks WHERE component_id=?', component.id)
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
        type: 'https',
        currentStatus: component.status === 'operational' ? 'up' : component.status === 'unknown' ? 'pending' : component.status,
        lastCheckedAt: component.lastCheckedAt,
        version: component.version,
        manualStatus: component.manualStatus,
        position: component.position,
        intervalSecs: check ? check.interval_minutes * 60 : null,
        config: { url: check ? endpoints.get(check.endpoint_id)?.name ?? '' : '' },
        tags: [],
        group: null,
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
    return matches ? await stmt(db, `SELECT r.completed_at, r.status, r.http_status, r.latency_ms FROM http_check_results r
      JOIN http_checks c ON c.id = r.check_id AND c.config_version = r.config_version
      JOIN endpoint_registry registry ON registry.endpoint_id = c.endpoint_id
      WHERE c.component_id = ? AND c.enabled = 1 AND registry.fingerprint = ? AND r.completed_at >= ? ORDER BY r.completed_at`, component, check!.fingerprint, start).all<{completed_at:number;status:string;http_status:number | null;latency_ms:number}>() : { results: [] }
  }
  if (route === '/auth/me' && method === 'GET') return json({ id: user.id, email: user.email, role: user.role, version: user.version })
  if (route === '/capabilities' && method === 'GET') return json({ supportedRoutes: ['/admin/', '/admin/monitors', '/admin/incidents', '/admin/maintenance', '/admin/users', '/admin/audit-log'], subscriptions: false, notifications: false, dependencies: false, templates: false, recurringMaintenance: false, retentionDays: 14 })
  if (method === 'GET' && route === '/public/locales') return json([])
  if (method === 'GET' && route.startsWith('/public/locales/')) return json({ translations: {} })
  if (method === 'GET' && route === '/public/access') return json({ private: true, signedIn: true, email: user.email, role: user.role, passwordChangeRequired: false, branding: null })
  if (method === 'GET' && route === '/public/status') {
    const [items, incidentList, windows] = await Promise.all([monitors(), incidents(false), maintenance(false)])
    return json({ branding: null, monitors: items, activeIncidents: incidentList.filter(item => item.status !== 'resolved'), activeMaintenanceWindows: windows.filter(item => item.state === 'active'), monitorDependencies: [] })
  }
  if (method === 'GET' && route === '/public/layout') {
    const items = await monitors()
    return json({ branding: null, tree: { id: 'page', type: 'page', children: [
      ...items.map(item => ({ id: `component-${item.id}`, type: 'monitor', monitorId: item.id, showUptimeBar: true })),
      { id: 'incidents', type: 'incidents', filter: 'all', limit: 20 },
      { id: 'maintenance', type: 'maintenance', filter: 'all', limit: 200 },
    ] } })
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
      return { date: new Date(from).toISOString().slice(0, 10), status: !samples.length ? 'no-data' : passed === samples.length ? 'up' : 'down', uptimePct: samples.length ? 100 * passed / samples.length : 0, checksTotal: samples.length, checksUp: passed }
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
    await db.batch([
      stmt(db, 'INSERT INTO incidents (id,title,status,impact,draft,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', incidentId,title,status,impact,body.draft ? 1 : 0,now,now),
      stmt(db, 'INSERT INTO incident_updates (id,incident_id,body,status,posted_at) VALUES (?,?,?,?,?)', id(),incidentId,message,status,now),
      ...links(db,'incident_components','incident_id',incidentId,ids),
      audit(db,user,'create','incident',incidentId,{title,impact}),
      ...(!body.draft ? [audit(db,user,'publish','incident',incidentId,{title,status,impact})] : []),
    ])
    const alias = await stmt(db, 'SELECT alias FROM entity_aliases WHERE entity_type=? AND entity_id=?', 'incident', incidentId).first<{alias:number}>()
    return json({ id: alias?.alias, version: 1 }, 201)
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
  return api(forwarded, env, user, target)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url)
      const user = await authenticate(request, env)
      if (!['GET','HEAD','OPTIONS'].includes(request.method) && request.headers.get('origin') !== url.origin) throw new HttpError(403,'Invalid request origin')
      if (url.pathname.startsWith('/api/v1/bsp/')) return await bspApi(request,env,user,url.pathname)
      if (url.pathname.startsWith('/api/')) return await api(request,env,user,url.pathname)
      if (url.pathname.startsWith('/admin')) requireRole(user,'operator')
      const asset = await env.ASSETS.fetch(request)
      if (asset.status !== 404 || !request.headers.get('accept')?.includes('text/html')) return asset
      const fallback = new URL('/',url)
      return env.ASSETS.fetch(new Request(fallback,request))
    } catch (error) {
      if (error instanceof HttpError) return json({error:error.message},error.status)
      if (error instanceof Error && (error.message.includes('maximum enabled checks reached') || error.message.includes('UNIQUE constraint failed: http_checks.component_id'))) return json({error:'Check limit reached or component already has a check'},409)
      console.error(JSON.stringify({event:'request_error',message:error instanceof Error ? error.message : 'Unknown error'}))
      return json({error:'Internal server error'},500)
    }
  },
}
