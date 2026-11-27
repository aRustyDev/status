import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import worker from '../src/index.ts'
import gatewayModule from '../../gateway/index.ts'
import { getSystemHealthReport } from '../src/system-health.ts'
import { vaultApi, vaultKeyReady } from '../src/vault.ts'
import probeWorker from '../../probe/src/index.ts'
import { endpointFingerprint } from '../src/endpoint-config.ts'
import { syncGatusCatalog } from '../src/gatus-catalog.ts'
import { gatusSourceId, type GatusCatalogEntry } from '../src/gatus.ts'

const gateway = 'default' in gatewayModule ? gatewayModule.default as typeof gatewayModule : gatewayModule

// This adapter executes actual SQLite statements, including atomic batches, to
// exercise the API independently of a running Cloudflare account.
class SQLiteStatement {
  private values: unknown[] = []
  constructor(private sql: string, private database: DatabaseSync) {}
  bind(...values: unknown[]) { this.values = values; return this }
  runSync() {
    const result = this.database.prepare(this.sql).run(...this.values as never[])
    return { success: true, meta: { changes: Number(result.changes) } }
  }
  async run() { return this.runSync() }
  async first<T = Record<string, unknown>>() { return (this.database.prepare(this.sql).get(...this.values as never[]) ?? null) as T | null }
  async all<T>() { return { results: this.database.prepare(this.sql).all(...this.values as never[]) as T[] } }
}
class SQLiteD1 {
  readonly db = new DatabaseSync(':memory:')
  prepare(sql: string) { return new SQLiteStatement(sql, this.db) }
  async batch(statements: SQLiteStatement[]) {
    this.db.exec('BEGIN')
    try {
      const result = []
      for (const statement of statements) result.push(statement.runSync())
      this.db.exec('COMMIT')
      return result
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
}

interface TestStatement {
  bind(...values: unknown[]): TestStatement
  run(): Promise<unknown>
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T>(): Promise<{ results: T[] }>
}
interface TestDatabase {
  prepare(sql: string): TestStatement
  batch(statements: TestStatement[]): Promise<unknown>
}
interface TestEntity {
  id: string
  name: string
  status: string
  checkStatus: string | null
  lastCheckedAt: number | null
  state: string
  body: string
  underMaintenance: boolean
  updates: TestEntity[]
}
type TestResponseBody = TestEntity[] & TestEntity & {
  components: TestEntity[]
  activeIncidents: TestEntity[]
  activeMaintenanceWindows: TestEntity[]
}
const sqlite = new SQLiteD1()
let db: TestDatabase = sqlite
let miniflare: Miniflare | undefined
const issuer = 'https://test.cloudflareaccess.com'
const audience = 'status-test'
const env: { DB: TestDatabase; ASSETS: { fetch: () => Promise<Response> }; ACCESS_TEAM_DOMAIN: string; ACCESS_AUD: string; ENDPOINTS: string; GATUS?: { fetch: (request: Request) => Promise<Response> }; GATUS_REQUIRED?: string; PROBE?: { fetch: (request: Request) => Promise<Response> }; BACKUPS?: { fetch: (request: Request) => Promise<Response> }; BACKUPS_READY?: string; VAULT_ENCRYPTION_KEY?: string; MONITOR_AUTH_READY?: string; MONITOR_REQUEST_READY?: string; CHANNELS_READY?: string; CHANNEL_ENDPOINTS?: string; ACTIONS_READY?: string; ACTION_ENDPOINTS?: string; EMAIL_READY?: string; EMAIL_FROM?: string; EMAIL_DESTINATIONS?: string; EMAIL?: { send: (message: unknown) => Promise<{messageId:string}> } } = { DB: db, ASSETS: { fetch: async () => new Response('asset') }, ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com', ACCESS_AUD: audience, ENDPOINTS: '[]' }
const originalFetch = globalThis.fetch
const keySets = new Map<string, object[]>()
const keyFetches = new Map<string, number>()
let sign: (subject: string, email: string, aud?: string, expires?: string) => Promise<string>
let adminToken: string, operatorToken: string, viewerToken: string

async function request(path: string, token?: string, method = 'GET', body?: unknown, origin = 'https://status.example', idempotencyKey?: string, idempotencyActor?: string) {
  const headers: Record<string, string> = {}
  if (token) headers['Cf-Access-Jwt-Assertion'] = token
  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey
    const subject = token === adminToken ? 'admin-id' : token === operatorToken ? 'operator-id' : token === viewerToken ? 'viewer-id' : ''
    const actor = subject ? await db.prepare('SELECT id FROM users WHERE subject=?').bind(subject).first<{id:string}>() : null
    if (idempotencyActor ?? actor?.id) headers['Idempotency-Actor'] = (idempotencyActor ?? actor!.id)
  }
  if (method !== 'GET') { headers.origin = origin; headers['content-type'] = 'application/json' }
  const response = await worker.fetch(new Request(`https://status.example${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env as never)
  return { response, body: await response.json() as TestResponseBody }
}

before(async () => {
  if (process.env['USE_WORKERS_D1']) {
    miniflare = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response()}}', d1Databases: ['DB'] }))
    db = await miniflare.getD1Database('DB') as unknown as TestDatabase
    env.DB = db
    for (const file of ['0001_board.sql', '0002_checks.sql', '0003_endpoint_registry.sql', '0004_aliases.sql', '0005_gatus_sources.sql', '0006_advanced_http.sql', '0007_idempotency.sql', '0008_monitor_tags.sql', '0008_vault.sql', '0009_monitor_auth.sql', '0009_channels.sql', '0009_actions.sql', '0010_monitor_alert_links.sql', '0010_notification_transition_state.sql', '0011_email_channels.sql', '0012_notification_delivery_state.sql', '0013_notification_unlink_cancel.sql', '0014_monitor_alert_channel_limit.sql', '0015_monitor_dependencies.sql', '0015_monitor_request.sql', '0016_dependency_observations.sql', '0017_monitor_action_links.sql', '0018_delivery_history.sql', '0019_subscribers.sql', '0020_subscriber_deliveries.sql', '0021_preview_subscribers.sql', '0022_preview_audit_scope.sql', '0023_preview_audit_events.sql']) {
      const sql = readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8').replace(/^\s*--[^\n]*$/gm, '')
      const parts = sql.split(/(?=CREATE TRIGGER |DROP TRIGGER )/)
      const statements = parts.shift()!.split(';').map(value => value.trim()).filter(Boolean)
      statements.push(...parts.map(value => value.trim()).filter(Boolean))
      try {
        await db.batch(statements.map(statement => db.prepare(statement)))
      } catch (error) { throw new Error(`Failed test migration ${file}`, { cause: error }) }
    }
  } else {
    sqlite.db.exec(readFileSync(new URL('../migrations/0001_board.sql', import.meta.url), 'utf8'))
    sqlite.db.exec(readFileSync(new URL('../migrations/0002_checks.sql', import.meta.url), 'utf8'))
    sqlite.db.exec(readFileSync(new URL('../migrations/0003_endpoint_registry.sql', import.meta.url), 'utf8'))
    sqlite.db.exec(readFileSync(new URL('../migrations/0004_aliases.sql', import.meta.url), 'utf8'))
    sqlite.db.exec(readFileSync(new URL('../migrations/0005_gatus_sources.sql', import.meta.url), 'utf8'))
    sqlite.db.exec(readFileSync(new URL('../migrations/0006_advanced_http.sql', import.meta.url), 'utf8'))
    sqlite.db.exec(readFileSync(new URL('../migrations/0007_idempotency.sql', import.meta.url), 'utf8'))
    sqlite.db.exec(readFileSync(new URL('../migrations/0008_monitor_tags.sql', import.meta.url), 'utf8'))
    sqlite.db.exec(readFileSync(new URL('../migrations/0008_vault.sql', import.meta.url), 'utf8'))
    sqlite.db.exec(readFileSync(new URL('../migrations/0009_monitor_auth.sql', import.meta.url), 'utf8'))
    sqlite.db.exec(readFileSync(new URL('../migrations/0009_channels.sql', import.meta.url), 'utf8'))
    sqlite.db.exec(readFileSync(new URL('../migrations/0009_actions.sql', import.meta.url), 'utf8'))
    sqlite.db.exec(readFileSync(new URL('../migrations/0010_monitor_alert_links.sql', import.meta.url), 'utf8'))
    sqlite.db.exec(readFileSync(new URL('../migrations/0010_notification_transition_state.sql', import.meta.url), 'utf8'))
    sqlite.db.exec(readFileSync(new URL('../migrations/0011_email_channels.sql', import.meta.url), 'utf8'))
    sqlite.db.exec(readFileSync(new URL('../migrations/0012_notification_delivery_state.sql', import.meta.url), 'utf8'))
    sqlite.db.exec(readFileSync(new URL('../migrations/0013_notification_unlink_cancel.sql', import.meta.url), 'utf8'))
    sqlite.db.exec(readFileSync(new URL('../migrations/0014_monitor_alert_channel_limit.sql', import.meta.url), 'utf8'))
    sqlite.db.exec(readFileSync(new URL('../migrations/0015_monitor_dependencies.sql', import.meta.url), 'utf8'))
    sqlite.db.exec(readFileSync(new URL('../migrations/0016_dependency_observations.sql', import.meta.url), 'utf8'))
    sqlite.db.exec(readFileSync(new URL('../migrations/0015_monitor_request.sql', import.meta.url), 'utf8'))
    sqlite.db.exec(readFileSync(new URL('../migrations/0017_monitor_action_links.sql', import.meta.url), 'utf8'))
    sqlite.db.exec(readFileSync(new URL('../migrations/0018_delivery_history.sql', import.meta.url), 'utf8'))
    sqlite.db.exec(readFileSync(new URL('../migrations/0019_subscribers.sql', import.meta.url), 'utf8'))
    sqlite.db.exec(readFileSync(new URL('../migrations/0020_subscriber_deliveries.sql', import.meta.url), 'utf8'))
    sqlite.db.exec(readFileSync(new URL('../migrations/0021_preview_subscribers.sql', import.meta.url), 'utf8'))
    sqlite.db.exec(readFileSync(new URL('../migrations/0022_preview_audit_scope.sql', import.meta.url), 'utf8'))
    sqlite.db.exec(readFileSync(new URL('../migrations/0023_preview_audit_events.sql', import.meta.url), 'utf8'))
  }
  const keys = await generateKeyPair('RS256', { extractable: true })
  const jwk = { ...await exportJWK(keys.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' }
  keySets.set(issuer, [jwk])
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    assert.equal(url.pathname, '/cdn-cgi/access/certs')
    const available = keySets.get(url.origin)
    assert.ok(available, `Unexpected issuer: ${url.origin}`)
    keyFetches.set(url.origin, (keyFetches.get(url.origin) ?? 0) + 1)
    return Response.json({ keys: available })
  }
  sign = (subject, email, aud = audience, expires = '5m') => new SignJWT({ email }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer(issuer).setAudience(aud).setSubject(subject).setIssuedAt().setExpirationTime(expires).sign(keys.privateKey)
  adminToken = await sign('admin-id', 'admin@example.com')
  operatorToken = await sign('operator-id', 'operator@example.com')
  viewerToken = await sign('viewer-id', 'viewer@example.com')
  for (const token of [adminToken, operatorToken, viewerToken]) assert.equal((await request('/api/v1/auth/me', token)).response.status, 200)
  await db.prepare("UPDATE users SET role='admin' WHERE subject='admin-id'").run()
  await db.prepare("UPDATE users SET role='operator' WHERE subject='operator-id'").run()
})
after(async () => { globalThis.fetch = originalFetch; if (miniflare) await miniflare.dispose(); else sqlite.db.close() })

test('Access identity, roles and same-origin mutations are enforced', async () => {
  assert.equal((await request('/api/v1/public/status')).response.status, 401)
  assert.equal((await request('/api/v1/auth/me', await sign('invalid', 'invalid@example.com', 'other-audience'))).response.status, 401)
  assert.equal((await request('/api/v1/auth/me', await sign('expired', 'expired@example.com', audience, '-1m'))).response.status, 401)
  assert.equal((await request('/api/v1/admin/components', viewerToken)).response.status, 403)
  assert.equal((await request('/api/v1/admin/users', operatorToken)).response.status, 403)
  assert.equal((await request('/api/v1/admin/components', operatorToken, 'POST', { name: 'API' }, 'https://evil.example')).response.status, 403)
  assert.equal((await request('/api/v1/admin/users', adminToken)).response.status, 200)
})

test('preview identity verification authenticates without reading or writing users', async () => {
  const verify = (token?: string, method = 'GET') => worker.fetch(new Request('https://status.example/api/v1/auth/preview-verify', {
    method, headers: token ? { 'Cf-Access-Jwt-Assertion': token } : {},
  }), { ...env, DB: { prepare: () => { throw new Error('Preview verification must not use D1') } } } as never)
  const newIdentity = await sign('preview-only-id', 'preview-only@example.com')
  const changedEmail = await sign('admin-id', 'changed@example.com')
  assert.equal((await verify(newIdentity)).status, 200)
  assert.equal((await verify(changedEmail)).status, 200)
  assert.equal((await db.prepare('SELECT id FROM users WHERE subject=?').bind('preview-only-id').first()), null)
  assert.equal((await db.prepare('SELECT email FROM users WHERE subject=?').bind('admin-id').first<{ email: string }>())?.email, 'admin@example.com')
  assert.equal((await verify()).status, 401)
  assert.equal((await verify(await sign('invalid', 'invalid@example.com', 'other-audience'))).status, 401)
  assert.equal((await verify(await sign('expired', 'expired@example.com', audience, '-1m'))).status, 401)
  assert.equal((await verify(await sign('missing-email', ''))).status, 401)
  assert.equal((await verify(newIdentity, 'POST')).status, 405)
})

test('gateway checks authenticated preview navigation and API requests without touching baseline D1', async () => {
  const isolatedEnv = { ...env, DB: { prepare: () => { throw new Error('Baseline D1 was accessed') } } }
  let dispatches = 0
  const gatewayEnv = {
    API: { fetch: (req: Request) => worker.fetch(req, isolatedEnv as never) },
    PREVIEW_DISPATCHER: { fetch: async () => { dispatches++; return new Response('preview') } },
  }
  const token = await sign('preview-gateway-id', 'preview-gateway@example.com')
  const headers = { 'Cf-Access-Jwt-Assertion': token, 'X-Status-Preview': `branch-${'a'.repeat(24)}` }
  for (const path of ['/', '/assets/app.js', '/api/v1/auth/me']) {
    const response = await gateway.fetch(new Request(`https://status.example${path}`, { headers }), gatewayEnv as never)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'preview')
  }
  assert.equal(dispatches, 3)
  const invalid = await gateway.fetch(new Request('https://status.example/', { headers: { ...headers, 'Cf-Access-Jwt-Assertion': 'invalid' } }), gatewayEnv as never)
  assert.equal(invalid.status, 401)
  assert.equal(dispatches, 3)
  assert.equal(await db.prepare('SELECT id FROM users WHERE subject=?').bind('preview-gateway-id').first(), null)
})

test('system health is administrator-only and reports observed dependency state', async () => {
  const path = '/api/v1/bsp/admin/system-health'
  assert.equal((await request(path)).response.status, 401)
  assert.equal((await request(path, viewerToken)).response.status, 403)
  assert.equal((await request(path, operatorToken)).response.status, 403)
  const initial = await request(path, adminToken)
  assert.equal(initial.response.status, 200)
  assert.equal(initial.response.headers.get('cache-control'), 'no-store')
  const report = initial.body as unknown as { status: string; database: { status: string }; monitoring: { status: string }; backups: { status: string }; notifications: { status: string }; staticMirror: { status: string } }
  assert.equal(report.status, 'healthy')
  assert.equal(report.database.status, 'ok')
  assert.equal(report.monitoring.status, 'disabled')
  assert.equal(report.backups.status, 'disabled')
  env.BACKUPS_READY = 'true'
  try {
    const missing = (await request(path, adminToken)).body as unknown as { status: string; backups: { status: string } }
    assert.equal(missing.status, 'degraded')
    assert.equal(missing.backups.status, 'error')
  } finally { delete env.BACKUPS_READY }
  assert.equal(report.notifications.status, 'disabled')
  assert.equal(report.staticMirror.status, 'disabled')
  env.GATUS_REQUIRED = 'true'
  try {
    const missing = (await request(path, adminToken)).body as unknown as { status: string; gatus: { status: string } }
    assert.equal(missing.status, 'degraded')
    assert.equal(missing.gatus.status, 'error')
  } finally { delete env.GATUS_REQUIRED }

  await db.prepare("INSERT INTO components (id, name, position, manual_status, updated_at) VALUES ('health-gatus', 'Gatus fixture', 0, 'operational', 0)").run()
  await db.prepare("INSERT INTO gatus_sources (source_id,component_id,kind,source_key,source_name,source_group,stale_after_seconds,advisory) VALUES ('health-source','health-gatus','endpoint','health-key','Health Gatus','',180,0)").run()
  try {
    const status = { key: 'health-key', name: 'Health Gatus', group: '', results: [{ success: true, timestamp: new Date().toISOString(), duration: 1000 }] }
    env.GATUS = { fetch: async incoming => Response.json(new URL(incoming.url).pathname.includes('/endpoints/') ? [status] : []) }
    assert.equal(((await request(path, adminToken)).body as unknown as {gatus:{status:string}}).gatus.status, 'ok')
    status.results = []
    assert.equal(((await request(path, adminToken)).body as unknown as {gatus:{status:string}}).gatus.status, 'attention')
    env.GATUS = { fetch: async () => { throw new Error('private gatus failure') } }
    const unavailable = (await request(path, adminToken)).body as unknown as {gatus:{status:string}}
    assert.equal(unavailable.gatus.status, 'error')
    assert.doesNotMatch(JSON.stringify(unavailable), /private gatus failure/)
  } finally {
    delete env.GATUS
    await db.prepare("DELETE FROM gatus_sources WHERE source_id='health-source'").run()
    await db.prepare("DELETE FROM components WHERE id='health-gatus'").run()
  }
  const endpoint = { id: 'health-endpoint', name: 'Health fixture', url: 'https://example.com/' }
  env.ENDPOINTS = JSON.stringify([endpoint])
  await db.prepare('INSERT INTO endpoint_registry (endpoint_id, fingerprint) VALUES (?, ?)').bind(endpoint.id, await endpointFingerprint(endpoint)).run()
  await db.prepare("INSERT INTO components (id, name, position, manual_status, updated_at) VALUES ('health-component', 'Health fixture', 0, 'operational', 0)").run()
  await db.prepare("INSERT INTO http_checks (id, component_id, endpoint_id, enabled, interval_minutes, expected_status, last_result_at) VALUES ('health-check', 'health-component', 'health-endpoint', 1, 1, 200, ?)").bind(Date.now()).run()
  try {
    const fresh = (await request(path, adminToken)).body as unknown as { status: string; monitoring: { status: string; configuredMonitors: number; overdueMonitors: number } }
    assert.equal(fresh.status, 'healthy')
    assert.deepEqual([fresh.monitoring.status, fresh.monitoring.configuredMonitors, fresh.monitoring.overdueMonitors], ['ok', 1, 0])
    env.ENDPOINTS = JSON.stringify([{ ...endpoint, url: 'https://other.example/' }])
    const mismatch = (await request(path, adminToken)).body as unknown as typeof fresh
    assert.deepEqual([mismatch.status, mismatch.monitoring.status, mismatch.monitoring.overdueMonitors], ['degraded', 'attention', 1])
    env.ENDPOINTS = JSON.stringify([endpoint])
    await db.prepare("UPDATE http_checks SET last_result_at=0 WHERE id='health-check'").run()
    const stale = (await request(path, adminToken)).body as unknown as typeof fresh
    assert.equal(stale.status, 'degraded')
    assert.deepEqual([stale.monitoring.status, stale.monitoring.overdueMonitors], ['attention', 1])
    env.BACKUPS_READY = 'true'
    env.BACKUPS = { fetch: async () => { throw new Error('secret backup credentials') } }
    const failed = (await request(path, adminToken)).body as unknown as { status: string; backups: { status: string } }
    assert.equal(failed.status, 'degraded')
    assert.equal(failed.backups.status, 'error')
    assert.doesNotMatch(JSON.stringify(failed), /secret backup credentials/)
    env.BACKUPS = { fetch: async incoming => {
      assert.equal(new URL(incoming.url).pathname, '/health')
      return Response.json({ status: 'ok' })
    } }
    assert.equal(((await request(path, adminToken)).body as unknown as { backups: { status: string } }).backups.status, 'ok')
  } finally {
    delete env.BACKUPS; delete env.BACKUPS_READY; env.ENDPOINTS = '[]'
    await db.prepare('DELETE FROM endpoint_registry WHERE endpoint_id=?').bind(endpoint.id).run()
    await db.prepare("DELETE FROM http_checks WHERE id='health-check'").run()
    await db.prepare("DELETE FROM components WHERE id='health-component'").run()
  }
})

test('system health redacts unavailable database errors', async () => {
  const failed = { prepare() { throw new Error('sensitive database detail') } }
  const report = await getSystemHealthReport({ DB: failed as unknown as D1Database, ENDPOINTS: '[]' })
  assert.equal(report.status, 'degraded')
  assert.equal(report.database.status, 'error')
  assert.equal(report.monitoring.status, 'error')
  assert.doesNotMatch(JSON.stringify(report), /sensitive database detail/)
})

test('backup service stays capability-gated, administrator-only and idempotent', async () => {
  const path = '/api/v1/bsp/admin/backups'
  assert.equal((await request(path, adminToken)).response.status, 503)
  const ids: string[] = []
  const queries: string[] = []
  env.BACKUPS_READY = 'true'
  env.BACKUPS = { fetch: async incoming => {
    if (incoming.method === 'POST') { ids.push(incoming.headers.get('x-backup-id') ?? ''); return Response.json({ id: ids.at(-1) }, { status: 202 }) }
    queries.push(new URL(incoming.url).search)
    return Response.json({ backups: [], nextCursor: null })
  } }
  try {
    const capabilities = (await request('/api/v1/bsp/capabilities', adminToken)).body as unknown as {supportedRoutes:string[]}
    assert.ok(capabilities.supportedRoutes.includes('/admin/backups'))
    assert.equal((await request(path, viewerToken)).response.status, 403)
    assert.equal((await request(path, operatorToken)).response.status, 403)
    for (const action of ['verify', 'download']) {
      const itemPath = `${path}/${'a'.repeat(64)}/${action}`
      assert.equal((await request(itemPath, viewerToken)).response.status, 403)
      assert.equal((await request(itemPath, operatorToken)).response.status, 403)
      assert.equal((await request(itemPath, adminToken)).response.status, 200)
    }
    assert.equal((await request(path, adminToken)).response.status, 200)
    assert.equal((await request(`${path}?cursor=next-page`, adminToken)).response.status, 200)
    assert.equal(queries.at(-1), '?cursor=next-page')
    assert.equal((await request(path, adminToken, 'POST', {})).response.status, 400)
    const key = `${Date.now()}.${crypto.randomUUID()}`
    assert.equal((await request(path, adminToken, 'POST', {}, 'https://evil.example', key)).response.status, 403)
    assert.equal((await request(path, adminToken, 'POST', {}, 'https://status.example', key)).response.status, 202)
    assert.equal((await request(path, adminToken, 'POST', {}, 'https://status.example', key)).response.status, 202)
    assert.match(ids[0], /^[a-f0-9]{64}$/); assert.equal(ids[0], ids[1])
    const events = await db.prepare("SELECT action FROM audit_events WHERE entity_type='backup' AND entity_id=?").bind(ids[0]).all<{action:string}>()
    assert.deepEqual(events.results.map(row => row.action), ['create'])
  } finally { delete env.BACKUPS; delete env.BACKUPS_READY }
})

test('audit log is admin-only, paginated, filtered and redacts legacy sensitive details', async () => {
  const email = 'audit-fixture@example.com'
  const statements = Array.from({ length: 55 }, (_, i) => db.prepare('INSERT INTO audit_events (id, actor_email, action, entity_type, entity_id, created_at, details) VALUES (?,?,?,?,?,?,?)')
    .bind(`audit-fixture-${String(i).padStart(2, '0')}`, email, i % 2 ? 'publish' : 'update', 'incident', `target-${i}`, 1000 + i, JSON.stringify({ status: 'monitoring', componentId: 'secret-invalid-id', title: 'secret-title', token: 'secret-token', nested: { password: 'secret-password' } })))
  await db.batch(statements)
  try {
    const path = '/api/v1/bsp/admin/audit-log'
    assert.equal((await request(path, viewerToken)).response.status, 403)
    assert.equal((await request(path, operatorToken)).response.status, 403)
    const result = await request(`${path}?userEmail=audit-fixture%40example.com&entityType=incident&limit=50`, adminToken)
    assert.equal(result.response.status, 200)
    const data = result.body as unknown as {entries: Array<{id:string;diff:unknown}>; total:number; pages:number}
    assert.equal(data.total, 55); assert.equal(data.pages, 2); assert.equal(data.entries.length, 50)
    assert.equal(data.entries[0].id, 'audit-fixture-54')
    assert.deepEqual(data.entries[0].diff, { status: 'monitoring' })
    assert.doesNotMatch(JSON.stringify(data), /secret-/)
    const second = (await request(`${path}?userEmail=audit-fixture%40example.com&limit=50&page=2`, adminToken)).body as unknown as {entries:unknown[]}
    assert.equal(second.entries.length, 5)
    const filtered = (await request(`${path}?userEmail=audit-fixture%40example.com&action=publish&from=1005&to=1010`, adminToken)).body as unknown as {total:number}
    assert.equal(filtered.total, 3)
    const escaped = (await request(`${path}?userEmail=%25`, adminToken)).body as unknown as {total:number}
    assert.equal(escaped.total, 0)
    for (const query of ['page=0', 'page=1.5', 'limit=101', 'from=2&to=1', 'action=' + 'x'.repeat(201)]) assert.equal((await request(`${path}?${query}`, adminToken)).response.status, 400)
    const legacy = await request('/api/v1/admin/audit', adminToken)
    assert.doesNotMatch(JSON.stringify(legacy.body), /secret-/)
  } finally { await db.prepare("DELETE FROM audit_events WHERE actor_email=?").bind(email).run() }
})

test('audit pagination orders same-millisecond events by insertion order', async () => {
  const email = 'audit-order@example.com'
  const insert = (id: string, action: string) => db.prepare('INSERT INTO audit_events (id, actor_email, action, entity_type, entity_id, created_at, details) VALUES (?,?,?,?,?,?,?)')
    .bind(id, email, action, 'incident', 'same-incident', 1000, '{}')
  await db.batch([insert('ffffffff-ffff-4fff-afff-ffffffffffff', 'create'), insert('00000000-0000-4000-8000-000000000000', 'publish')])
  try {
    const path = '/api/v1/bsp/admin/audit-log?userEmail=audit-order%40example.com&limit=1'
    const first = (await request(`${path}&page=1`, adminToken)).body as unknown as {entries: Array<{action:string}>}
    const second = (await request(`${path}&page=2`, adminToken)).body as unknown as {entries: Array<{action:string}>}
    assert.equal(first.entries[0]?.action, 'publish')
    assert.equal(second.entries[0]?.action, 'create')
  } finally { await db.prepare('DELETE FROM audit_events WHERE actor_email=?').bind(email).run() }
})

test('idempotent creates survive an ambiguous response and concurrent retries without storing bodies', async () => {
  const key = `${Date.now()}.${crypto.randomUUID()}`
  const payload = { name: '  Receipt private fixture  ', manualStatus: 'operational', position: 0 }
  const before = (await db.prepare('SELECT COUNT(*) AS n FROM components').first<{n:number}>())!.n
  const [one, two] = await Promise.all([
    request('/api/v1/admin/components', adminToken, 'POST', payload, 'https://status.example', key),
    request('/api/v1/admin/components', adminToken, 'POST', payload, 'https://status.example', key),
  ])
  assert.equal(one.response.status, 201); assert.equal(two.response.status, 201)
  assert.deepEqual(one.body, two.body)
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM components').first<{n:number}>())!.n, before + 1)
  const retry = await request('/api/v1/admin/components', adminToken, 'POST', payload, 'https://status.example', key)
  assert.deepEqual(retry.body, one.body)
  assert.equal((await request('/api/v1/admin/components', adminToken, 'POST', { ...payload, name: 'different' }, 'https://status.example', key)).response.status, 409)
  const stored = await db.prepare('SELECT * FROM mutation_receipts WHERE request_key=?').bind(key).first<Record<string, unknown>>()
  assert.ok(stored); assert.doesNotMatch(JSON.stringify(stored), /Receipt private fixture/)
  const expired = `${Date.now() - 25 * 3600000}.${crypto.randomUUID()}`
  const admin = (await db.prepare("SELECT id,version FROM users WHERE subject='admin-id'").first<{id:string;version:number}>())!
  await db.prepare('INSERT INTO mutation_receipts (actor_id,request_key,request_hash,actor_version,attempt_token,status,expires_at) VALUES (?,?,?,?,?,201,?)')
    .bind(admin.id,expired,'expired-hash',admin.version,crypto.randomUUID(),Date.now()-1).run()
  const old = await request('/api/v1/admin/components', adminToken, 'POST', payload, 'https://status.example', expired)
  assert.equal(old.response.status, 409)
  assert.equal((old.body as unknown as {code:string}).code, 'IDEMPOTENCY_EXPIRED')
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM components').first<{n:number}>())!.n, before + 1)
})

test('receipt replay is scoped to an authorized identity and preserves alias results', async () => {
  const key = `${Date.now()}.${crypto.randomUUID()}`
  const payload = { title: 'One incident', status: 'investigating', impact: 'minor', body: 'Details', monitorIds: [], draft: true }
  assert.equal((await request('/api/v1/bsp/admin/incidents', operatorToken, 'POST', payload, 'https://status.example', key, 'different-account')).response.status, 403)
  const first = await request('/api/v1/bsp/admin/incidents', operatorToken, 'POST', payload, 'https://status.example', key)
  assert.equal(first.response.status, 201)
  const other = await request('/api/v1/bsp/admin/incidents', adminToken, 'POST', payload, 'https://status.example', key)
  assert.equal(other.response.status, 201); assert.notEqual(other.body.id, first.body.id)
  const user = (await db.prepare("SELECT id FROM users WHERE subject='operator-id'").first<{id:string}>())!
  await db.prepare("UPDATE users SET role='viewer',version=version+1 WHERE id=?").bind(user.id).run()
  try { assert.equal((await request('/api/v1/bsp/admin/incidents', operatorToken, 'POST', payload, 'https://status.example', key)).response.status, 403) }
  finally { await db.prepare("UPDATE users SET role='operator',version=version+1 WHERE id=?").bind(user.id).run() }
  const replay = await request('/api/v1/bsp/admin/incidents', operatorToken, 'POST', payload, 'https://status.example', key)
  assert.equal(replay.response.status, 201); assert.deepEqual(replay.body, first.body)
})

test('versioned keyed mutations replay once and roll back receipts for stale versions', async () => {
  const created = await request('/api/v1/admin/components', adminToken, 'POST', { name: 'Versioned receipt' })
  const id = created.body.id, key = `${Date.now()}.${crypto.randomUUID()}`
  const path = `/api/v1/admin/components/${id}`
  const payload = { name: '  Updated name  ', manualStatus: 'degraded', position: 2, version: 1 }
  const changed = await request(path, adminToken, 'PATCH', payload, 'https://status.example', key)
  assert.equal(changed.response.status, 200)
  const retry = await request(path, adminToken, 'PATCH', payload, 'https://status.example', key)
  assert.deepEqual(retry.body, changed.body)
  const count = await db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE entity_type='component' AND entity_id=? AND action='update'").bind(id).first<{n:number}>()
  assert.equal(count!.n, 1)
  const staleKey = `${Date.now()}.${crypto.randomUUID()}`
  assert.equal((await request(path, adminToken, 'PATCH', payload, 'https://status.example', staleKey)).response.status, 409)
  assert.equal(await db.prepare('SELECT request_key FROM mutation_receipts WHERE request_key=?').bind(staleKey).first(), null)
  assert.equal((await request('/api/v1/admin/maintenance', adminToken, 'POST', { name: 'X', startsAt: 1, endsAt: 2 }, 'https://status.example', key)).response.status, 409)
})

test('concurrent conflicting intents cannot both commit and maintenance aliases replay exactly', async () => {
  const key = `${Date.now()}.${crypto.randomUUID()}`
  const [a, b] = await Promise.all([
    request('/api/v1/admin/components', adminToken, 'POST', { name: 'First competing intent' }, 'https://status.example', key),
    request('/api/v1/admin/components', adminToken, 'POST', { name: 'Second competing intent' }, 'https://status.example', key),
  ])
  assert.deepEqual([a.response.status, b.response.status].sort(), [201, 409])
  const winner = a.response.status === 201 ? a : b
  const alias = await db.prepare("SELECT alias FROM entity_aliases WHERE entity_type='component' AND entity_id=?").bind(winner.body.id).first<{alias:number}>()
  assert.ok(alias)
  const maintenanceKey = `${Date.now()}.${crypto.randomUUID()}`
  const body = { name: '  Planned work  ', description: '  note  ', startsAt: Date.now() + 300000, endsAt: Date.now() + 600000, monitorIds: [alias.alias, alias.alias] }
  const first = await request('/api/v1/bsp/admin/maintenance', adminToken, 'POST', body, 'https://status.example', maintenanceKey)
  assert.equal(first.response.status, 201)
  const retry = await request('/api/v1/bsp/admin/maintenance', adminToken, 'POST', body, 'https://status.example', maintenanceKey)
  assert.equal(retry.response.status, 201); assert.deepEqual(retry.body, first.body)
})

test('keyed role changes replay the complete response and reject a missing actor binding', async () => {
  const viewer = (await db.prepare("SELECT id,version FROM users WHERE subject='viewer-id'").first<{id:string;version:number}>())!
  const path = `/api/v1/admin/users/${viewer.id}`, key = `${Date.now()}.${crypto.randomUUID()}`, body = { role: 'operator', version: viewer.version }
  const absent = await worker.fetch(new Request(`https://status.example${path}`, { method:'PATCH', headers: { 'Cf-Access-Jwt-Assertion':adminToken, origin:'https://status.example', 'content-type':'application/json', 'Idempotency-Key':key }, body:JSON.stringify(body) }), env as never)
  assert.equal(absent.status, 403)
  try {
    const first = await request(path, adminToken, 'PATCH', body, 'https://status.example', key)
    const replay = await request(path, adminToken, 'PATCH', body, 'https://status.example', key)
    assert.equal(first.response.status, 200); assert.deepEqual(replay.body, first.body)
    assert.equal((replay.body as unknown as {role:string}).role, 'operator')
  } finally { await db.prepare("UPDATE users SET role='viewer',version=version+1 WHERE id=?").bind(viewer.id).run() }
})

test('BSP user management enforces authorization, versions and idempotent role changes', async () => {
  const viewer = await db.prepare("SELECT id, role, version FROM users WHERE subject='viewer-id'").first<{id:string;role:string;version:number}>()
  const admin = await db.prepare("SELECT id, version FROM users WHERE subject='admin-id'").first<{id:string;version:number}>()
  assert.ok(viewer)
  assert.ok(admin)
  const list = '/api/v1/bsp/admin/users'
  const path = `${list}/${viewer.id}`
  const auditCount = async () => (await db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE entity_type='user' AND entity_id=?").bind(viewer.id).first<{count:number}>())!.count
  const before = await auditCount()
  const key = `${Date.now()}.${crypto.randomUUID()}`
  const change = { role: 'operator', version: viewer.version }
  try {
    assert.equal((await request(list)).response.status, 401)
    assert.equal((await request(list, viewerToken)).response.status, 403)
    assert.equal((await request(list, operatorToken)).response.status, 403)
    assert.equal((await request(list, adminToken)).response.status, 200)
    assert.equal((await request(path, operatorToken, 'PATCH', change)).response.status, 403)
    assert.equal((await request(`${list}/${admin.id}`, adminToken, 'PATCH', { role: 'viewer', version: admin.version })).response.status, 409)

    const first = await request(path, adminToken, 'PATCH', change, 'https://status.example', key)
    const replay = await request(path, adminToken, 'PATCH', change, 'https://status.example', key)
    assert.equal(first.response.status, 200)
    assert.deepEqual(replay.body, first.body)
    const stored = await db.prepare('SELECT role, version FROM users WHERE id=?').bind(viewer.id).first<{role:string;version:number}>()
    assert.equal(stored?.role, 'operator')
    assert.equal(stored?.version, viewer.version + 1)
    assert.equal(await auditCount(), before + 1)

    const staleKey = `${Date.now()}.${crypto.randomUUID()}`
    assert.equal((await request(path, adminToken, 'PATCH', { role: 'admin', version: viewer.version }, 'https://status.example', staleKey)).response.status, 409)
    const afterConflict = await db.prepare('SELECT role, version FROM users WHERE id=?').bind(viewer.id).first<{role:string;version:number}>()
    assert.equal(afterConflict?.role, 'operator')
    assert.equal(afterConflict?.version, viewer.version + 1)
    assert.equal(await auditCount(), before + 1)
  } finally {
    await db.prepare('UPDATE users SET role=?, version=version+1 WHERE id=?').bind(viewer.role, viewer.id).run()
  }
})

test('viewer writes and operator role changes are denied without mutations or audit events', async () => {
  const viewer = await db.prepare("SELECT id, role, version FROM users WHERE subject='viewer-id'").first<{ id: string; role: string; version: number }>()
  assert.ok(viewer)
  const componentsBefore = await db.prepare('SELECT count(*) AS count FROM components').first<{ count: number }>()
  const auditsBefore = await db.prepare('SELECT count(*) AS count FROM audit_events').first<{ count: number }>()

  assert.equal((await request('/api/v1/admin/components', viewerToken, 'POST', { name: 'Unauthorized service' })).response.status, 403)
  assert.equal((await request(`/api/v1/admin/users/${viewer.id}`, operatorToken, 'PATCH', { role: 'admin', version: viewer.version })).response.status, 403)

  assert.deepEqual(await db.prepare("SELECT id, role, version FROM users WHERE subject='viewer-id'").first(), viewer)
  assert.deepEqual(await db.prepare('SELECT count(*) AS count FROM components').first(), componentsBefore)
  assert.deepEqual(await db.prepare('SELECT count(*) AS count FROM audit_events').first(), auditsBefore)
})

test('concurrent administrators cannot demote each other or remove the last admin', async () => {
  const firstToken = await sign('race-admin-first', 'race-first@example.com')
  const secondToken = await sign('race-admin-second', 'race-second@example.com')
  for (const token of [firstToken, secondToken]) assert.equal((await request('/api/v1/auth/me', token)).response.status, 200)
  const users = (await db.prepare("SELECT id, subject, version FROM users WHERE subject IN ('race-admin-first','race-admin-second')").all<{ id: string; subject: string; version: number }>()).results
  const first = users.find(user => user.subject === 'race-admin-first')!
  const second = users.find(user => user.subject === 'race-admin-second')!
  await db.prepare("UPDATE users SET role='operator' WHERE subject='admin-id'").run()
  await db.prepare("UPDATE users SET role='admin' WHERE subject IN ('race-admin-first','race-admin-second')").run()

  // Both requests must read their administrator identities before either can
  // perform its role mutation; D1 then serializes their guarded write batches.
  const originalDb = env.DB
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  let arrivals = 0
  const synchronized: TestDatabase = {
    prepare(sql) {
      let statement = originalDb.prepare(sql)
      if (sql !== 'SELECT * FROM users WHERE issuer=? AND subject=?') return statement
      const wrapper: TestStatement = {
        bind(...values) { statement = statement.bind(...values); return wrapper },
        run: () => statement.run(),
        all: <T>() => statement.all<T>(),
        async first<T>() {
          const row = await statement.first<T>()
          if (++arrivals === 2) release()
          await gate
          return row
        },
      }
      return wrapper
    },
    batch: statements => originalDb.batch(statements),
  }
  try {
    env.DB = synchronized
    const [left, right] = await Promise.all([
      request(`/api/v1/admin/users/${second.id}`, firstToken, 'PATCH', { role: 'viewer', version: second.version }),
      request(`/api/v1/admin/users/${first.id}`, secondToken, 'PATCH', { role: 'viewer', version: first.version }),
    ])
    assert.deepEqual([left.response.status, right.response.status].sort(), [200, 409])
    const remaining = await db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin'").first<{count: number}>()
    assert.equal(remaining?.count, 1)
    const audits = await db.prepare("SELECT entity_id FROM audit_events WHERE entity_type='user' AND entity_id IN (?,?)").bind(first.id, second.id).all<{entity_id: string}>()
    assert.equal(audits.results.length, 1)
    assert.equal(audits.results[0].entity_id, left.response.status === 200 ? second.id : first.id)
  } finally {
    env.DB = originalDb
    await db.prepare("UPDATE users SET role='viewer' WHERE subject IN ('race-admin-first','race-admin-second')").run()
    await db.prepare("UPDATE users SET role='admin' WHERE subject='admin-id'").run()
  }
})

test('Access signing keys are cached per issuer and refreshed on rotation', async () => {
  const secondaryIssuer = 'https://another.cloudflareaccess.com'
  const original = await generateKeyPair('RS256', { extractable: true })
  const rotated = await generateKeyPair('RS256', { extractable: true })
  const key = async (pair: typeof original, kid: string) => ({ ...await exportJWK(pair.publicKey), kid, alg: 'RS256', use: 'sig' })
  keySets.set(secondaryIssuer, [await key(original, 'test-key')])
  const token = async (pair: typeof original, kid: string) => new SignJWT({ email: 'other@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid }).setIssuer(secondaryIssuer).setAudience(audience)
    .setSubject('other-id').setIssuedAt().setExpirationTime('5m').sign(pair.privateKey)
  const secondaryEnv = { ...env, ACCESS_TEAM_DOMAIN: 'another.cloudflareaccess.com' }
  const get = async (jwt: string, selectedEnv = secondaryEnv) => worker.fetch(new Request('https://status.example/api/v1/auth/me', {
    headers: { 'Cf-Access-Jwt-Assertion': jwt },
  }), selectedEnv as never)

  const originalJwt = await token(original, 'test-key')
  assert.equal((await get(originalJwt)).status, 200)
  assert.equal((await get(originalJwt)).status, 200)
  assert.equal(keyFetches.get(secondaryIssuer), 1)
  assert.equal((await get(adminToken, env)).status, 200)
  assert.equal(keyFetches.get(issuer), 1)
  // Even with the same kid and expected claims, a key from the other issuer
  // cannot authenticate against the primary issuer's cached key set.
  const forged = await new SignJWT({ email: 'other@example.com' }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(issuer).setAudience(audience).setSubject('forged').setIssuedAt().setExpirationTime('5m').sign(original.privateKey)
  assert.equal((await get(forged, env)).status, 401)

  keySets.set(secondaryIssuer, [await key(rotated, 'new-key')])
  const rotatedJwt = await token(rotated, 'new-key')
  assert.equal((await get(rotatedJwt)).status, 401) // jose's 30-second cooldown
  assert.equal(keyFetches.get(secondaryIssuer), 1)
  const now = Date.now
  try {
    Date.now = () => now() + 31_000
    assert.equal((await get(rotatedJwt)).status, 200)
    assert.equal(keyFetches.get(secondaryIssuer), 2)
  } finally { Date.now = now }
})

test('incident draft, publish, update and stale version leave audit and timeline consistent', async () => {
  const component = await request('/api/v1/admin/components', operatorToken, 'POST', { name: 'API', manualStatus: 'operational' })
  assert.equal(component.response.status, 201)
  const componentId = component.body.id as string
  const incident = await request('/api/v1/admin/incidents', operatorToken, 'POST', { title: 'Outage', impact: 'major', body: 'Investigating', componentIds: [componentId] })
  assert.equal(incident.response.status, 201)
  const incidentId = incident.body.id as string
  assert.equal((await request('/api/v1/public/incidents', viewerToken)).body.length, 0)
  assert.equal((await request(`/api/v1/admin/incidents/${incidentId}/publish`, operatorToken, 'POST', { version: 1 })).response.status, 200)
  const status = await request('/api/v1/public/status', viewerToken)
  assert.equal(status.body.components[0].status, 'down')
  assert.equal((await request(`/api/v1/admin/incidents/${incidentId}/updates`, operatorToken, 'POST', { version: 2, status: 'monitoring', body: 'Fix deployed' })).response.status, 200)
  const beforeCount = Number((await db.prepare('SELECT count(*) AS count FROM audit_events').first())?.count)
  assert.equal((await request(`/api/v1/admin/incidents/${incidentId}/updates`, operatorToken, 'POST', { version: 2, status: 'resolved', body: 'Stale' })).response.status, 409)
  assert.equal(Number((await db.prepare('SELECT count(*) AS count FROM audit_events').first())?.count), beforeCount)
  assert.equal(Number((await db.prepare('SELECT count(*) AS count FROM incident_updates WHERE incident_id=?').bind(incidentId).first())?.count), 2)
  assert.equal((await request(`/api/v1/admin/incidents/${incidentId}/updates`, operatorToken, 'POST', { version: 3, status: 'resolved', body: 'Resolved' })).response.status, 200)
  assert.equal((await request('/api/v1/public/status', viewerToken)).body.components[0].status, 'operational')
})

test('maintenance windows display upcoming and active, and can be ended early', async () => {
  const now = Date.now()
  const scheduled = await request('/api/v1/admin/maintenance', operatorToken, 'POST', { name: 'Upgrade', description: '', startsAt: now + 60_000, endsAt: now + 120_000, componentIds: [] })
  assert.equal(scheduled.response.status, 201)
  assert.equal((await request('/api/v1/public/maintenances', viewerToken)).body[0].state, 'upcoming')
  assert.equal((await request(`/api/v1/admin/maintenance/${scheduled.body.id}/cancel`, operatorToken, 'POST', { version: 1 })).response.status, 200)
  const active = await request('/api/v1/admin/maintenance', operatorToken, 'POST', { name: 'Active', startsAt: now - 60_000, endsAt: now + 120_000, componentIds: [] })
  assert.equal(active.response.status, 201)
  assert.equal((await request('/api/v1/public/status', viewerToken)).body.components[0].underMaintenance, true)
  assert.equal((await request(`/api/v1/admin/maintenance/${active.body.id}/end`, operatorToken, 'POST', { version: 1 })).response.status, 200)
  assert.equal((await request('/api/v1/public/status', viewerToken)).body.components[0].underMaintenance, false)
})

test('check configuration requires an approved endpoint and rejects stale changes', async () => {
  const endpoint = { id: 'api', name: 'API', url: 'https://api.example/health' }
  env.ENDPOINTS = JSON.stringify([endpoint])
  await db.prepare('INSERT INTO endpoint_registry(endpoint_id, fingerprint) VALUES (?, ?)').bind(endpoint.id, await endpointFingerprint(endpoint)).run()
  const component = await request('/api/v1/admin/components', operatorToken, 'POST', { name: 'Check target' })
  const componentId = component.body.id
  const config = { componentId, endpointId: 'unapproved', enabled: true, intervalMinutes: 1, expectedStatus: 200 }
  assert.equal((await request('/api/v1/admin/checks', adminToken, 'POST', config)).response.status, 400)
  assert.equal((await request('/api/v1/admin/checks', operatorToken, 'POST', { ...config, endpointId: 'api' })).response.status, 403)
  const created = await request('/api/v1/admin/checks', adminToken, 'POST', { ...config, endpointId: 'api' })
  assert.equal(created.response.status, 201)
  const newComponent = await request('/api/v1/admin/components', operatorToken, 'POST', { name: 'Moved check target' })
  assert.equal((await request(`/api/v1/admin/checks/${created.body.id}`, adminToken, 'PATCH', { ...config, componentId: newComponent.body.id, endpointId: 'api', expectedStatus: 204, version: 1 })).response.status, 200)
  const checkEvents = await db.prepare("SELECT action, details FROM audit_events WHERE entity_type='check' AND entity_id=? ORDER BY rowid").bind(created.body.id).all<{action:string;details:string}>()
  assert.deepEqual(checkEvents.results.map(event => [event.action, JSON.parse(event.details)]), [
    ['create', { componentId, enabled: true, intervalMinutes: 1, expectedStatus: 200 }],
    ['update', { componentId: newComponent.body.id, enabled: true, intervalMinutes: 1, expectedStatus: 204 }],
  ])
  const page = (await request('/api/v1/bsp/admin/audit-log?entityType=check', adminToken)).body as unknown as {entries: Array<{entityId:string;diff:unknown}>}
  assert.deepEqual(page.entries.filter(event => event.entityId === created.body.id).map(event => event.diff), [
    { componentId: newComponent.body.id, enabled: true, intervalMinutes: 1, expectedStatus: 204 },
    { componentId, enabled: true, intervalMinutes: 1, expectedStatus: 200 },
  ])
  const audits = Number((await db.prepare('SELECT count(*) AS count FROM audit_events').first())?.count)
  assert.equal((await request(`/api/v1/admin/checks/${created.body.id}`, adminToken, 'PATCH', { ...config, endpointId: 'api', version: 1 })).response.status, 409)
  assert.equal(Number((await db.prepare('SELECT count(*) AS count FROM audit_events').first())?.count), audits)
  assert.equal(Number((await db.prepare('SELECT expected_status FROM http_checks WHERE id=?').bind(created.body.id).first())?.expected_status), 204)
})

test('moving an action-linked check is blocked; channel-only moves preserve monitor assignments', async () => {
  const previousEndpoints=env.ENDPOINTS
  const endpoint = { id:'action-move-endpoint', name:'Action move endpoint', url:'https://api.example/action-move' }
  env.ENDPOINTS=JSON.stringify([endpoint])
  await db.prepare('INSERT INTO endpoint_registry(endpoint_id,fingerprint) VALUES (?,?)').bind(endpoint.id,await endpointFingerprint(endpoint)).run()
  const first = await request('/api/v1/admin/components', operatorToken, 'POST', { name: 'Action move original' })
  const second = await request('/api/v1/admin/components', operatorToken, 'POST', { name: 'Action move target' })
  const config = { componentId:first.body.id, endpointId:endpoint.id, enabled:true, intervalMinutes:1, expectedStatus:200 }
  const check = await request('/api/v1/admin/checks', adminToken, 'POST', config)
  assert.equal(check.response.status, 201)
  const checkId = check.body.id
  await db.batch([
    db.prepare("INSERT INTO worker_actions (id,name,endpoint_id,endpoint_fingerprint,vault_id,secret_id,trigger_status,created_at,updated_at) VALUES ('move-action','Move guard action','api','fingerprint',1,1,'all',0,0)"),
    db.prepare('INSERT INTO worker_action_checks (action_id,check_id) VALUES (?,?)').bind('move-action',checkId),
    db.prepare("INSERT INTO worker_action_outbox (id,action_id,action_version,check_id,check_version,scheduled_at,status,state,created_at,updated_at) VALUES ('move-job','move-action',1,?,1,100,'down','pending',0,0)").bind(checkId),
    db.prepare("INSERT INTO notification_channels (id,name,endpoint_id,endpoint_fingerprint,vault_id,secret_id,created_at,updated_at) VALUES ('move-channel','Move guard channel','api','fingerprint',1,1,0,0)"),
    db.prepare("INSERT INTO notification_channels (id,name,endpoint_id,endpoint_fingerprint,vault_id,secret_id,created_at,updated_at) VALUES ('target-channel','Move target channel','api','fingerprint',1,1,0,0)"),
    db.prepare("INSERT INTO monitor_notification_channels (component_id,channel_id) VALUES (?,'target-channel')").bind(second.body.id),
    db.prepare('INSERT INTO notification_channel_checks (channel_id,check_id) VALUES (?,?)').bind('move-channel',checkId),
    db.prepare("INSERT INTO notification_outbox (id,channel_id,channel_version,check_id,check_version,scheduled_at,status,state,created_at,updated_at) VALUES ('move-notification','move-channel',1,?,1,100,'down','pending',0,0)").bind(checkId),
  ])
  const auditsBefore=Number((await db.prepare("SELECT count(*) AS count FROM audit_events WHERE entity_type='check' AND entity_id=?").bind(checkId).first())?.count)
  const moved=await request(`/api/v1/admin/checks/${checkId}`,adminToken,'PATCH',{...config,componentId:second.body.id,version:1})
  assert.equal(moved.response.status,409)
  assert.match((moved.body as unknown as {error:string}).error,/Unlink actions before moving/)
  const keyedMove=await request(`/api/v1/admin/checks/${checkId}`,adminToken,'PATCH',{...config,componentId:second.body.id,version:1},'https://status.example',`${Date.now()}.${crypto.randomUUID()}`)
  assert.equal(keyedMove.response.status,409)
  assert.match((keyedMove.body as unknown as {error:string}).error,/Unlink actions before moving/)
  const after=await db.prepare('SELECT component_id,config_version FROM http_checks WHERE id=?').bind(checkId).first<{component_id:string;config_version:number}>()
  assert.equal(after?.component_id,first.body.id);assert.equal(after?.config_version,1)
  assert.equal(Number((await db.prepare("SELECT count(*) AS count FROM audit_events WHERE entity_type='check' AND entity_id=?").bind(checkId).first())?.count),auditsBefore)
  assert.equal((await db.prepare("SELECT state FROM worker_action_outbox WHERE id='move-job'").first())?.state,'pending')
  assert.equal((await db.prepare("SELECT state FROM notification_outbox WHERE id='move-notification'").first())?.state,'pending')
  const edited=await request(`/api/v1/admin/checks/${checkId}`,adminToken,'PATCH',{...config,expectedStatus:204,version:1})
  assert.equal(edited.response.status,200)
  const staleMove=await request(`/api/v1/admin/checks/${checkId}`,adminToken,'PATCH',{...config,componentId:second.body.id,version:1})
  assert.equal(staleMove.response.status,409)
  assert.equal((staleMove.body as unknown as {error:string}).error,'This record changed. Reload and try again.')
  await db.prepare('DELETE FROM worker_action_checks WHERE action_id=? AND check_id=?').bind('move-action',checkId).run()
  const retryKey=`${Date.now()}.${crypto.randomUUID()}`
  const channelStillLinked=await request(`/api/v1/admin/checks/${checkId}`,adminToken,'PATCH',{...config,componentId:second.body.id,version:2},'https://status.example',retryKey)
  assert.equal(channelStillLinked.response.status,200)
  const links=await db.prepare('SELECT component_id,channel_id FROM monitor_notification_channels WHERE channel_id IN (?,?) ORDER BY channel_id').bind('move-channel','target-channel').all<{component_id:string;channel_id:string}>()
  assert.deepEqual(links.results.map(row=>({...row})),[{component_id:first.body.id,channel_id:'move-channel'},{component_id:second.body.id,channel_id:'target-channel'}])
  const checkLinks=await db.prepare('SELECT channel_id FROM notification_channel_checks WHERE check_id=?').bind(checkId).all<{channel_id:string}>()
  assert.deepEqual(checkLinks.results.map(row=>({...row})),[{channel_id:'target-channel'}])
  assert.equal((await db.prepare("SELECT state FROM notification_outbox WHERE id='move-notification'").first())?.state,'failed')
  await db.prepare('DELETE FROM worker_actions WHERE id=?').bind('move-action').run()
  await db.prepare('DELETE FROM notification_channels WHERE id IN (?,?)').bind('move-channel','target-channel').run()
  await db.prepare('DELETE FROM http_checks WHERE id=?').bind(checkId).run()
  env.ENDPOINTS=previousEndpoints
})

test('component status retains the worst manual, check and published incident impact', async () => {
  const component = await request('/api/v1/admin/components', operatorToken, 'POST', { name: 'Aggregation', manualStatus: 'degraded' })
  const componentId = component.body.id
  const check = await request('/api/v1/admin/checks', adminToken, 'POST', {
    componentId, endpointId: 'api', enabled: true, intervalMinutes: 1, expectedStatus: 200,
  })
  assert.equal(check.response.status, 201)
  const checkId = check.body.id
  const readComponent = async () => (await request('/api/v1/public/status', viewerToken)).body.components.find(item => item.id === componentId)
  const recordCheck = async (status: 'up' | 'down', lastResultAt = Date.now()) => {
    await db.prepare('UPDATE http_checks SET last_status=?, last_result_at=? WHERE id=?').bind(status, lastResultAt, checkId).run()
  }

  await recordCheck('up')
  assert.equal((await readComponent()).status, 'degraded')
  assert.equal((await readComponent()).checkStatus, 'operational')
  assert.equal((await request(`/api/v1/admin/components/${componentId}`, operatorToken, 'PATCH', { manualStatus: 'down', version: 1 })).response.status, 200)
  assert.equal((await readComponent()).status, 'down')
  assert.equal((await request(`/api/v1/admin/components/${componentId}`, operatorToken, 'PATCH', { manualStatus: 'operational', version: 2 })).response.status, 200)
  await recordCheck('down')
  assert.equal((await readComponent()).status, 'down')

  await recordCheck('up', Date.now() - 181_000)
  assert.equal((await readComponent()).status, 'unknown')
  const incident = await request('/api/v1/admin/incidents', operatorToken, 'POST', {
    title: 'Aggregation incident', impact: 'minor', body: 'Investigating', componentIds: [componentId],
  })
  assert.equal((await request(`/api/v1/admin/incidents/${incident.body.id}/publish`, operatorToken, 'POST', { version: 1 })).response.status, 200)
  assert.equal((await readComponent()).status, 'degraded')
  await recordCheck('down')
  assert.equal((await readComponent()).status, 'down')
  assert.equal((await request(`/api/v1/admin/incidents/${incident.body.id}/updates`, operatorToken, 'POST', { version: 2, status: 'resolved', body: 'Resolved' })).response.status, 200)
  await recordCheck('up')
  assert.equal((await readComponent()).status, 'operational')
  const originalConfig = env.ENDPOINTS
  env.ENDPOINTS = JSON.stringify([{ id: 'api', name: 'API', url: 'https://api.example/new-target' }])
  assert.equal((await readComponent()).status, 'unknown')
  assert.equal((await readComponent()).lastCheckedAt, null)
  env.ENDPOINTS = originalConfig
  assert.equal((await readComponent()).status, 'operational')
  assert.ok((await readComponent()).lastCheckedAt)
  await db.prepare('UPDATE http_checks SET enabled=0 WHERE id=?').bind(checkId).run()
})

test('the check limit counts enabled checks and also applies when enabling', async () => {
  for (let index = 0; index < 20; index++) {
    await db.prepare('INSERT INTO components (id,name,position,manual_status,updated_at) VALUES (?,?,?,?,?)').bind(`limit-${index}`, `Limit ${index}`, index, 'operational', Date.now()).run()
    if (index < 19) await db.prepare('INSERT INTO http_checks (id,component_id,endpoint_id,enabled,interval_minutes,expected_status,config_version) VALUES (?,?,?,?,?,?,1)').bind(`check-${index}`, `limit-${index}`, 'api', 1, 1, 200).run()
  }
  const config = { componentId: 'limit-19', endpointId: 'api', enabled: false, intervalMinutes: 1, expectedStatus: 200 }
  const disabled = await request('/api/v1/admin/checks', adminToken, 'POST', config)
  assert.equal(disabled.response.status, 201)
  const enable = { ...config, enabled: true, version: 1 }
  assert.equal((await request(`/api/v1/admin/checks/${disabled.body.id}`, adminToken, 'PATCH', enable)).response.status, 409)
  await db.prepare('UPDATE http_checks SET enabled=0 WHERE id=?').bind('check-0').run()
  assert.equal((await request(`/api/v1/admin/checks/${disabled.body.id}`, adminToken, 'PATCH', enable)).response.status, 200)
})

test('old active incidents and maintenance remain visible when history and future windows exceed 200', async () => {
  const now = Date.now()
  const componentId = 'long-running-component'
  const activeIncidentId = 'long-running-incident'
  const activeMaintenanceId = 'long-running-maintenance'
  const statements = [
    db.prepare('INSERT INTO components (id,name,position,manual_status,updated_at) VALUES (?,?,?,?,?)').bind(componentId, 'Long running', 0, 'operational', now),
    db.prepare('INSERT INTO incidents (id,title,status,impact,draft,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').bind(activeIncidentId, 'Long incident', 'investigating', 'major', 0, now - 86_400_000, now),
    db.prepare('INSERT INTO incident_components (incident_id,component_id) VALUES (?,?)').bind(activeIncidentId, componentId),
    db.prepare('INSERT INTO maintenance (id,name,description,starts_at,ends_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').bind(activeMaintenanceId, 'Active maintenance', '', now - 60_000, now + 60_000, now, now),
    db.prepare('INSERT INTO maintenance_components (maintenance_id,component_id) VALUES (?,?)').bind(activeMaintenanceId, componentId),
  ]
  for (let index = 0; index < 205; index++) {
    statements.push(db.prepare('INSERT INTO incidents (id,title,status,impact,draft,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').bind(`resolved-${index}`, 'Resolved', 'resolved', 'minor', 0, now + index, now + index))
    statements.push(db.prepare('INSERT INTO maintenance (id,name,description,starts_at,ends_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').bind(`future-${index}`, 'Future', '', now + 120_000 + index, now + 180_000 + index, now, now))
  }
  await db.batch(statements)
  const status = await request('/api/v1/public/status', viewerToken)
  assert.equal(status.response.status, 200)
  assert.ok(status.body.activeIncidents.some((incident: {id: string}) => incident.id === activeIncidentId))
  assert.ok(status.body.activeMaintenanceWindows.some((window: {id: string}) => window.id === activeMaintenanceId))
  const component = status.body.components.find((item: {id: string}) => item.id === componentId)
  assert.equal(component.status, 'down')
  assert.equal(component.underMaintenance, true)
  const windows = await request('/api/v1/public/maintenances', viewerToken)
  assert.equal(windows.body.filter((window: {name: string}) => window.name === 'Future').length, 205)
})

test('draft opening messages can be corrected with version-checked atomic updates', async () => {
  const created = await request('/api/v1/admin/incidents', operatorToken, 'POST', {
    title: 'Draft correction', impact: 'minor', body: 'Original message', componentIds: [],
  })
  const incidentId = created.body.id as string
  assert.equal(created.response.status, 201)
  assert.equal((await request(`/api/v1/admin/incidents/${incidentId}`, operatorToken, 'PATCH', {
    version: 1, body: 'Corrected message',
  })).response.status, 200)
  const beforeAudit = Number((await db.prepare('SELECT count(*) AS count FROM audit_events').first())?.count)
  assert.equal((await request(`/api/v1/admin/incidents/${incidentId}`, operatorToken, 'PATCH', {
    version: 1, body: 'Stale message',
  })).response.status, 409)
  assert.equal(Number((await db.prepare('SELECT count(*) AS count FROM audit_events').first())?.count), beforeAudit)
  const draft = (await request('/api/v1/admin/incidents', operatorToken)).body.find((item: { id: string }) => item.id === incidentId)
  assert.equal(draft.updates[0].body, 'Corrected message')
  assert.equal((await request('/api/v1/public/incidents', viewerToken)).body.some((item: { id: string }) => item.id === incidentId), false)
  assert.equal((await request(`/api/v1/admin/incidents/${incidentId}/publish`, operatorToken, 'POST', { version: 2 })).response.status, 200)
  const published = (await request('/api/v1/public/incidents', viewerToken)).body.find((item: { id: string }) => item.id === incidentId)
  assert.equal(published.updates[0].body, 'Corrected message')
  assert.equal((await request(`/api/v1/admin/incidents/${incidentId}`, operatorToken, 'PATCH', {
    version: 3, body: 'Changed after publication',
  })).response.status, 409)
})

test('draft opening edits preserve timeline order when updates share a timestamp', async () => {
  const created = await request('/api/v1/admin/incidents', operatorToken, 'POST', {
    title: 'Simultaneous draft updates', impact: 'minor', body: 'Opening entry', componentIds: [],
  })
  const incidentId = created.body.id as string
  assert.equal((await request(`/api/v1/admin/incidents/${incidentId}/updates`, operatorToken, 'POST', {
    version: 1, status: 'investigating', body: 'Later entry',
  })).response.status, 200)
  await db.prepare('UPDATE incident_updates SET posted_at=? WHERE incident_id=?').bind(1234, incidentId).run()
  assert.equal((await request(`/api/v1/admin/incidents/${incidentId}`, operatorToken, 'PATCH', {
    version: 2, body: 'Edited opening entry',
  })).response.status, 200)
  const draft = (await request('/api/v1/admin/incidents', operatorToken)).body.find((item: { id: string }) => item.id === incidentId)
  assert.deepEqual(draft.updates.map((entry: { body: string }) => entry.body), ['Edited opening entry', 'Later entry'])
})

test('admin deep links serve the root SPA without redirecting', async () => {
  const paths: string[] = []
  const originalAssetFetch = env.ASSETS.fetch
  env.ASSETS.fetch = async (request?: Request) => {
    const path = new URL(request!.url).pathname
    paths.push(path)
    if (path === '/admin/incidents') return new Response(null, { status: 404 })
    if (path === '/index.html') return Response.redirect('https://status.example/', 307)
    return new Response('board')
  }
  try {
    const response = await worker.fetch(new Request('https://status.example/admin/incidents', {
      headers: { 'Cf-Access-Jwt-Assertion': adminToken, Accept: 'text/html' },
    }), env as never)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'board')
    assert.deepEqual(paths, ['/admin/incidents', '/'])
  } finally {
    env.ASSETS.fetch = originalAssetFetch
  }
})

test('BSP contract keeps aliases, visibility and versioned uptime across the legacy API', async () => {
  const created = await request('/api/v1/admin/components', operatorToken, 'POST', { name: 'BSP fixture', manualStatus: 'operational' })
  assert.equal(created.response.status, 201)
  const componentId = created.body.id
  const status = await request('/api/v1/bsp/public/status', viewerToken)
  assert.equal(status.response.status, 200)
  const body = status.body as unknown as { monitors: Array<{id:number; uuid:string; name:string}> }
  const monitor = body.monitors.find(item => item.uuid === componentId)
  assert.ok(monitor)
  assert.equal(monitor.name, 'BSP fixture')
  const layout = await request('/api/v1/bsp/public/layout', viewerToken)
  assert.equal(layout.response.status, 200)
  const layoutBody = layout.body as unknown as { tree: { children: Array<{type:string}> } }
  assert.ok(layoutBody.tree.children.some(item => item.type === 'incidents'))
  assert.ok(layoutBody.tree.children.some(item => item.type === 'maintenance'))
  const incident = await request('/api/v1/bsp/admin/incidents', operatorToken, 'POST', {
    title: 'BSP atomic publish', body: 'Opening', impact: 'minor', status: 'identified', draft: false, monitorIds: [monitor.id],
  })
  assert.equal(incident.response.status, 201)
  const published = await request('/api/v1/bsp/public/incidents', viewerToken)
  const records = published.body as unknown as Array<{id:number; title:string; status:string; monitorIds:number[]; updates:Array<{body:string;status:string}>}>
  const item = records.find(record => record.title === 'BSP atomic publish')
  assert.ok(item)
  assert.equal(item.status, 'identified')
  assert.deepEqual(item.monitorIds, [monitor.id])
  assert.equal(item.updates[0]?.body, 'Opening')
  const uuid = await db.prepare('SELECT entity_id FROM entity_aliases WHERE entity_type=? AND alias=?').bind('incident', item.id).first<{entity_id:string}>()
  assert.ok(uuid)
  const audit = await db.prepare('SELECT action FROM audit_events WHERE entity_id=? ORDER BY rowid').bind(uuid.entity_id).all<{action:string}>()
  assert.deepEqual(audit.results.map(row => row.action), ['create', 'publish'])
  const draft = await request('/api/v1/bsp/admin/incidents', operatorToken, 'POST', {
    title: 'BSP private draft', body: 'Private', impact: 'minor', status: 'investigating', draft: true, monitorIds: [monitor.id],
  })
  assert.equal(draft.response.status, 201)
  const invalidPath = await request(`/api/v1/bsp/admin/incidents/${draft.body.id}/publish/extra`, operatorToken, 'POST', { version: 1 })
  assert.equal(invalidPath.response.status, 404)
  const publicIncidents = await request('/api/v1/bsp/public/incidents', viewerToken)
  assert.equal((publicIncidents.body as unknown as Array<{title:string}>).some(row => row.title === 'BSP private draft'), false)
  const publishedDraft = await request(`/api/v1/bsp/admin/incidents/${draft.body.id}/publish`, operatorToken, 'POST', { version: 1 })
  assert.equal(publishedDraft.response.status, 200)
  const stale = await request(`/api/v1/bsp/admin/incidents/${draft.body.id}/updates`, operatorToken, 'POST', { version: 1, body: 'Old edit', status: 'monitoring' })
  assert.equal(stale.response.status, 409)
  const bad = await request('/api/v1/bsp/admin/incidents', operatorToken, 'POST', {
    title: 'BSP empty opening', body: '', impact: 'minor', status: 'investigating', draft: false, monitorIds: [],
  })
  assert.equal(bad.response.status, 400)
  assert.equal(await db.prepare('SELECT id FROM incidents WHERE title=?').bind('BSP empty opening').first(), null)

  await db.prepare('UPDATE http_checks SET enabled=0').run()
  env.ENDPOINTS = JSON.stringify([{ id: 'fixture', name: 'Fixture', url: 'https://example.com/' }])
  const fingerprint = await endpointFingerprint({ id: 'fixture', name: 'Fixture', url: 'https://example.com/' })
  await db.prepare('INSERT INTO endpoint_registry (endpoint_id, fingerprint) VALUES (?, ?)').bind('fixture', fingerprint).run()
  await db.prepare(`INSERT INTO http_checks (id, component_id, endpoint_id, enabled, interval_minutes, expected_status, config_version)
    VALUES (?, ?, ?, 1, 1, 200, 2)`).bind('bsp-history-check', componentId, 'fixture').run()
  await db.prepare(`INSERT INTO http_check_results (check_id, config_version, scheduled_at, completed_at, status, http_status, latency_ms)
    VALUES (?, 1, ?, ?, 'down', 500, 1)`).bind('bsp-history-check', Date.now() - 1000, Date.now() - 1000).run()
  const uptime = await request(`/api/v1/bsp/public/monitor/${monitor.id}/uptime?days=14`, viewerToken)
  const uptimeBody = uptime.body as unknown as { overallUptimePct:number | null; days:Array<{checksTotal:number}> }
  assert.equal(uptimeBody.overallUptimePct, null)
  assert.equal(uptimeBody.days.reduce((sum, day) => sum + day.checksTotal, 0), 0)
  await db.prepare(`INSERT INTO http_check_results (check_id, config_version, scheduled_at, completed_at, status, http_status, latency_ms)
    VALUES (?, 2, ?, ?, 'up', 200, 1)`).bind('bsp-history-check', Date.now(), Date.now()).run()
  const current = await request(`/api/v1/bsp/public/monitor/${monitor.id}/uptime?days=14`, viewerToken)
  assert.equal((current.body as unknown as {overallUptimePct:number}).overallUptimePct, 100)
  const adminMonitors = await request('/api/v1/bsp/admin/monitors', operatorToken)
  const fixture = (adminMonitors.body as unknown as Array<{uuid:string;intervalSecs:number;config:{url:string};health:{uptime24h:number|null;avgResponseMs:number|null;responseTrend:Array<number|null>}}>).find(row => row.uuid === componentId)
  assert.ok(fixture)
  assert.equal(fixture.intervalSecs, 60)
  assert.equal(fixture.config.url, 'Fixture')
  assert.equal(fixture.health.uptime24h, 100)
  assert.equal(fixture.health.avgResponseMs, 1)
  assert.equal(fixture.health.responseTrend.length, 24)
  assert.ok(fixture.health.responseTrend.includes(1))
  const publicStatus = await request('/api/v1/bsp/public/status', viewerToken)
  const publicMonitor = (publicStatus.body as unknown as {monitors:Array<{uuid:string;config:{url:string}}>}).monitors.find(row => row.uuid === componentId)
  assert.equal(publicMonitor?.config.url, '')
  const history = await request(`/api/v1/bsp/admin/monitors/${monitor.id}/history`, operatorToken)
  assert.deepEqual((history.body as unknown as {results:Array<{status:string}>}).results.map(row => row.status), ['up'])
  assert.equal((await request(`/api/v1/bsp/admin/monitors/${monitor.id}/history`, viewerToken)).response.status, 403)
  env.ENDPOINTS = JSON.stringify([{ id: 'fixture', name: 'Fixture', url: 'https://example.org/' }])
  const mismatch = await request(`/api/v1/bsp/public/monitor/${monitor.id}/uptime?days=14`, viewerToken)
  assert.equal((mismatch.body as unknown as {overallUptimePct:number | null}).overallUptimePct, null)
  const mismatchMonitors = await request('/api/v1/bsp/admin/monitors', operatorToken)
  const mismatchFixture = (mismatchMonitors.body as unknown as Array<{uuid:string;health:{uptime24h:number|null;avgResponseMs:number|null}}>) .find(row => row.uuid === componentId)
  assert.equal(mismatchFixture?.health.uptime24h, null)
  assert.equal(mismatchFixture?.health.avgResponseMs, null)
  const mismatchHistory = await request(`/api/v1/bsp/admin/monitors/${monitor.id}/history`, operatorToken)
  assert.equal((mismatchHistory.body as unknown as {results:unknown[]}).results.length, 0)
  env.ENDPOINTS = '[]'
})

test('Gatus inventory is read-only, preserves aliases and incidents, and fails closed on drift', async () => {
  await db.prepare("UPDATE incidents SET status='resolved', resolved_at=? WHERE status<>'resolved'").bind(Date.now()).run()
  const component = 'gatus-fixture-component'
  const sourceId = JSON.stringify(['gatus', 'endpoint', 'Fixture group', 'Fixture service'])
  const suiteComponent = 'gatus-fixture-suite'
  const suiteId = JSON.stringify(['gatus', 'suite', 'Fixture group', 'Fixture suite'])
  const raw = (key: string, name: string) => ({ key, name, group: 'Fixture group', results: [
    { success: true, timestamp: new Date().toISOString(), duration: 2_000_000, hostname: 'never-expose.example' },
  ] })
  const statuses = [raw('fixture_service', 'Fixture service')]
  const suites = [raw('fixture_suite', 'Fixture suite')]
  try {
    for (const [id, name, source, kind, key] of [
      [component, 'Fixture service', sourceId, 'endpoint', 'fixture_service'],
      [suiteComponent, 'Fixture suite', suiteId, 'suite', 'fixture_suite'],
    ]) {
      await db.prepare('INSERT INTO components (id,name,position,updated_at) VALUES (?,?,?,?)').bind(id, name, 1000, Date.now()).run()
      await db.prepare(`INSERT INTO gatus_sources (source_id,component_id,kind,source_key,source_name,source_group,stale_after_seconds,advisory)
        VALUES (?,?,?,?,?,?,?,?)`).bind(source, id, kind, key, name, 'Fixture group', 180, 0).run()
    }
    env.GATUS = { async fetch(request) { return Response.json(new URL(request.url).pathname.includes('/endpoints/') ? statuses : suites) } }
    const publicStatus = await request('/api/v1/bsp/public/status', viewerToken)
    assert.equal(publicStatus.response.status, 200)
    const body = publicStatus.body as unknown as {monitors:Array<{id:number;uuid:string;source?:string;type:string;group:string;currentStatus:string}>}
    const monitor = body.monitors.find(item => item.uuid === component)
    assert.ok(monitor)
    assert.deepEqual([monitor.source, monitor.type, monitor.group, monitor.currentStatus], ['gatus', 'gatus', 'Fixture group', 'up'])
    const rejectedDependency = await request('/api/v1/bsp/admin/monitors', adminToken, 'POST', { name: 'Gatus dependency rejected', manualStatus: 'operational', dependsOnIds: [monitor.id] }, 'https://status.example', `${Date.now()}.${crypto.randomUUID()}`)
    assert.equal(rejectedDependency.response.status, 400)
    assert.doesNotMatch(JSON.stringify(body), /never-expose\.example|fixture_service/)
    const publicAgain = await request('/api/v1/bsp/public/status', viewerToken)
    assert.equal((publicAgain.body as unknown as {monitors:Array<{id:number;uuid:string}>}).monitors.find(item => item.uuid === component)?.id, monitor.id)
    const legacy = await request('/api/v1/public/status', viewerToken)
    assert.equal(legacy.body.components.find(item => item.id === component)?.status, 'operational')
    const originalDb = env.DB
    const nativeCheckLookups: unknown[] = []
    env.DB = {
      prepare(sql) {
        const inner = originalDb.prepare(sql)
        if (sql !== 'SELECT endpoint_id, interval_minutes FROM http_checks WHERE component_id=?') return inner
        return {
          bind(...values) { nativeCheckLookups.push(values[0]); return inner.bind(...values) },
          run: () => inner.run(), first: <T>() => inner.first<T>(), all: <T>() => inner.all<T>(),
        }
      },
      batch: statements => originalDb.batch(statements),
    }
    try {
      const adminList = await request('/api/v1/bsp/admin/monitors', operatorToken)
      assert.equal((adminList.body as unknown as Array<{uuid:string;source?:string}>).find(item => item.uuid === component)?.source, 'gatus')
      assert.deepEqual((adminList.body as unknown as Array<{uuid:string;tags:unknown}>).find(item => item.uuid === component)?.tags, [])
      assert.equal(nativeCheckLookups.includes(component), false)
      assert.equal(nativeCheckLookups.includes(suiteComponent), false)
    } finally { env.DB = originalDb }
    const layout = await request('/api/v1/bsp/public/layout', viewerToken)
    const children = (layout.body as unknown as {tree:{children:Array<{type:string;label?:string;children?:Array<{monitorId:number;showUptimeBar:boolean}>}>}}).tree.children
    const group = children.find(child => child.type === 'group' && child.label === 'Fixture group')
    assert.equal(group?.children?.find(child => child.monitorId === monitor.id)?.showUptimeBar, false)
    const uptime = await request(`/api/v1/bsp/public/monitor/${monitor.id}/uptime?days=14`, viewerToken)
    assert.equal((uptime.body as unknown as {overallUptimePct:number|null}).overallUptimePct, null)
    const history = await request(`/api/v1/bsp/admin/monitors/${monitor.id}/history`, operatorToken)
    assert.deepEqual(history.body, { source: 'gatus', historyAvailable: false, retentionDays: 0, results: [] })
    for (const prefix of ['/api/v1', '/api/v1/bsp']) {
      const edit = await request(`${prefix}/admin/components/${component}`, operatorToken, 'PATCH', { name: 'Spoof', version: 1 })
      assert.equal(edit.response.status, 403)
      const check = await request(`${prefix}/admin/checks`, adminToken, 'POST', { componentId: component, endpointId: 'x', enabled: true, intervalMinutes: 1, expectedStatus: 200 })
      assert.equal(check.response.status, 403)
    }
    assert.equal((await request(`/api/v1/bsp/admin/monitors/${monitor.id}`, operatorToken, 'DELETE', {})).response.status, 403)
    const mutationKey = `${Date.now()}.${crypto.randomUUID()}`
    assert.equal((await request(`/api/v1/bsp/admin/monitors/${monitor.id}`, adminToken, 'PATCH', { name: 'Spoof', version: 1, tags: [{ label: 'forbidden', color: '#123456' }] }, 'https://status.example', mutationKey)).response.status, 403)
    assert.equal((await request(`/api/v1/bsp/admin/monitors/${monitor.id}/check-now`, operatorToken, 'POST', {})).response.status, 403)
    assert.equal((await request(`/api/v1/admin/components/${component}`, operatorToken, 'DELETE', {})).response.status, 403)
    await assert.rejects(db.prepare('UPDATE components SET name=? WHERE id=?').bind('Spoof', component).run(), /read-only/i)
    await assert.rejects(db.prepare('INSERT INTO http_checks (id,component_id,endpoint_id,enabled,interval_minutes,expected_status) VALUES (?,?,?,?,?,?)').bind('gatus-check', component, 'fixture', 1, 1, 200).run(), /read-only/i)
    const incident = await request('/api/v1/bsp/admin/incidents', operatorToken, 'POST', { title: 'Gatus incident', body: 'Issue', impact: 'major', status: 'identified', draft: false, monitorIds: [monitor.id] })
    assert.equal(incident.response.status, 201)
    const affected = await request('/api/v1/bsp/public/status', viewerToken)
    assert.equal((affected.body as unknown as {monitors:Array<{uuid:string;currentStatus:string}>}).monitors.find(item => item.uuid === component)?.currentStatus, 'down')
    const resolved = await request(`/api/v1/bsp/admin/incidents/${incident.body.id}/updates`, operatorToken, 'POST', { version: 1, body: 'Resolved', status: 'resolved' })
    assert.equal(resolved.response.status, 200)
    statuses.push(raw('unexpected_service', 'Unapproved service'))
    const messages: string[] = []
    const previousError = console.error
    console.error = (...args: unknown[]) => { messages.push(args.map(String).join(' ')) }
    let drift: Awaited<ReturnType<typeof request>>
    let disconnected: Awaited<ReturnType<typeof request>>
    try {
      drift = await request('/api/v1/bsp/public/status', viewerToken)
      delete env.GATUS
      disconnected = await request('/api/v1/bsp/public/status', viewerToken)
    } finally { console.error = previousError }
    const driftBody = drift.body as unknown as {monitors:Array<{uuid:string;currentStatus:string}>}
    assert.equal(driftBody.monitors.find(item => item.uuid === component)?.currentStatus, 'pending')
    assert.equal(driftBody.monitors.find(item => item.uuid === suiteComponent)?.currentStatus, 'pending')
    assert.doesNotMatch(JSON.stringify(driftBody), /Unapproved service|never-expose\.example/)
    assert.equal((disconnected.body as unknown as {monitors:Array<{uuid:string;currentStatus:string}>}).monitors.find(item => item.uuid === component)?.currentStatus, 'pending')
    assert.deepEqual(messages.map(message => JSON.parse(message)), [{ event: 'gatus_snapshot_unavailable' }, { event: 'gatus_snapshot_unavailable' }])
    await db.prepare('UPDATE gatus_sources SET active=0 WHERE component_id=?').bind(component).run()
    assert.equal((await request(`/api/v1/bsp/admin/monitors/${monitor.id}`, operatorToken, 'DELETE', {})).response.status, 403)
    assert.equal((await request(`/api/v1/admin/components/${component}`, operatorToken, 'PATCH', { name: 'Spoof', version: 1 })).response.status, 403)
    await db.prepare('UPDATE gatus_sources SET active=0 WHERE component_id=?').bind(suiteComponent).run()
    env.GATUS = { async fetch() { return Response.json([]) } }
    assert.equal((await request('/api/v1/bsp/public/status', viewerToken)).response.status, 503)
    delete env.GATUS
    env.GATUS_REQUIRED = 'true'
    assert.equal((await request('/api/v1/bsp/public/status', viewerToken)).response.status, 503)
    env.GATUS_REQUIRED = 'false'
    assert.equal((await request('/api/v1/bsp/public/status', viewerToken)).response.status, 200)
    env.GATUS_REQUIRED = 'invalid'
    assert.equal((await request('/api/v1/bsp/public/status', viewerToken)).response.status, 503)
  } finally {
    delete env.GATUS_REQUIRED
    delete env.GATUS
  }
})

test('reviewed Gatus catalog reconciliation is atomic, idempotent, and preserves old aliases', async () => {
  const first: GatusCatalogEntry = { kind: 'endpoint', key: 'catalog_a', name: 'Service A', group: 'Catalog', staleAfterSeconds: 180, advisory: false }
  const second: GatusCatalogEntry = { kind: 'suite', key: 'catalog_b', name: 'Suite B', group: 'Catalog', staleAfterSeconds: 900, advisory: true }
  const getSources = async () => (await db.prepare('SELECT source_id,component_id,source_key,active FROM gatus_sources WHERE source_id IN (?,?) ORDER BY source_id')
    .bind(gatusSourceId(first), gatusSourceId(second)).all<{source_id:string;component_id:string;source_key:string;active:number}>()).results
  const getAlias = async (componentId: string) => await db.prepare('SELECT alias FROM entity_aliases WHERE entity_type=? AND entity_id=?')
    .bind('component', componentId).first<{alias:number}>()

  await syncGatusCatalog(db as never, [first, second], 42)
  const created = await getSources()
  assert.equal(created.length, 2)
  assert.ok(created.every(row => row.active === 1))
  const firstRow = created.find(row => row.source_id === gatusSourceId(first))!
  const alias = await getAlias(firstRow.component_id)
  assert.ok(alias)
  const incident = await request('/api/v1/bsp/admin/incidents', operatorToken, 'POST', { title: 'Catalog incident', body: 'Issue', impact: 'minor', status: 'identified', draft: false, monitorIds: [alias.alias] })
  assert.equal(incident.response.status, 201)
  const window = await request('/api/v1/bsp/admin/maintenance', operatorToken, 'POST', { name: 'Catalog window', startsAt: Date.now() + 60_000, endsAt: Date.now() + 120_000, monitorIds: [alias.alias] })
  assert.equal(window.response.status, 201)
  const windowAlias = await db.prepare('SELECT alias FROM entity_aliases WHERE entity_type=? AND entity_id=?').bind('maintenance', window.body.id).first<{alias:number}>()
  assert.ok(windowAlias)
  await syncGatusCatalog(db as never, [first, second], 43)
  assert.deepEqual(await getSources(), created)
  assert.deepEqual(await getAlias(firstRow.component_id), alias)
  await syncGatusCatalog(db as never, [second], 44)
  assert.equal((await getSources()).find(row => row.source_id === gatusSourceId(first))?.active, 0)
  const incidents = await request('/api/v1/bsp/public/incidents', viewerToken)
  const retiredIncident = (incidents.body as unknown as Array<{title:string;monitorIds:number[];monitorNames:Record<number,string>}>).find(item => item.title === 'Catalog incident')
  assert.ok(retiredIncident?.monitorIds.includes(alias.alias))
  assert.equal(retiredIncident.monitorNames[alias.alias], 'Service A')
  const windows = await request('/api/v1/bsp/public/maintenances', viewerToken)
  const retiredWindow = (windows.body as unknown as Array<{name:string;monitorNames:Record<number,string>}>).find(item => item.name === 'Catalog window')
  assert.equal(retiredWindow?.monitorNames[alias.alias], 'Service A')
  const visible = await request('/api/v1/bsp/public/status', viewerToken)
  assert.equal((visible.body as unknown as {monitors:Array<{id:number}>}).monitors.some(item => item.id === alias.alias), false)
  const retain = await request(`/api/v1/bsp/admin/incidents/${incident.body.id}`, operatorToken, 'PATCH', { title: 'Catalog retained', version: 1, monitorIds: [alias.alias] })
  assert.equal(retain.response.status, 200)
  const remove = await request(`/api/v1/bsp/admin/incidents/${incident.body.id}`, operatorToken, 'PATCH', { title: 'Catalog removed', version: 2, monitorIds: [] })
  assert.equal(remove.response.status, 200)
  const beforeReadd = await db.prepare('SELECT COUNT(*) AS count FROM audit_events').first<{count:number}>()
  const readd = await request(`/api/v1/bsp/admin/incidents/${incident.body.id}`, operatorToken, 'PATCH', { title: 'Must not persist', version: 3, monitorIds: [alias.alias] })
  assert.equal(readd.response.status, 409)
  assert.deepEqual(await db.prepare('SELECT COUNT(*) AS count FROM audit_events').first<{count:number}>(), beforeReadd)
  const persisted = await request('/api/v1/bsp/public/incidents', viewerToken)
  assert.ok((persisted.body as unknown as Array<{title:string;monitorIds:number[]}>).some(item => item.title === 'Catalog removed' && item.monitorIds.length === 0))
  const createWithInactive = await request('/api/v1/bsp/admin/incidents', operatorToken, 'POST', { title: 'Invalid inactive', body: 'Issue', impact: 'minor', status: 'identified', draft: false, monitorIds: [alias.alias] })
  assert.equal(createWithInactive.response.status, 409)
  assert.equal(await db.prepare('SELECT id FROM incidents WHERE title=?').bind('Invalid inactive').first(), null)
  const retainWindow = await request(`/api/v1/bsp/admin/maintenance/${windowAlias.alias}`, operatorToken, 'PATCH', { name: 'Catalog window retained', version: 1, monitorIds: [alias.alias] })
  assert.equal(retainWindow.response.status, 200)
  const removeWindow = await request(`/api/v1/bsp/admin/maintenance/${windowAlias.alias}`, operatorToken, 'PATCH', { name: 'Catalog window removed', version: 2, monitorIds: [] })
  assert.equal(removeWindow.response.status, 200)
  const beforeWindowReadd = await db.prepare('SELECT COUNT(*) AS count FROM audit_events').first<{count:number}>()
  const readdWindow = await request(`/api/v1/bsp/admin/maintenance/${windowAlias.alias}`, operatorToken, 'PATCH', { name: 'Must not persist', version: 3, monitorIds: [alias.alias] })
  assert.equal(readdWindow.response.status, 409)
  assert.deepEqual(await db.prepare('SELECT COUNT(*) AS count FROM audit_events').first<{count:number}>(), beforeWindowReadd)
  const invalidMaintenance = await request('/api/v1/bsp/admin/maintenance', operatorToken, 'POST', { name: 'Invalid inactive window', startsAt: Date.now() + 60_000, endsAt: Date.now() + 120_000, monitorIds: [alias.alias] })
  assert.equal(invalidMaintenance.response.status, 409)
  assert.equal(await db.prepare('SELECT id FROM maintenance WHERE name=?').bind('Invalid inactive window').first(), null)
  await syncGatusCatalog(db as never, [first, second], 45)
  assert.deepEqual(await getSources(), created)
  assert.deepEqual(await getAlias(firstRow.component_id), alias)

  const before = await getSources()
  await assert.rejects(syncGatusCatalog(db as never, [], 46), /Invalid/)
  await assert.rejects(syncGatusCatalog(db as never, [first, first], 46), /Ambiguous/)
  await assert.rejects(syncGatusCatalog(db as never, [{ ...second, url: 'https://do-not-accept.example' } as GatusCatalogEntry], 46), /Invalid/)
  // The new inventory is internally valid but conflicts with a retained inactive source.
  await assert.rejects(syncGatusCatalog(db as never, [{ ...second, kind: 'endpoint', key: first.key }], 46))
  assert.deepEqual(await getSources(), before)
  assert.deepEqual(await getAlias(firstRow.component_id), alias)
  const nativeComponent = 'catalog-native-fixture'
  await db.prepare('INSERT INTO components (id,name,updated_at) VALUES (?,?,?)').bind(nativeComponent, 'Native', Date.now()).run()
  await db.prepare('INSERT INTO http_checks (id,component_id,endpoint_id,enabled,interval_minutes,expected_status) VALUES (?,?,?,?,?,?)').bind('catalog-native-check', nativeComponent, 'fixture', 0, 1, 200).run()
  await assert.rejects(db.prepare(`INSERT INTO gatus_sources (source_id,component_id,kind,source_key,source_name,source_group,stale_after_seconds,advisory)
    VALUES (?,?,?,?,?,?,?,?)`).bind('conflicting-source', nativeComponent, 'endpoint', 'other', 'Other', 'Catalog', 180, 0).run(), /native check/i)
  await assert.rejects(db.prepare('UPDATE gatus_sources SET component_id=? WHERE source_id=?').bind(nativeComponent, gatusSourceId(first)).run(), /cannot be reassigned/i)
  assert.equal((await request(`/api/v1/bsp/admin/incidents/${incident.body.id}/updates`, operatorToken, 'POST', { body: 'Resolved', status: 'resolved', version: 3 })).response.status, 200)
})

test('advanced HTTP settings are admin-only, versioned, non-secret and no-op aware', async () => {
  const endpoint = { id: 'advanced-api', name: 'Advanced', url: 'https://advanced.example/health' }
  env.ENDPOINTS = JSON.stringify([endpoint])
  await db.prepare('INSERT INTO endpoint_registry(endpoint_id, fingerprint) VALUES (?, ?)').bind(endpoint.id, await endpointFingerprint(endpoint)).run()
  const component = await request('/api/v1/admin/components', operatorToken, 'POST', { name: 'Advanced check target' })
  const created = await request('/api/v1/admin/checks', adminToken, 'POST', { componentId: component.body.id, endpointId: endpoint.id, enabled: false, intervalMinutes: 1, expectedStatus: 200 })
  assert.equal(created.response.status, 201)
  const path = `/api/v1/bsp/admin/checks/${created.body.id}/advanced`
  const config = { method: 'GET', keyword: 'ready', assertions: [{ type: 'header', name: 'x-health', op: 'exists' }] }
  const originalAudit = Number((await db.prepare('SELECT count(*) AS count FROM audit_events').first())?.count)
  assert.equal((await request(path, operatorToken, 'PUT', { version: 1, advancedConfig: config })).response.status, 403)
  assert.equal((await request('/api/v1/bsp/admin/checks', viewerToken)).response.status, 403)
  for (const bad of [
    { headers: { Authorization: 'not-persisted' } }, { body: 'not-persisted' },
    { method: 'POST' }, { assertions: [{ type: 'json', path: '$.bad[', op: 'exists' }] },
    { assertions: [{ type: 'header', name: 'x', op: 'exists', auth: 'not-persisted' }] },
    { method: 'HEAD', keyword: 'unreadable' },
  ]) {
    assert.equal((await request(path, adminToken, 'PUT', { version: 1, advancedConfig: bad })).response.status, 400)
  }
  assert.equal(Number((await db.prepare('SELECT count(*) AS count FROM audit_events').first())?.count), originalAudit)
  assert.equal((await db.prepare('SELECT advanced_config FROM http_checks WHERE id=?').bind(created.body.id).first())?.advanced_config, null)
  const saved = await request(path, adminToken, 'PUT', { version: 1, advancedConfig: config })
  assert.equal(saved.response.status, 200)
  assert.equal(saved.body.version, 2)
  const audits = Number((await db.prepare('SELECT count(*) AS count FROM audit_events').first())?.count)
  assert.equal(audits, originalAudit + 1)
  const list = await request('/api/v1/bsp/admin/checks', adminToken)
  const item = list.body.find(check => check.id === created.body.id) as unknown as { version: number; advancedConfig: unknown }
  assert.equal(item.version, 2)
  assert.deepEqual(item.advancedConfig, config)
  const noChange = await request(path, adminToken, 'PUT', { version: 2, advancedConfig: { assertions: config.assertions, keyword: config.keyword, method: config.method } })
  assert.equal(noChange.response.status, 200)
  assert.equal(noChange.body.version, 2)
  assert.equal(Number((await db.prepare('SELECT count(*) AS count FROM audit_events').first())?.count), audits)
  assert.equal((await request(path, adminToken, 'PUT', { version: 1, advancedConfig: null })).response.status, 409)
  assert.equal(Number((await db.prepare('SELECT count(*) AS count FROM audit_events').first())?.count), audits)
  const publicText = JSON.stringify((await request('/api/v1/public/status', viewerToken)).body)
  assert.ok(!publicText.includes('x-health'))
  assert.ok(!publicText.includes('ready'))
  const audit = await db.prepare('SELECT details FROM audit_events WHERE entity_id=? ORDER BY created_at DESC LIMIT 1').bind(created.body.id).first()
  assert.ok(!String(audit?.details).includes('ready'))
  assert.ok(!String(audit?.details).includes('x-health'))
  const removed = await request(path, adminToken, 'PUT', { version: 2, advancedConfig: null })
  assert.equal(removed.response.status, 200)
  assert.equal(removed.body.version, 3)
})

test('custom request settings require an approved destination and round-trip through the admin API', async () => {
  const endpoint = { id: 'request-api', name: 'Request target', url: 'https://example.com/health', requestPolicy: { allowPost: true, plaintextHeaders: ['x-monitor'], vaultHeaders: [] } }
  const other = { id: 'request-other', name: 'Other target', url: 'https://example.com/other' }
  env.ENDPOINTS = JSON.stringify([endpoint, other])
  env.MONITOR_REQUEST_READY = 'true'
  try {
    const component = await request('/api/v1/admin/components', operatorToken, 'POST', { name: 'Request check' })
    const created = await request('/api/v1/admin/checks', adminToken, 'POST', { componentId: component.body.id, endpointId: endpoint.id, enabled: false, intervalMinutes: 1, expectedStatus: 200 })
    const path = `/api/v1/bsp/admin/checks/${created.body.id}/advanced`
    const config = { method: 'POST', headers: { 'x-monitor': 'check' }, body: '{"check":true}' }
    assert.equal((await request(path, adminToken, 'PUT', { version: 1, advancedConfig: { ...config, headers: { authorization: 'secret' } } })).response.status, 400)
    assert.equal((await request(path, operatorToken, 'PUT', { version: 1, advancedConfig: config })).response.status, 403)
    assert.equal((await request(path, adminToken, 'PUT', { version: 1, advancedConfig: config })).response.status, 200)
    const checks = await request('/api/v1/admin/checks', adminToken)
    assert.deepEqual((checks.body.find(check => check.id === created.body.id) as unknown as { advancedConfig: unknown }).advancedConfig, config)
    const moved = await request(`/api/v1/admin/checks/${created.body.id}`, adminToken, 'PATCH', { componentId: component.body.id, endpointId: other.id, enabled: false, intervalMinutes: 1, expectedStatus: 200, version: 2 })
    assert.equal(moved.response.status, 400)
    const audit = await db.prepare('SELECT details FROM audit_events WHERE entity_id=? ORDER BY created_at DESC LIMIT 1').bind(created.body.id).first()
    assert.ok(!String(audit?.details).includes('check":true'))
  } finally { delete env.MONITOR_REQUEST_READY; env.ENDPOINTS = '[]' }
})

test('effective degraded state survives new reads and legacy-probe fallback uses its latest status', async () => {
  const endpoint = { id: 'advanced-status-api', name: 'Advanced status', url: 'https://status.example.test/health' }
  env.ENDPOINTS = JSON.stringify([endpoint])
  await db.prepare('INSERT INTO endpoint_registry(endpoint_id, fingerprint) VALUES (?, ?)').bind(endpoint.id, await endpointFingerprint(endpoint)).run()
  const component = await request('/api/v1/admin/components', operatorToken, 'POST', { name: 'Advanced status target' })
  const created = await request('/api/v1/admin/checks', adminToken, 'POST', { componentId: component.body.id, endpointId: endpoint.id, enabled: true, intervalMinutes: 1, expectedStatus: 200 })
  const now = Date.now()
  await db.prepare('UPDATE http_checks SET last_status=?,last_effective_status=?,last_scheduled_at=?,last_effective_scheduled_at=?,last_result_at=? WHERE id=?').bind('down', 'degraded', now, now, now, created.body.id).run()
  const findComponent = async () => (await request('/api/v1/public/status', viewerToken)).body.components.find(item => item.id === component.body.id)
  assert.equal((await findComponent())?.status, 'degraded')
  // A pre-migration probe does not write the watermark; newer readers must
  // use the latest legacy status instead of the earlier effective status.
  await db.prepare('UPDATE http_checks SET last_status=?,last_scheduled_at=?,last_result_at=? WHERE id=?').bind('up', now + 60_000, now, created.body.id).run()
  assert.equal((await findComponent())?.status, 'operational')
})

test('draft monitor tests require an admin and forward only approved destinations', async () => {
  env.ENDPOINTS = JSON.stringify([{ id: 'draft-target', name: 'Draft target', url: 'https://example.com' }])
  let forwarded: unknown
  env.PROBE = { async fetch(request) { forwarded = await request.json(); return Response.json({ overall: 'ok', steps: [], totalMs: 1 }) } }
  try {
    const body = { endpointId: 'draft-target', expectedStatus: 200, advancedConfig: { method: 'GET', timeoutMs: 5000, attempts: 1 } }
    assert.equal((await request('/api/v1/bsp/admin/monitors/test', operatorToken, 'POST', body)).response.status, 403)
    assert.equal((await request('/api/v1/bsp/admin/monitors/test', adminToken, 'POST', { ...body, endpointId: 'unknown' })).response.status, 400)
    const result = await request('/api/v1/bsp/admin/monitors/test', adminToken, 'POST', body)
    assert.equal(result.response.status, 200)
    assert.deepEqual(forwarded, body)
  } finally { delete env.PROBE; env.ENDPOINTS = '[]' }
})

test('monitor test and both save paths enforce the same advanced settings size limit', async () => {
  const endpoint = { id: 'size-target', name: 'Size target', url: 'https://example.com' }
  env.ENDPOINTS = JSON.stringify([endpoint])
  let probeCalls = 0
  env.PROBE = { async fetch() { probeCalls++; return Response.json({ overall: 'ok', steps: [], totalMs: 1 }) } }
  const configWithName = (length: number) => ({ assertions: [{ type: 'header', name: 'x'.repeat(length), op: 'not-exists' }] })
  const overhead = JSON.stringify(configWithName(0)).length
  const boundary = configWithName(32_000 - overhead)
  const oversized = configWithName(32_001 - overhead)
  const testPath = '/api/v1/bsp/admin/monitors/test'
  const key = () => `${Date.now()}.${crypto.randomUUID()}`
  try {
    assert.equal(JSON.stringify(boundary).length, 32_000)
    assert.equal(JSON.stringify(oversized).length, 32_001)
    const component = await request('/api/v1/admin/components', operatorToken, 'POST', { name: 'Size check target' })
    const created = await request('/api/v1/admin/checks', adminToken, 'POST', { componentId: component.body.id, endpointId: endpoint.id, enabled: false, intervalMinutes: 1, expectedStatus: 200 })
    const advancedPath = `/api/v1/bsp/admin/checks/${created.body.id}/advanced`
    const testConfig = (advancedConfig: unknown) => request(testPath, adminToken, 'POST', { endpointId: endpoint.id, expectedStatus: 200, advancedConfig })
    const createMonitor = (advancedConfig: unknown) => request('/api/v1/bsp/admin/monitors', adminToken, 'POST', { name: 'Size monitor', check: { endpointId: endpoint.id, enabled: false, intervalMinutes: 1, expectedStatus: 200, advancedConfig } }, 'https://status.example', key())
    assert.equal((await testConfig(boundary)).response.status, 200)
    assert.equal((await request(advancedPath, adminToken, 'PUT', { version: 1, advancedConfig: boundary })).response.status, 200)
    assert.equal((await createMonitor(boundary)).response.status, 201)
    assert.equal((await testConfig(oversized)).response.status, 400)
    assert.equal((await request(advancedPath, adminToken, 'PUT', { version: 2, advancedConfig: oversized })).response.status, 400)
    assert.equal((await createMonitor(oversized)).response.status, 400)
    assert.equal(probeCalls, 1)
  } finally { delete env.PROBE; env.ENDPOINTS = '[]' }
})

test('a saved multibyte advanced check can be tested through the real probe binding', async () => {
  const endpoint = { id: 'unicode-target', name: 'Unicode target', url: 'https://unicode.example.test/health' }
  const value = '界'.repeat(1000)
  const config = { assertions: Array.from({ length: 20 }, () => ({ type: 'json', path: '$.value', op: 'equals', value, onFail: 'down' })) }
  const previousFetch = globalThis.fetch
  env.ENDPOINTS = JSON.stringify([endpoint])
  await db.prepare('INSERT INTO endpoint_registry(endpoint_id,fingerprint) VALUES (?,?)').bind(endpoint.id, await endpointFingerprint(endpoint)).run()
  env.PROBE = { fetch: request => probeWorker.fetch(request, env as never) }
  globalThis.fetch = async (input, init) => String(input) === endpoint.url ? Response.json({ value }) : previousFetch(input, init)
  try {
    const component = await request('/api/v1/admin/components', operatorToken, 'POST', { name: 'Unicode checks' })
    const created = await request('/api/v1/admin/checks', adminToken, 'POST', { componentId: component.body.id, endpointId: endpoint.id, enabled: true, intervalMinutes: 1, expectedStatus: 200 })
    const saved = await request(`/api/v1/bsp/admin/checks/${created.body.id}/advanced`, adminToken, 'PUT', { version: 1, advancedConfig: config })
    assert.equal(saved.response.status, 200)
    const tested = await request('/api/v1/bsp/admin/monitors/test', adminToken, 'POST', { endpointId: endpoint.id, expectedStatus: 200, advancedConfig: config })
    assert.equal(tested.response.status, 200)
    assert.equal((tested.body as unknown as { overall: string }).overall, 'ok')
  } finally { globalThis.fetch = previousFetch; delete env.PROBE; env.ENDPOINTS = '[]' }
})

test('atomic monitor writes preserve checks and reject stale versions', async () => {
  const actor = await db.prepare("SELECT id, version FROM users WHERE subject='admin-id'").first<{id:string;version:number}>()
  assert.ok(actor)
  env.ENDPOINTS = JSON.stringify([{ id: 'atomic-target', name: 'Atomic target', url: 'https://example.com' }])
  async function save(method: string, path: string, body: unknown, key: string) {
    const response = await worker.fetch(new Request(`https://status.example/api/v1/bsp${path}`, {
      method, headers: { 'Cf-Access-Jwt-Assertion': adminToken, origin: 'https://status.example', 'content-type': 'application/json', 'Idempotency-Key': key, 'Idempotency-Actor': actor!.id }, body: JSON.stringify(body),
    }), env as never)
    return { response, value: await response.json() as { id: number; version: number } }
  }
  const identity = await request('/api/v1/bsp/auth/me', adminToken)
  assert.ok(Math.abs(Date.now() - (identity.body as unknown as {serverTime:number}).serverTime) < 5000)
  const expired = await save('POST', '/admin/monitors', { name: 'Expired' }, `${Date.now() - 86_400_001}.${crypto.randomUUID()}`)
  assert.equal(expired.response.status, 409)
  assert.equal((expired.value as unknown as {code:string}).code, 'IDEMPOTENCY_EXPIRED')
  await db.prepare('INSERT INTO mutation_receipts (actor_id,request_key,request_hash,actor_version,attempt_token,status,expires_at) VALUES (?,?,?,?,?,?,?)')
    .bind(actor.id, 'expired-monitor-fixture', 'hash', actor.version, 'token', 200, Date.now() - 1).run()
  const key = () => `${Date.now()}.${crypto.randomUUID()}`
  const body = { name: 'Atomic API', check: { endpointId: 'atomic-target', enabled: false, intervalMinutes: 1, expectedStatus: 200, advancedConfig: { method: 'GET', timeoutMs: 5000, attempts: 1, keyword: 'ok', acceptedStatusRanges: [{ min: 200, max: 204 }] } } }
  const createKey = key()
  const created = await save('POST', '/admin/monitors', body, createKey)
  assert.equal(created.response.status, 201)
  assert.equal(await db.prepare("SELECT request_key FROM mutation_receipts WHERE request_key='expired-monitor-fixture'").first(), null)
  const replay = await save('POST', '/admin/monitors', body, createKey)
  assert.equal(replay.value.id, created.value.id)
  const stored = await db.prepare("SELECT h.* FROM http_checks h JOIN entity_aliases a ON a.entity_id=h.component_id WHERE a.alias=? AND a.entity_type='component'").bind(created.value.id).first<{id:string;config_version:number;advanced_config:string}>()
  assert.ok(stored)
  const monitor = await db.prepare("SELECT entity_id FROM entity_aliases WHERE alias=? AND entity_type='component'").bind(created.value.id).first<{entity_id:string}>()
  assert.ok(monitor)
  const checkAudits = () => db.prepare("SELECT action, details FROM audit_events WHERE entity_type='check' AND entity_id=? ORDER BY rowid").bind(stored.id).all<{action:string;details:string}>()
  assert.deepEqual((await checkAudits()).results.map(row => row.action), ['create'])
  assert.deepEqual(JSON.parse((await checkAudits()).results[0].details), { componentId: monitor.entity_id, enabled: false, intervalMinutes: 1, expectedStatus: 200 })
  assert.doesNotMatch(JSON.stringify((await checkAudits()).results), /keyword|atomic-target/)
  assert.deepEqual(JSON.parse(stored.advanced_config), body.check.advancedConfig)
  const listedChecks = await request('/api/v1/bsp/admin/checks', adminToken)
  assert.deepEqual((listedChecks.body as unknown as { id: string; advancedConfig: unknown }[]).find(item => item.id === stored.id)?.advancedConfig, body.check.advancedConfig)
  const invalidRange = await save('PATCH', `/admin/monitors/${created.value.id}`, { name: 'Invalid range', version: 1, check: { ...body.check, id: stored.id, version: stored.config_version, advancedConfig: { ...body.check.advancedConfig, acceptedStatusRanges: [{ min: 400, max: 200 }] } } }, key())
  assert.equal(invalidRange.response.status, 400)
  const changed = await save('PATCH', `/admin/monitors/${created.value.id}`, { name: 'Renamed', manualStatus: 'operational', position: 0, version: 1 }, key())
  assert.equal(changed.response.status, 200)
  const stale = await save('PATCH', `/admin/monitors/${created.value.id}`, { name: 'Stale', manualStatus: 'operational', position: 0, version: 1, check: { ...body.check, id: stored.id, version: stored.config_version, expectedStatus: 201 } }, key())
  assert.equal(stale.response.status, 409)
  const after = await db.prepare('SELECT config_version, expected_status FROM http_checks WHERE id=?').bind(stored.id).first<{config_version:number;expected_status:number}>()
  assert.equal(after?.config_version, stored.config_version)
  assert.equal(after?.expected_status, 200)
  const invalidCheck = await save('PATCH', `/admin/monitors/${created.value.id}`, { name: 'Rejected', version: 2, check: { ...body.check, id: stored.id, version: stored.config_version + 1 } }, key())
  assert.equal(invalidCheck.response.status, 409)
  assert.deepEqual((await checkAudits()).results.map(row => row.action), ['create'])
  const unchanged = await db.prepare("SELECT c.name FROM components c JOIN entity_aliases a ON a.entity_id=c.id WHERE a.alias=? AND a.entity_type='component'").bind(created.value.id).first<{name:string}>()
  assert.equal(unchanged?.name, 'Renamed')
  const updated = await save('PATCH', `/admin/monitors/${created.value.id}`, { name: 'Changed', version: 2, check: { ...body.check, id: stored.id, version: stored.config_version, expectedStatus: 201 } }, key())
  assert.equal(updated.response.status, 200)
  assert.deepEqual((await checkAudits()).results.map(row => row.action), ['create', 'update'])
  assert.deepEqual(JSON.parse((await checkAudits()).results[1].details), { componentId: monitor.entity_id, enabled: false, intervalMinutes: 1, expectedStatus: 201 })
  const revised = await db.prepare('SELECT config_version, expected_status FROM http_checks WHERE id=?').bind(stored.id).first<{config_version:number;expected_status:number}>()
  assert.equal(revised?.config_version, stored.config_version + 1)
  assert.equal(revised?.expected_status, 201)
  const fingerprint = await endpointFingerprint({ id: 'atomic-target', name: 'Atomic target', url: 'https://example.com' })
  await db.prepare('INSERT INTO endpoint_registry (endpoint_id, fingerprint) VALUES (?,?)').bind('atomic-target', fingerprint).run()
  const registered = await db.prepare('SELECT config_version FROM http_checks WHERE id=?').bind(stored.id).first<{config_version:number}>()
  assert.ok(registered)
  const now = Date.now()
  await db.prepare("UPDATE http_checks SET enabled=1,last_scheduled_at=?,last_result_at=?,last_status='down',last_effective_status='degraded',last_effective_scheduled_at=? WHERE id=?").bind(now, now, now, stored.id).run()
  await db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,effective_status,http_status,latency_ms) VALUES (?,?,?,?,'down','degraded',200,12)").bind(stored.id, registered.config_version, now, now).run()
  const history = await request(`/api/v1/bsp/admin/monitors/${created.value.id}/history`, adminToken)
  assert.equal((history.body as unknown as {results: {status:string}[]}).results[0]?.status, 'degraded')
  const uptime = await request(`/api/v1/bsp/public/monitor/${created.value.id}/uptime?days=1`, adminToken)
  assert.equal((uptime.body as unknown as {days: {status:string}[]}).days[0]?.status, 'degraded')
})

test('atomic monitor writes enforce roles for manual services and check changes', async () => {
  const key = () => `${Date.now()}.${crypto.randomUUID()}`
  const path = '/api/v1/bsp/admin/monitors'
  env.ENDPOINTS = JSON.stringify([{ id: 'role-target', name: 'Role target', url: 'https://example.com' }])
  try {
    const manual = { name: 'Operator manual service', manualStatus: 'operational', position: 0 }
    const viewer = await request(path, viewerToken, 'POST', manual, 'https://status.example', key())
    assert.equal(viewer.response.status, 403)
    const operatorCreate = await request(path, operatorToken, 'POST', manual, 'https://status.example', key())
    assert.equal(operatorCreate.response.status, 201)
    const alias = operatorCreate.body.id
    const unauthorized = await request(`${path}/${alias}`, operatorToken, 'PATCH', {
      ...manual, name: 'Must not save', version: 1,
      check: { endpointId: 'role-target', enabled: false, intervalMinutes: 1, expectedStatus: 200, advancedConfig: null },
    }, 'https://status.example', key())
    assert.equal(unauthorized.response.status, 403)
    const row = await db.prepare("SELECT c.id,c.name,c.version FROM components c JOIN entity_aliases a ON a.entity_id=c.id AND a.entity_type='component' WHERE a.alias=?")
      .bind(alias).first<{id:string;name:string;version:number}>()
    assert.equal(row?.name, manual.name)
    assert.equal(row?.version, 1)
    assert.equal(await db.prepare('SELECT id FROM http_checks WHERE component_id=?').bind(row!.id).first(), null)
    const updated = await request(`${path}/${alias}`, operatorToken, 'PATCH', { ...manual, name: 'Operator updated', version: 1 }, 'https://status.example', key())
    assert.equal(updated.response.status, 200)
    const stale = await request(`${path}/${alias}`, operatorToken, 'PATCH', { ...manual, name: 'Stale update', version: 1 }, 'https://status.example', key())
    assert.equal(stale.response.status, 409)
  } finally { env.ENDPOINTS = '[]' }
})

test('monitor tags round trip atomically and reject invalid or stale writes', async () => {
  const key = () => `${Date.now()}.${crypto.randomUUID()}`
  const path = '/api/v1/bsp/admin/monitors'
  const tags = [{ label: 'production', color: '#6366f1' }, { label: 'api', color: '#ef4444' }]
  const created = await request(path, operatorToken, 'POST', { name: 'Tagged service', tags }, 'https://status.example', key())
  assert.equal(created.response.status, 201)
  const id = (created.body as unknown as { id: number }).id
  const find = async (route: string) => ((await request(route, operatorToken)).body as unknown as { id: number; tags: unknown }[]).find(item => item.id === id)
  assert.deepEqual((await find(path))?.tags, tags)
  const publicBoard = await request('/api/v1/bsp/public/status', operatorToken)
  assert.deepEqual((publicBoard.body as unknown as { monitors: {id:number;tags:unknown}[] }).monitors.find(item => item.id === id)?.tags, tags)
  const changed = await request(`${path}/${id}`, operatorToken, 'PATCH', { name: 'Tagged service', version: 1, tags: [tags[1]] }, 'https://status.example', key())
  assert.equal(changed.response.status, 200)
  const stale = await request(`${path}/${id}`, operatorToken, 'PATCH', { name: 'Stale', version: 1, tags: [] }, 'https://status.example', key())
  assert.equal(stale.response.status, 409)
  assert.deepEqual((await find(path))?.tags, [tags[1]])
  const invalids = [[{ label: 'bad', color: 'red' }], [{ label: '', color: '#123456' }], Array.from({ length: 21 }, (_, i) => ({ label: `${i}`, color: '#123456' }))]
  for (const invalid of invalids) {
    const rejected = await request(`${path}/${id}`, operatorToken, 'PATCH', { name: 'Rejected', version: 2, tags: invalid }, 'https://status.example', key())
    assert.equal(rejected.response.status, 400)
  }
  const preserved = await request(`${path}/${id}`, operatorToken, 'PATCH', { name: 'Renamed', version: 2 }, 'https://status.example', key())
  assert.equal(preserved.response.status, 200)
  assert.deepEqual((await find(path))?.tags, [tags[1]])
  const cleared = await request(`${path}/${id}`, operatorToken, 'PATCH', { name: 'Renamed', version: 3, tags: [] }, 'https://status.example', key())
  assert.equal(cleared.response.status, 200)
  assert.deepEqual((await find(path))?.tags, [])
  const forbidden = await request(path, viewerToken, 'POST', { name: 'Forbidden', tags }, 'https://status.example', key())
  assert.equal(forbidden.response.status, 403)
})

test('concurrent vault key initialization binds one winner and rejects the other', async () => {
  const keys = ['ab'.repeat(32), 'cd'.repeat(32)]
  const results = await Promise.all(keys.map(key => vaultKeyReady(db as never, key)))
  assert.equal(results.filter(Boolean).length, 1)
  assert.deepEqual(await Promise.all(keys.map(key => vaultKeyReady(db as never,key))), results)
  await db.prepare('DELETE FROM vault_key_verifier').run()
})

test('local vault authorizes admins, encrypts values, rotates and deletes without exposing credentials', async () => {
  const base = '/api/v1/bsp/admin/vaults'
  const secret = 'sensitive-fixture-not-for-output'
  const rotated = 'replacement-fixture-not-for-output'
  env.VAULT_ENCRYPTION_KEY = 'ab'.repeat(32)
  try {
    assert.equal((await request(base, viewerToken)).response.status, 403)
    assert.equal((await request(base, operatorToken)).response.status, 403)
    assert.equal((await request(base, operatorToken, 'POST', {name:'bad'})).response.status, 403)
    assert.equal((await request(base, adminToken, 'POST', {name:'bad',type:'hashicorp'})).response.status, 400)
    const actor = await db.prepare("SELECT id,email,version FROM users WHERE subject='admin-id'").first<{id:string;email:string;version:number}>()
    assert.ok(actor)
    await assert.rejects(vaultApi(new Request('https://status.example', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'revoked'})}), db as never, env.VAULT_ENCRYPTION_KEY, {...actor,version:actor.version - 1}, '/admin/vaults'))
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM vaults WHERE name='revoked'").first<{count:number}>())?.count,0)
    const v = await request(base, adminToken, 'POST', {name:'test vault'})
    assert.equal(v.response.status, 201)
    const vault = v.body as unknown as { id:number }
    assert.equal((await request(base,adminToken,'POST',{name:'test vault'})).response.status,409)
    const other = (await request(base,adminToken,'POST',{name:'other vault'})).body as unknown as {id:number}
    assert.equal((await request(`${base}//secrets`,adminToken)).response.status,404)
    assert.equal((await request(`${base}/${vault.id}/secrets`,adminToken,'POST',{name:'bad',type:'userpass',userpass:{username:'alice'}})).response.status,400)
    assert.equal((await request(`${base}/${vault.id}/secrets`,adminToken,'POST',{name:'bad',type:'json',json:'['})).response.status,400)
    const pair = await request(`${base}/${vault.id}/secrets`,adminToken,'POST',{name:'pair',type:'userpass',userpass:{username:'alice',password:secret}})
    assert.equal(pair.response.status,201)
    const structured = await request(`${base}/${vault.id}/secrets`,adminToken,'POST',{name:'structured',type:'json',json:JSON.stringify({credential:secret})})
    assert.equal(structured.response.status,201)
    const c = await request(`${base}/${vault.id}/secrets`, adminToken, 'POST', {name:'test credential',type:'value',value:secret})
    assert.equal(c.response.status, 201)
    const metadata = c.body as unknown as {id:number;version:number}
    assert.equal((await request(`${base}/${vault.id}/secrets`,adminToken,'POST',{name:'test credential',type:'value',value:secret})).response.status,409)
    assert.equal((await request(`${base}/${other.id}/secrets/${metadata.id}`,adminToken,'DELETE')).response.status,404)
    assert.equal((await request(`${base}/${other.id}`,adminToken,'DELETE')).response.status,200)
    assert.equal(metadata.version,1)
    assert.doesNotMatch(JSON.stringify(c.body), /sensitive-fixture/)
    const stored = await db.prepare('SELECT ciphertext,nonce FROM vault_secrets WHERE id=?').bind(metadata.id).first<{ciphertext:string;nonce:string}>()
    assert.ok(stored)
    assert.doesNotMatch(JSON.stringify(stored), /sensitive-fixture/)
    assert.doesNotMatch(JSON.stringify((await request(`${base}/${vault.id}/secrets`, adminToken)).body), /sensitive-fixture/)
    assert.equal((await request(`${base}/${vault.id}/secrets/${metadata.id}/reveal`,adminToken)).response.status,404)
    assert.equal((await request(`${base}/${vault.id}/secrets/${metadata.id}`,adminToken,'PATCH',{version:2,value:rotated})).response.status,409)
    const update = await request(`${base}/${vault.id}/secrets/${metadata.id}`,adminToken,'PATCH',{version:1,value:rotated})
    assert.equal(update.response.status,200)
    assert.doesNotMatch(JSON.stringify(update.body), /replacement-fixture/)
    const after = await db.prepare('SELECT ciphertext,nonce FROM vault_secrets WHERE id=?').bind(metadata.id).first<{ciphertext:string;nonce:string}>()
    assert.ok(after)
    assert.notEqual(after.ciphertext,stored.ciphertext)
    assert.notEqual(after.nonce,stored.nonce)
    const bytes = Uint8Array.from(atob(after.ciphertext), c => c.charCodeAt(0))
    const nonce = Uint8Array.from(atob(after.nonce), c => c.charCodeAt(0))
    const key = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(0xab), 'AES-GCM', false, ['decrypt'])
    const plain = await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce,additionalData:new TextEncoder().encode(`status-vault-v1:${vault.id}:${metadata.id}:value`)},key,bytes)
    assert.equal(JSON.parse(new TextDecoder().decode(plain)).value,rotated)
    const audit = await db.prepare("SELECT details FROM audit_events WHERE entity_type IN ('vault','vault_secret')").all<{details:string}>()
    assert.doesNotMatch(JSON.stringify(audit), /sensitive-fixture|replacement-fixture/)
    const verifier = await db.prepare('SELECT nonce,ciphertext FROM vault_key_verifier WHERE id=1').first<{nonce:string;ciphertext:string}>()
    assert.ok(verifier)
    await db.prepare('DELETE FROM vault_key_verifier').run()
    assert.equal(await vaultKeyReady(db as never, 'cd'.repeat(32)),false)
    assert.equal(await db.prepare('SELECT id FROM vault_key_verifier').first(),null)
    await db.prepare('INSERT INTO vault_key_verifier (id,nonce,ciphertext) VALUES (1,?,?)').bind(verifier.nonce,verifier.ciphertext).run()
    env.VAULT_ENCRYPTION_KEY = 'cd'.repeat(32)
    const caps = (await request('/api/v1/bsp/capabilities',adminToken)).body as unknown as {vault:boolean; supportedRoutes:string[]}
    assert.equal(caps.vault,false)
    assert.ok(!caps.supportedRoutes.includes('/admin/vault'))
    assert.equal((await request(`${base}/${vault.id}/secrets/${metadata.id}`,adminToken,'PATCH',{version:2,value:'unrecoverable'})).response.status,503)
    assert.deepEqual(await db.prepare('SELECT ciphertext,nonce FROM vault_secrets WHERE id=?').bind(metadata.id).first(),after)
    env.VAULT_ENCRYPTION_KEY = 'ab'.repeat(32)
    assert.equal((await request(`${base}/${vault.id}/secrets/${metadata.id}`,adminToken,'DELETE',{version:1})).response.status,409)
    assert.equal((await request(`${base}/${vault.id}/secrets/${metadata.id}`,adminToken,'DELETE',{version:2})).response.status,200)
    assert.equal((await request(`${base}/${vault.id}`,adminToken,'DELETE')).response.status,200)
    assert.equal((await request(`${base}/${vault.id}/secrets`,adminToken)).response.status,404)
  } finally { delete env.VAULT_ENCRYPTION_KEY }
  assert.equal((await request(base,adminToken)).response.status,503)
})

test('monitor Vault Basic auth accepts only saved, authorized HTTPS references and tests the saved version', async () => {
  const key = () => `${Date.now()}.${crypto.randomUUID()}`
  env.VAULT_ENCRYPTION_KEY = 'ab'.repeat(32)
  env.MONITOR_AUTH_READY = 'true'
  env.ENDPOINTS = JSON.stringify([{ id:'basic-target', name:'Approved', url:'https://basic.example/' }, { id:'insecure-target', name:'Insecure', url:'http://private.internal/', binding:'PRIVATE',serviceId:'private-service' }])
  const base = '/api/v1/bsp/admin/vaults'
  try {
    const vault = await request(base,adminToken,'POST',{name:'monitor basic fixture'})
    assert.equal(vault.response.status,201)
    const vaultId = (vault.body as unknown as {id:number}).id
    const secret = await request(`${base}/${vaultId}/secrets`,adminToken,'POST',{name:'monitor auth',type:'userpass',userpass:{username:'synthetic',password:'noncredential-value'}})
    const secretId = (secret.body as unknown as {id:number}).id
    assert.equal(secret.response.status,201)
    const advanced = {method:'GET',timeoutMs:5000,attempts:1,auth:{type:'basic',basic:{vault:{vaultId,secretId}}}}
    const body = {name:'Basic check fixture',check:{endpointId:'basic-target',enabled:false,intervalMinutes:1,expectedStatus:200,advancedConfig:advanced}}
    assert.equal((await request('/api/v1/bsp/admin/monitors',operatorToken,'POST',body,'https://status.example',key())).response.status,403)
    const invalid = structuredClone(body); (invalid.check.advancedConfig.auth.basic as Record<string,unknown>).password = 'must-not-store'
    assert.equal((await request('/api/v1/bsp/admin/monitors',adminToken,'POST',invalid,'https://status.example',key())).response.status,400)
    const insecure = structuredClone(body); insecure.check.endpointId = 'insecure-target'
    assert.equal((await request('/api/v1/bsp/admin/monitors',adminToken,'POST',insecure,'https://status.example',key())).response.status,400)
    const created = await request('/api/v1/bsp/admin/monitors',adminToken,'POST',body,'https://status.example',key())
    assert.equal(created.response.status,201)
    const alias = (created.body as unknown as {id:number}).id
    const check = await db.prepare("SELECT h.id,h.config_version,h.advanced_config FROM http_checks h JOIN entity_aliases a ON a.entity_id=h.component_id WHERE a.entity_type='component' AND a.alias=?").bind(alias).first<{id:string;config_version:number;advanced_config:string}>()
    assert.ok(check)
    assert.deepEqual(JSON.parse(check.advanced_config),advanced)
    assert.doesNotMatch(JSON.stringify((await request('/api/v1/bsp/admin/checks',adminToken)).body),/noncredential-value/)
    const audits=await db.prepare("SELECT details FROM audit_events WHERE entity_type='check' AND entity_id=?").bind(check.id).all<{details:string}>()
    assert.doesNotMatch(JSON.stringify(audits),/noncredential-value|synthetic/)
    let forwarded: unknown
    env.PROBE = { fetch: async r => { forwarded = await r.json(); return Response.json({overall:'ok',steps:[],totalMs:1}) } }
    const test = {endpointId:'basic-target',expectedStatus:200,advancedConfig:advanced,checkId:check.id,checkVersion:check.config_version}
    assert.equal((await request('/api/v1/bsp/admin/monitors/test',viewerToken,'POST',test)).response.status,403)
    assert.equal((await request('/api/v1/bsp/admin/monitors/test',adminToken,'POST',{...test,checkVersion:check.config_version+1})).response.status,409)
    const passed = await request('/api/v1/bsp/admin/monitors/test',adminToken,'POST',test)
    assert.equal(passed.response.status,200)
    assert.deepEqual(forwarded,{checkId:check.id,checkVersion:check.config_version})
    assert.doesNotMatch(JSON.stringify(forwarded),/vaultId|secretId|noncredential/)

    // The editor supplies effective defaults even when the saved config is sparse.
    // These equivalent settings test the stored version without allowing draft edits.
    const otherSecret = await request(`${base}/${vaultId}/secrets`,adminToken,'POST',{name:'other auth',type:'userpass',userpass:{username:'other',password:'other-fixture'}})
    assert.equal(otherSecret.response.status,201)
    const otherSecretId=(otherSecret.body as unknown as {id:number}).id
    const sparse = { auth: advanced.auth }
    await db.prepare('UPDATE http_checks SET advanced_config=? WHERE id=?').bind(JSON.stringify(sparse),check.id).run()
    const sparseVersion=(await db.prepare('SELECT config_version FROM http_checks WHERE id=?').bind(check.id).first<{config_version:number}>())!.config_version
    const normalized = {...test,checkVersion:sparseVersion,advancedConfig:{...sparse,method:'GET',timeoutMs:10_000,attempts:1}}
    forwarded = undefined
    assert.equal((await request('/api/v1/bsp/admin/monitors/test',adminToken,'POST',normalized)).response.status,200)
    assert.deepEqual(forwarded,{checkId:check.id,checkVersion:sparseVersion})
    assert.equal((await request('/api/v1/bsp/admin/monitors/test',adminToken,'POST',{...normalized,checkVersion:sparseVersion-1})).response.status,409)
    assert.equal((await request('/api/v1/bsp/admin/monitors/test',adminToken,'POST',{...normalized,advancedConfig:{...normalized.advancedConfig,keyword:'unsaved'}})).response.status,409)
    assert.equal((await request('/api/v1/bsp/admin/monitors/test',adminToken,'POST',{...normalized,advancedConfig:{...normalized.advancedConfig,timeoutMs:5000}})).response.status,409)
    assert.equal((await request('/api/v1/bsp/admin/monitors/test',adminToken,'POST',{...normalized,expectedStatus:201})).response.status,409)
    assert.equal((await request('/api/v1/bsp/admin/monitors/test',adminToken,'POST',{...normalized,advancedConfig:{...normalized.advancedConfig,method:'HEAD'}})).response.status,409)
    assert.equal((await request('/api/v1/bsp/admin/monitors/test',adminToken,'POST',{...normalized,advancedConfig:{...normalized.advancedConfig,auth:{type:'basic',basic:{vault:{vaultId,secretId:otherSecretId}}}}})).response.status,409)
    assert.deepEqual(forwarded,{checkId:check.id,checkVersion:sparseVersion})
    await assert.rejects(db.prepare('UPDATE http_checks SET advanced_config=? WHERE id=?').bind(JSON.stringify({auth:{type:'basic',basic:{username:'not-allowed'}}}),check.id).run())
  } finally { delete env.PROBE; delete env.VAULT_ENCRYPTION_KEY; delete env.MONITOR_AUTH_READY; env.ENDPOINTS='[]' }
})

test('notifications capability and routes require explicit readiness and an Access administrator', async () => {
  env.VAULT_ENCRYPTION_KEY = 'ab'.repeat(32)
  env.CHANNEL_ENDPOINTS = JSON.stringify([{id:'sink',name:'Approved sink',url:'https://sink.example/'}])
  try {
    const capabilities = () => request('/api/v1/bsp/capabilities',adminToken)
    assert.equal((await capabilities()).body.notifications,false)
    assert.equal((await request('/api/v1/bsp/admin/notifications/channels',adminToken)).response.status,503)
    env.CHANNELS_READY = 'true'
    assert.equal((await capabilities()).body.notifications,true)
    assert.equal((await request('/api/v1/bsp/admin/notifications/channels',viewerToken)).response.status,403)
    assert.equal((await request('/api/v1/bsp/admin/notifications/channels',operatorToken)).response.status,403)
    assert.equal((await request('/api/v1/bsp/admin/notifications/channels',adminToken,'POST',{},'https://cross-origin.example')).response.status,403)
    assert.equal((await request('/api/v1/bsp/admin/notifications/channels',adminToken)).response.status,200)
    assert.equal((await request('/api/v1/bsp/admin/notifications/channels',adminToken,'POST',{})).response.status,400)
  } finally { delete env.VAULT_ENCRYPTION_KEY; delete env.CHANNEL_ENDPOINTS; delete env.CHANNELS_READY }
})


test('actions capability and routes require explicit readiness and an Access administrator', async () => {
  env.VAULT_ENCRYPTION_KEY = 'ab'.repeat(32)
  env.ACTION_ENDPOINTS = JSON.stringify([{id:'sink',name:'Approved action',url:'https://sink.example/'}])
  try {
    const capabilities = () => request('/api/v1/bsp/capabilities',adminToken)
    assert.equal((await capabilities()).body.actions,false)
    assert.equal((await request('/api/v1/bsp/admin/actions',adminToken)).response.status,503)
    env.ACTIONS_READY = 'true'
    assert.equal((await capabilities()).body.actions,true)
    assert.equal((await request('/api/v1/bsp/admin/actions',viewerToken)).response.status,403)
    assert.equal((await request('/api/v1/bsp/admin/actions',operatorToken)).response.status,403)
    assert.equal((await request('/api/v1/bsp/admin/actions',adminToken,'POST',{},'https://cross-origin.example')).response.status,403)
    assert.equal((await request('/api/v1/bsp/admin/actions',adminToken)).response.status,200)
    assert.equal((await request('/api/v1/bsp/admin/actions',adminToken,'POST',{})).response.status,400)
  } finally { delete env.VAULT_ENCRYPTION_KEY; delete env.ACTION_ENDPOINTS; delete env.ACTIONS_READY }
})

test('monitor alert selections persist atomically, including manual monitors, and reject stale changes', async () => {
  const key = () => `${Date.now()}.${crypto.randomUUID()}`
  const path = '/api/v1/bsp/admin/monitors'
  const channelA = crypto.randomUUID(), channelB = crypto.randomUUID(), missing = crypto.randomUUID()
  const now = Date.now()
  env.VAULT_ENCRYPTION_KEY = 'ab'.repeat(32)
  env.CHANNEL_ENDPOINTS = JSON.stringify([{ id: 'sink', name: 'Approved sink', url: 'https://sink.example/' }])
  env.CHANNELS_READY = 'true'
  env.ENDPOINTS = JSON.stringify([{ id: 'alert-test', name: 'Check target', url: 'https://example.test/' }])
  try {
    for (const [id, name, enabled] of [[channelA, 'Primary', 1], [channelB, 'Disabled', 0]] as const) {
      await db.prepare(`INSERT INTO notification_channels (id,name,endpoint_id,endpoint_fingerprint,vault_id,secret_id,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .bind(id,name,'sink','fixture',1,1,enabled,now,now).run()
    }
    const catalogue = await request('/api/v1/bsp/admin/monitor-alert-channels',adminToken)
    assert.equal(catalogue.response.status,200)
    const choices = catalogue.body as unknown as {id:string;name:string;type:string;enabled:boolean}[]
    assert.deepEqual(choices.filter(item => item.id === channelA || item.id === channelB), [
      { id:channelB,name:'Disabled',type:'webhook',enabled:false,available:false }, { id:channelA,name:'Primary',type:'webhook',enabled:true,available:false },
    ])
    assert.equal((await request('/api/v1/bsp/admin/monitor-alert-channels',operatorToken)).response.status,403)
    assert.equal((await request(path,operatorToken,'POST',{name:'Forbidden selection',channelIds:[channelA]},'https://status.example',key())).response.status,403)
    const createKey = key(), payload = {name:'Alert manual fixture',channelIds:[channelA]}
    const created = await request(path,adminToken,'POST',payload,'https://status.example',createKey)
    assert.equal(created.response.status,201)
    const id = (created.body as unknown as {id:number}).id
    const retry = await request(path,adminToken,'POST',payload,'https://status.example',createKey)
    assert.equal((retry.body as unknown as {id:number}).id,id)
    const find = async () => ((await request(path,adminToken)).body as unknown as {id:number;channelIds:string[]}[]).find(item => item.id === id)
    assert.deepEqual((await find())?.channelIds,[channelA])
    const check = {endpointId:'alert-test',enabled:false,intervalMinutes:1,expectedStatus:200}
    const addCheck = await request(`${path}/${id}`,adminToken,'PATCH',{name:'Alert manual fixture',version:1,check},'https://status.example',key())
    assert.equal(addCheck.response.status,200)
    const linked = await db.prepare(`SELECT cc.check_id FROM notification_channel_checks cc JOIN http_checks h ON h.id=cc.check_id JOIN entity_aliases a ON a.entity_id=h.component_id WHERE a.entity_type='component' AND a.alias=? AND cc.channel_id=?`).bind(id,channelA).first<{check_id:string}>()
    assert.ok(linked)
    const stale = await request(`${path}/${id}`,adminToken,'PATCH',{name:'Rejected',version:2,channelIds:[channelB],expectedChannelIds:[]},'https://status.example',key())
    assert.equal(stale.response.status,409)
    assert.deepEqual((await find())?.channelIds,[channelA])
    const invalid = await request(`${path}/${id}`,adminToken,'PATCH',{name:'Rejected',version:2,channelIds:[missing],expectedChannelIds:[channelA]},'https://status.example',key())
    assert.equal(invalid.response.status,409)
    const changed = await request(`${path}/${id}`,adminToken,'PATCH',{name:'Alert manual fixture',version:2,channelIds:[channelB],expectedChannelIds:[channelA]},'https://status.example',key())
    assert.equal(changed.response.status,200)
    assert.deepEqual((await find())?.channelIds,[channelB])
    assert.ok(await db.prepare('SELECT 1 FROM notification_channel_checks WHERE channel_id=? AND check_id=?').bind(channelB,linked.check_id).first())
    assert.equal(await db.prepare('SELECT 1 FROM notification_channel_checks WHERE channel_id=? AND check_id=?').bind(channelA,linked.check_id).first(),null)
    // Channel administration can update check links without touching component.version.
    await db.batch([
      db.prepare('DELETE FROM notification_channel_checks WHERE channel_id=? AND check_id=?').bind(channelB,linked.check_id),
      db.prepare('INSERT INTO notification_channel_checks (channel_id,check_id) VALUES (?,?)').bind(channelA,linked.check_id),
    ])
    const concurrent = await request(`${path}/${id}`,adminToken,'PATCH',{name:'Must not overwrite',version:3,channelIds:[],expectedChannelIds:[channelB]},'https://status.example',key())
    assert.equal(concurrent.response.status,409)
    assert.deepEqual((await find())?.channelIds,[channelA])
    const preserved = await request(`${path}/${id}`,operatorToken,'PATCH',{name:'Renamed',version:3},'https://status.example',key())
    assert.equal(preserved.response.status,200)
    assert.deepEqual((await find())?.channelIds,[channelA])
    const cleared = await request(`${path}/${id}`,adminToken,'PATCH',{name:'Renamed',version:4,channelIds:[],expectedChannelIds:[channelA]},'https://status.example',key())
    assert.equal(cleared.response.status,200)
    assert.deepEqual((await find())?.channelIds,[])
  } finally { delete env.VAULT_ENCRYPTION_KEY; delete env.CHANNEL_ENDPOINTS; delete env.CHANNELS_READY; env.ENDPOINTS='[]' }
})

test('channel association limit rejects concurrent monitor edits atomically', async () => {
  env.CHANNELS_READY='true';env.EMAIL_READY='true';env.EMAIL_FROM='sender@example.test'
  env.EMAIL_DESTINATIONS=JSON.stringify([{id:'ops',name:'Operations',address:'ops@example.test'}])
  env.EMAIL={send:async()=>({messageId:'fixture'})}
  try {
    const response=await request('/api/v1/bsp/admin/notifications/channels',adminToken,'POST',{name:'Association limit fixture',type:'email',recipientId:'ops',enabled:true,checkIds:[],expectedChecks:[]})
    const channel=(response.body as unknown as {id:string}).id
    const fixtures=Array.from({length:19},()=>crypto.randomUUID())
    await db.batch(fixtures.flatMap((id,index)=>[
      db.prepare('INSERT INTO components (id,name,updated_at) VALUES (?,?,?)').bind(id,`Limit ${index}`,Date.now()),
      db.prepare('INSERT INTO monitor_notification_channels (component_id,channel_id) VALUES (?,?)').bind(id,channel),
    ]))
    const key=()=>`${Date.now()}.${crypto.randomUUID()}`
    const path='/api/v1/bsp/admin/monitors'
    const results=await Promise.all(['Concurrent limit A','Concurrent limit B'].map(name=>request(path,adminToken,'POST',{name,channelIds:[channel]},'https://status.example',key())))
    assert.deepEqual(results.map(result=>result.response.status).sort(),[201,409])
    const rejected=results.find(result=>result.response.status===409)!
    assert.match((rejected.body as unknown as {error:string}).error,/at most 20 monitors/i)
    const count=await db.prepare('SELECT COUNT(*) AS n FROM monitor_notification_channels WHERE channel_id=?').bind(channel).first<{n:number}>()
    assert.equal(count?.n,20)
    const names=await db.prepare("SELECT name FROM components WHERE name IN ('Concurrent limit A','Concurrent limit B')").all<{name:string}>()
    assert.equal(names.results.length,1)
    const untouched=await request(path,adminToken,'POST',{name:'Unchanged limit fixture'},'https://status.example',key())
    const alias=(untouched.body as unknown as {id:number}).id
    const patch=await request(`${path}/${alias}`,adminToken,'PATCH',{name:'Must not persist',version:1,channelIds:[channel],expectedChannelIds:[]},'https://status.example',key())
    assert.equal(patch.response.status,409)
    const row=await db.prepare("SELECT c.name,c.version FROM components c JOIN entity_aliases a ON a.entity_id=c.id WHERE a.entity_type='component' AND a.alias=?").bind(alias).first<{name:string;version:number}>()
    assert.deepEqual(row && {...row},{name:'Unchanged limit fixture',version:1})
  } finally { delete env.EMAIL;delete env.EMAIL_READY;delete env.EMAIL_FROM;delete env.EMAIL_DESTINATIONS;delete env.CHANNELS_READY }
})

test('channel editor reports a full channel of manual monitors without partial changes', async () => {
  env.CHANNELS_READY='true';env.EMAIL_READY='true';env.EMAIL_FROM='sender@example.test'
  env.EMAIL_DESTINATIONS=JSON.stringify([{id:'ops',name:'Operations',address:'ops@example.test'}])
  env.EMAIL={send:async()=>({messageId:'fixture'})}
  try {
    const response=await request('/api/v1/bsp/admin/notifications/channels',adminToken,'POST',{name:'Full manual channel',type:'email',recipientId:'ops',enabled:true,checkIds:[],expectedChecks:[]})
    assert.equal(response.response.status,201)
    const channel=(response.body as unknown as {id:string;version:number}).id
    const fixtures=Array.from({length:20},()=>crypto.randomUUID())
    await db.batch(fixtures.flatMap((id,index)=>[
      db.prepare('INSERT INTO components (id,name,updated_at) VALUES (?,?,?)').bind(id,`Manual full ${index}`,Date.now()),
      db.prepare('INSERT INTO monitor_notification_channels (component_id,channel_id) VALUES (?,?)').bind(id,channel),
    ]))
    const component=crypto.randomUUID(),check=crypto.randomUUID()
    await db.batch([
      db.prepare('INSERT INTO components (id,name,updated_at) VALUES (?,?,?)').bind(component,'Extra checked monitor',Date.now()),
      db.prepare('INSERT INTO http_checks (id,component_id,endpoint_id,enabled,interval_minutes,expected_status) VALUES (?,?,?,0,1,200)').bind(check,component,'unused'),
    ])
    const edit=await request(`/api/v1/bsp/admin/notifications/channels/${channel}`,adminToken,'PATCH',{name:'Must not persist',type:'email',recipientId:'ops',enabled:true,checkIds:[check],expectedChecks:[{id:check,componentId:component,version:1}],version:1,expectedCheckIds:[],expectedAssociationVersion:20})
    assert.equal(edit.response.status,409)
    assert.match((edit.body as unknown as {error:string}).error,/at most 20 monitors/i)
    const unchanged=await db.prepare('SELECT name,version,association_version FROM notification_channels WHERE id=?').bind(channel).first<{name:string;version:number;association_version:number}>()
    assert.deepEqual(unchanged && {...unchanged},{name:'Full manual channel',version:1,association_version:20})
    assert.equal(await db.prepare('SELECT 1 FROM notification_channel_checks WHERE channel_id=? AND check_id=?').bind(channel,check).first(),null)
    const count=await db.prepare('SELECT COUNT(*) AS n FROM monitor_notification_channels WHERE channel_id=?').bind(channel).first<{n:number}>()
    assert.equal(count?.n,20)
  } finally { delete env.EMAIL;delete env.EMAIL_READY;delete env.EMAIL_FROM;delete env.EMAIL_DESTINATIONS;delete env.CHANNELS_READY }
})

test('email-only notifications expose admin catalog and persist monitor selection without Vault', async () => {
  const messages: unknown[] = []
  env.CHANNELS_READY = 'true'
  env.EMAIL_READY = 'true'
  env.EMAIL_FROM = 'sender@example.test'
  env.EMAIL_DESTINATIONS = JSON.stringify([{id:'operators',name:'Operators',address:'private@example.test'}])
  env.EMAIL = {send:async message => {messages.push(message);return {messageId:'fixture'}}}
  try {
    assert.equal((await request('/api/v1/bsp/capabilities',adminToken)).body.notifications,true)
    const channel = await request('/api/v1/bsp/admin/notifications/channels',adminToken,'POST',{name:'Email only fixture',type:'email',recipientId:'operators',enabled:false,checkIds:[],expectedChecks:[]})
    assert.equal(channel.response.status,201)
    const channelId = (channel.body as unknown as {id:string}).id
    const destinations = await request('/api/v1/bsp/admin/notifications/email-destinations',adminToken)
    assert.deepEqual(destinations.body,[{id:'operators',name:'Operators'}])
    const catalog = await request('/api/v1/bsp/admin/monitor-alert-channels',adminToken)
    assert.deepEqual((catalog.body as unknown as {id:string}[]).find(item=>item.id===channelId),{id:channelId,name:'Email only fixture',type:'email',enabled:false,available:true})
    assert.doesNotMatch(JSON.stringify(catalog.body),/private@example|endpointId|fingerprint|secretId|recipientId/)
    const unavailableWebhook=crypto.randomUUID()
    await db.prepare(`INSERT INTO notification_channels (id,name,endpoint_id,endpoint_fingerprint,vault_id,secret_id,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(unavailableWebhook,'Unavailable webhook','not-configured','private-fingerprint',0,0,1,Date.now(),Date.now()).run()
    const mixedCatalog=await request('/api/v1/bsp/admin/monitor-alert-channels',adminToken)
    assert.deepEqual((mixedCatalog.body as unknown as {id:string}[]).find(item=>item.id===unavailableWebhook),{id:unavailableWebhook,name:'Unavailable webhook',type:'webhook',enabled:true,available:false})
    assert.doesNotMatch(JSON.stringify(mixedCatalog.body),/private@example|not-configured|private-fingerprint/)
    env.EMAIL_DESTINATIONS=JSON.stringify([{id:'operators',name:'Operators',address:'changed@example.test'}])
    const drifted=await request('/api/v1/bsp/admin/monitor-alert-channels',adminToken)
    assert.deepEqual((drifted.body as unknown as {id:string}[]).find(item=>item.id===channelId),{id:channelId,name:'Email only fixture',type:'email',enabled:false,available:false})
    env.EMAIL_DESTINATIONS=JSON.stringify([{id:'operators',name:'Operators',address:'private@example.test'}])
    assert.equal((await request('/api/v1/bsp/admin/monitor-alert-channels',operatorToken)).response.status,403)
    const key=()=>`${Date.now()}.${crypto.randomUUID()}`
    const created = await request('/api/v1/bsp/admin/monitors',adminToken,'POST',{name:'Email selection fixture',channelIds:[channelId]},'https://status.example',key())
    assert.equal(created.response.status,201)
    const monitorId=(created.body as unknown as {id:number}).id
    const listed = await request('/api/v1/bsp/admin/monitors',adminToken)
    assert.deepEqual((listed.body as unknown as {id:number;channelIds:string[]}[]).find(item=>item.id===monitorId)?.channelIds,[channelId])
    const checkId=crypto.randomUUID(), sourceId=crypto.randomUUID(), movedId=crypto.randomUUID()
    await db.batch([
      db.prepare('INSERT INTO components (id,name,updated_at) VALUES (?,?,?)').bind(sourceId,'Identity source',Date.now()),
      db.prepare('INSERT INTO components (id,name,updated_at) VALUES (?,?,?)').bind(movedId,'Identity destination',Date.now()),
      db.prepare('INSERT INTO http_checks (id,component_id,endpoint_id,interval_minutes,expected_status) VALUES (?,?,?,?,?)').bind(checkId,sourceId,'unused',1,200),
    ])
    const checkCatalog=await request('/api/v1/bsp/admin/notifications/checks',adminToken)
    const checkSnapshot=(checkCatalog.body as unknown as {id:string;name:string;componentId:string;version:number}[]).find(item=>item.id===checkId)
    assert.deepEqual(checkSnapshot,{id:checkId,name:'Identity source',componentId:sourceId,version:1})
    await db.prepare('UPDATE http_checks SET component_id=?,config_version=config_version+1 WHERE id=?').bind(movedId,checkId).run()
    const staleChannel=await request(`/api/v1/bsp/admin/notifications/channels/${channelId}`,adminToken,'PATCH',{name:'Email only fixture',type:'email',recipientId:'operators',enabled:false,checkIds:[checkId],expectedChecks:[{id:checkId,componentId:sourceId,version:1}],version:1,expectedCheckIds:[],expectedAssociationVersion:1})
    assert.equal(staleChannel.response.status,409)
    const testSend=await request(`/api/v1/bsp/admin/notifications/channels/${channelId}/test`,adminToken,'POST',{version:1})
    assert.equal(testSend.response.status,200)
    assert.equal(messages.length,1)
    assert.equal((messages[0] as {to:string}).to,'private@example.test')
    env.EMAIL_READY='false'
    assert.equal((await request('/api/v1/bsp/capabilities',adminToken)).body.notifications,false)
    const refused=await request(`/api/v1/bsp/admin/monitors/${monitorId}`,adminToken,'PATCH',{name:'Refused',version:1,channelIds:[],expectedChannelIds:[channelId]},'https://status.example',key())
    assert.equal(refused.response.status,503)
    env.EMAIL_READY='true'
    const staleDelete=await request(`/api/v1/bsp/admin/notifications/channels/${channelId}`,adminToken,'DELETE',{version:1,expectedAssociationVersion:0})
    assert.equal(staleDelete.response.status,409)
    const cleared=await request(`/api/v1/bsp/admin/monitors/${monitorId}`,adminToken,'PATCH',{name:'Email selection fixture',version:1,channelIds:[],expectedChannelIds:[channelId]},'https://status.example',key())
    assert.equal(cleared.response.status,200)
    const removed=await request(`/api/v1/bsp/admin/notifications/channels/${channelId}`,adminToken,'DELETE',{version:1,expectedAssociationVersion:2})
    assert.equal(removed.response.status,200)
  } finally { delete env.EMAIL; delete env.EMAIL_READY; delete env.EMAIL_FROM; delete env.EMAIL_DESTINATIONS; delete env.CHANNELS_READY }
})

test('monitor alert catalog checks webhook credentials without disclosing them', async () => {
  const base='/api/v1/bsp/admin/vaults'
  const invalid='not a valid bearer token'
  env.VAULT_ENCRYPTION_KEY='ab'.repeat(32)
  env.CHANNELS_READY='true'
  env.CHANNEL_ENDPOINTS=JSON.stringify([{id:'approved-catalog',name:'Approved',url:'https://approved.example.test/'}])
  try {
    const vaultResponse=await request(base,adminToken,'POST',{name:'Catalog verifier vault'})
    assert.equal(vaultResponse.response.status,201)
    const vault=(vaultResponse.body as unknown as {id:number}).id
    const secretResponse=await request(`${base}/${vault}/secrets`,adminToken,'POST',{name:'Catalog test token',type:'value',value:invalid})
    assert.equal(secretResponse.response.status,201)
    const secret=(secretResponse.body as unknown as {id:number;version:number})
    const channelResponse=await request('/api/v1/bsp/admin/notifications/channels',adminToken,'POST',{name:'Invalid token channel',endpointId:'approved-catalog',vaultId:vault,secretId:secret.id,enabled:true,checkIds:[],expectedChecks:[]})
    assert.equal(channelResponse.response.status,201)
    const channel=(channelResponse.body as unknown as {id:string;version:number;associationVersion:number})
    const find=async () => {
      const result=await request('/api/v1/bsp/admin/monitor-alert-channels',adminToken)
      assert.doesNotMatch(JSON.stringify(result.body),/not a valid bearer token|approved\.example/)
      return (result.body as unknown as {id:string;available:boolean}[]).find(item=>item.id===channel.id)
    }
    assert.equal((await find())?.available,false)
    const rotate=await request(`${base}/${vault}/secrets/${secret.id}`,adminToken,'PATCH',{version:secret.version,value:'valid-bearer-token'})
    assert.equal(rotate.response.status,200)
    assert.equal((await find())?.available,true)
    const deleted=await request(`/api/v1/bsp/admin/notifications/channels/${channel.id}`,adminToken,'DELETE',{version:channel.version,expectedAssociationVersion:channel.associationVersion})
    assert.equal(deleted.response.status,200)
    assert.equal((await request(`${base}/${vault}/secrets/${secret.id}`,adminToken,'DELETE',{version:secret.version+1})).response.status,200)
    assert.equal((await request(`${base}/${vault}`,adminToken,'DELETE')).response.status,200)
  } finally { delete env.VAULT_ENCRYPTION_KEY; delete env.CHANNELS_READY; delete env.CHANNEL_ENDPOINTS }
})

test('a channel rename preserves queued work on the live linked check', async () => {
  env.CHANNELS_READY='true';env.EMAIL_READY='true';env.EMAIL_FROM='sender@example.test'
  env.EMAIL_DESTINATIONS=JSON.stringify([{id:'ops',name:'Operations',address:'ops@example.test'}])
  env.EMAIL={send:async()=>({messageId:'fixture'})}
  try {
    const channelResponse=await request('/api/v1/bsp/admin/notifications/channels',adminToken,'POST',{name:'Before rename',type:'email',recipientId:'ops',enabled:true,checkIds:[],expectedChecks:[]})
    assert.equal(channelResponse.response.status,201)
    const channel=channelResponse.body as unknown as {id:string;version:number;associationVersion:number}
    const key=()=>`${Date.now()}.${crypto.randomUUID()}`
    const monitorResponse=await request('/api/v1/bsp/admin/monitors',adminToken,'POST',{name:'Rename queue fixture',channelIds:[channel.id]},'https://status.example',key())
    const alias=(monitorResponse.body as unknown as {id:number}).id
    const component=await db.prepare("SELECT entity_id FROM entity_aliases WHERE entity_type='component' AND alias=?").bind(alias).first<{entity_id:string}>()
    assert.ok(component)
    const checkId=crypto.randomUUID()
    await db.prepare('INSERT INTO http_checks (id,component_id,endpoint_id,interval_minutes,expected_status) VALUES (?,?,?,?,?)').bind(checkId,component.entity_id,'unused',1,200).run()
    const now=Date.now()
    await db.prepare(`INSERT INTO notification_outbox (id,channel_id,channel_version,check_id,check_version,scheduled_at,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind('rename-queued-job',channel.id,channel.version,checkId,1,now,'down',now,now).run()
    await db.prepare(`INSERT INTO notification_delivery_state (channel_id,check_id,check_version,channel_version,status) VALUES (?,?,1,?,'down')`).bind(channel.id,checkId,channel.version).run()
    const renamed=await request(`/api/v1/bsp/admin/notifications/channels/${channel.id}`,adminToken,'PATCH',{name:'After rename',type:'email',recipientId:'ops',enabled:true,checkIds:[checkId],expectedChecks:[{id:checkId,componentId:component.entity_id,version:1}],expectedCheckIds:[checkId],expectedAssociationVersion:1,version:channel.version})
    assert.equal(renamed.response.status,200)
    assert.equal((renamed.body as unknown as {version:number}).version,2)
    assert.equal((await db.prepare('SELECT channel_version FROM notification_outbox WHERE id=?').bind('rename-queued-job').first<{channel_version:number}>())?.channel_version,2)
    assert.equal((await db.prepare('SELECT channel_version FROM notification_delivery_state WHERE channel_id=? AND check_id=?').bind(channel.id,checkId).first<{channel_version:number}>())?.channel_version,2)
  } finally { delete env.EMAIL;delete env.EMAIL_READY;delete env.EMAIL_FROM;delete env.EMAIL_DESTINATIONS;delete env.CHANNELS_READY }
})

test('atomic monitor check edits increment exactly once and fence stale results', async () => {
  const key=()=>`${Date.now()}.${crypto.randomUUID()}`
  const path='/api/v1/bsp/admin/monitors'
  env.ENDPOINTS=JSON.stringify([{id:'fence-a',name:'A',url:'https://a.example/'},{id:'fence-b',name:'B',url:'https://b.example/'}])
  try {
    await db.prepare('UPDATE http_checks SET enabled=0').run()
    const draft={endpointId:'fence-a',enabled:true,intervalMinutes:1,expectedStatus:200,advancedConfig:null as null | Record<string,unknown>}
    const created=await request(path,adminToken,'POST',{name:'Version fence fixture',check:draft},'https://status.example',key())
    assert.equal(created.response.status,201)
    const alias=(created.body as unknown as {id:number;version:number}).id
    let componentVersion=1
    const getCheck=()=>db.prepare("SELECT h.id,h.config_version,h.last_status FROM http_checks h JOIN entity_aliases a ON a.entity_id=h.component_id WHERE a.entity_type='component' AND a.alias=?").bind(alias).first<{id:string;config_version:number;last_status:string | null}>()
    let current=await getCheck(); assert.ok(current)
    const checkId=current.id
    const save=async (changes:Partial<typeof draft>, checkVersion=current!.config_version) => {
      const body={name:'Version fence fixture',version:componentVersion,check:{...draft,...changes,id:checkId,version:checkVersion}}
      const result=await request(`${path}/${alias}`,adminToken,'PATCH',body,'https://status.example',key())
      if(result.response.status===200) { componentVersion++; Object.assign(draft,changes) }
      return result
    }
    const initialVersion=current.config_version
    await db.prepare("UPDATE http_checks SET last_status='up',last_result_at=1,last_scheduled_at=1 WHERE id=?").bind(checkId).run()
    assert.equal((await save({advancedConfig:{method:'GET',keyword:'one'}})).response.status,200)
    current=await getCheck(); assert.equal(current!.config_version,initialVersion+1); assert.equal(current!.last_status,null)
    const staleResult=await db.prepare(`INSERT OR IGNORE INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status)
      SELECT id,config_version,100,100,'up' FROM http_checks WHERE id=? AND enabled=1 AND config_version=?`).bind(checkId,initialVersion).run() as {meta:{changes:number}}
    assert.equal(staleResult.meta.changes,0)
    const beforeStale=current!.config_version
    assert.equal((await save({expectedStatus:201},initialVersion)).response.status,409)
    current=await getCheck(); assert.equal(current!.config_version,beforeStale)
    assert.equal((await save({advancedConfig:{method:'GET',keyword:'two'},expectedStatus:201})).response.status,200)
    current=await getCheck(); assert.equal(current!.config_version,beforeStale+1)
    const beforeEndpoint=current!.config_version
    assert.equal((await save({endpointId:'fence-b'})).response.status,200)
    current=await getCheck(); assert.equal(current!.config_version,beforeEndpoint+1)
    const beforeNull=current!.config_version
    assert.equal((await save({advancedConfig:null})).response.status,200)
    current=await getCheck(); assert.equal(current!.config_version,beforeNull+1)
    const beforeNullOther=current!.config_version
    assert.equal((await save({intervalMinutes:5})).response.status,200)
    current=await getCheck(); assert.equal(current!.config_version,beforeNullOther+1)
    assert.equal((await save({})).response.status,200)
    current=await getCheck(); assert.equal(current!.config_version,beforeNullOther+1)
  } finally { env.ENDPOINTS='[]' }
})

test('static fallback requires an administrator and publishes the live reader data', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response()}}', r2Buckets: ['FALLBACK'] }))
  const fallbackEnv = env as typeof env & { FALLBACK_BUCKET?: unknown; FALLBACK_READY?: string }
  try {
    const bucket = await mf.getR2Bucket('FALLBACK')
    fallbackEnv.FALLBACK_BUCKET = bucket
    fallbackEnv.FALLBACK_READY = 'true'
    const path = '/api/v1/bsp/admin/static-mirror'
    assert.equal((await request(path, viewerToken)).response.status, 403)
    assert.equal((await request(path, operatorToken, 'PUT', { enabled: true, intervalSeconds: 60, settingsRevision: 'initial' })).response.status, 403)
    assert.equal((await request(path, adminToken, 'PUT', { enabled: true, intervalSeconds: 61, settingsRevision: 'initial' })).response.status, 400)
    assert.equal((await request(path, adminToken, 'PUT', { enabled: true, intervalSeconds: 60, settingsRevision: 'initial' }, 'https://attacker.example')).response.status, 403)
    assert.equal((await request(`${path}/check`, adminToken, 'POST', {})).response.status, 200)
    const saved = await request(path, adminToken, 'PUT', { enabled: true, intervalSeconds: 60, settingsRevision: 'initial' })
    assert.equal(saved.response.status, 200)
    assert.equal((saved.body as unknown as {health:string}).health, 'ok')
    const state = await (await bucket.get('fallback/current.json'))!.json() as {snapshot:{status:unknown; incidents:unknown[]}}
    const live = await request('/api/v1/bsp/public/status', viewerToken)
    assert.deepEqual(state.snapshot.status, live.body)
    assert.ok(state.snapshot.incidents.every(incident => !(incident as {draft?:boolean}).draft))
    const revision = (saved.body as unknown as {settingsRevision:string}).settingsRevision
    assert.equal((await request(path, adminToken, 'PUT', { enabled: false, intervalSeconds: 60, settingsRevision: 'initial' })).response.status, 409)
    assert.equal((await request(path, adminToken, 'PUT', { enabled: false, intervalSeconds: 60, settingsRevision: revision })).response.status, 200)
  } finally {
    delete fallbackEnv.FALLBACK_BUCKET
    delete fallbackEnv.FALLBACK_READY
    await mf.dispose()
  }
})

test('monitor dependencies are versioned, cycle checked, and administrator controlled', async () => {
  const path = '/api/v1/bsp/admin/monitors'
  const mutation = () => `${Date.now()}.${crypto.randomUUID()}`
  const create = async (name: string, dependsOnIds: number[] = []) => request(path, adminToken, 'POST', { name, manualStatus: 'operational', position: 0, dependsOnIds }, 'https://status.example', mutation())
  const first = await create('Dependency first')
  assert.equal(first.response.status, 201)
  const a = first.body.id as number
  const second = await create('Dependency second', [a])
  assert.equal(second.response.status, 201)
  const b = second.body.id as number
  const list = await request(path, adminToken)
  const rows = list.body as unknown as Array<{id:number;dependsOnIds:number[]}>
  assert.deepEqual(rows.find(row => row.id === b)?.dependsOnIds, [a])
  const edit = { name: 'Dependency first', manualStatus: 'operational', position: 0, version: 1, dependsOnIds: [b] }
  assert.equal((await request(`${path}/${a}`, operatorToken, 'PATCH', edit, 'https://status.example', mutation())).response.status, 403)
  assert.equal((await request(`${path}/${a}`, adminToken, 'PATCH', edit, 'https://status.example', mutation())).response.status, 400)
  const unchanged = await request(path, adminToken)
  assert.deepEqual((unchanged.body as unknown as Array<{id:number;dependsOnIds:number[]}>).find(row => row.id === b)?.dependsOnIds, [a])
  assert.equal((await request(`${path}/${b}`, adminToken, 'PATCH', { name: 'Dependency second', manualStatus: 'operational', position: 0, version: 1, dependsOnIds: [] }, 'https://status.example', mutation())).response.status, 200)
  assert.equal((await request(`${path}/${a}`, adminToken, 'PATCH', { ...edit, dependsOnIds: [a] }, 'https://status.example', mutation())).response.status, 400)
  assert.equal((await request(`${path}/${a}`, adminToken, 'PATCH', { ...edit, dependsOnIds: [b, b] }, 'https://status.example', mutation())).response.status, 400)
  const concurrent = await Promise.all([
    request(`${path}/${a}`, adminToken, 'PATCH', edit, 'https://status.example', mutation()),
    request(`${path}/${b}`, adminToken, 'PATCH', { name: 'Dependency second', manualStatus: 'operational', position: 0, version: 2, dependsOnIds: [a] }, 'https://status.example', mutation()),
  ])
  assert.deepEqual(concurrent.map(result => result.response.status).sort(), [200, 400])
})

test('static fallback settings require a durable authorized audit attempt', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response()}}', r2Buckets: ['FALLBACK'] }))
  const fallbackEnv = env as typeof env & { FALLBACK_BUCKET?: unknown; FALLBACK_READY?: string }
  const originalDb = env.DB
  const admin = await db.prepare('SELECT id,role,version FROM users WHERE subject=?').bind('admin-id').first<{id:string;role:string;version:number}>()
  assert.ok(admin)
  const bucket = await mf.getR2Bucket('FALLBACK')
  const path = '/api/v1/bsp/admin/static-mirror'
  try {
    fallbackEnv.FALLBACK_BUCKET = bucket
    fallbackEnv.FALLBACK_READY = 'true'
    let mode: 'attempt-fails' | 'demoted' | 'completion-fails' = 'attempt-fails'
    env.DB = {
      prepare(sql: string) {
        const statement = originalDb.prepare(sql)
        return {
          bind(...values: unknown[]) {
            const bound = statement.bind(...values)
            return {
              bind: (...more: unknown[]) => bound.bind(...more),
              first: <T = Record<string, unknown>>() => bound.first<T>(),
              all: <T>() => bound.all<T>(),
              run: async () => {
                if (sql.includes("'update_attempt','static_mirror'")) {
                  if (mode === 'attempt-fails') throw new Error('simulated database outage')
                  if (mode === 'demoted') await db.prepare("UPDATE users SET role='viewer',version=version+1 WHERE id=?").bind(admin.id).run()
                } else if (sql.startsWith('INSERT INTO audit_events (id, actor_email') && mode === 'completion-fails') {
                  throw new Error('simulated completion audit outage')
                }
                return bound.run()
              },
            }
          },
          first: <T = Record<string, unknown>>() => statement.first<T>(),
          all: <T>() => statement.all<T>(),
          run: () => statement.run(),
        }
      },
      batch: originalDb.batch.bind(originalDb),
    }
    assert.equal((await request(path, adminToken, 'PUT', { enabled: true, intervalSeconds: 60, settingsRevision: 'initial' })).response.status, 503)
    assert.equal(await bucket.get('fallback/current.json'), null)
    mode = 'demoted'
    assert.equal((await request(path, adminToken, 'PUT', { enabled: true, intervalSeconds: 60, settingsRevision: 'initial' })).response.status, 403)
    assert.equal(await bucket.get('fallback/current.json'), null)
    await db.prepare('UPDATE users SET role=?,version=? WHERE id=?').bind(admin.role, admin.version, admin.id).run()
    mode = 'completion-fails'
    const response = await request(path, adminToken, 'PUT', { enabled: true, intervalSeconds: 60, settingsRevision: 'initial' })
    assert.equal(response.response.status, 200)
    const state = await (await bucket.get('fallback/current.json'))!.json() as { enabled:boolean }
    assert.equal(state.enabled, true)
    const attempt = await db.prepare("SELECT action FROM audit_events WHERE action='update_attempt' AND entity_type='static_mirror' ORDER BY rowid DESC LIMIT 1").first<{action:string}>()
    assert.equal(attempt?.action, 'update_attempt')
  } finally {
    env.DB = originalDb
    delete fallbackEnv.FALLBACK_BUCKET
    delete fallbackEnv.FALLBACK_READY
    await db.prepare('UPDATE users SET role=?,version=? WHERE id=?').bind(admin.role, admin.version, admin.id).run()
    await mf.dispose()
  }
})

test('saved Vault header tests do not require the monitoring API to hold the Vault key', async () => {
  const endpoint = { id: 'vault-header-api', name: 'Vault header target', url: 'https://example.com/health', requestPolicy: { allowPost: true, plaintextHeaders: [], vaultHeaders: ['x-token'] } }
  env.ENDPOINTS = JSON.stringify([endpoint])
  env.MONITOR_REQUEST_READY = 'true'
  env.MONITOR_AUTH_READY = 'true'
  env.VAULT_ENCRYPTION_KEY = 'ab'.repeat(32)
  let forwarded: unknown
  let vaultId: number | undefined
  let secretId: number | undefined
  env.PROBE = { async fetch(request) { forwarded = await request.json(); return Response.json({ overall: 'ok', steps: [], totalMs: 1 }) } }
  try {
    const vault = await request('/api/v1/bsp/admin/vaults', adminToken, 'POST', { name: 'Header test vault' })
    vaultId = Number(vault.body.id)
    const secret = await request(`/api/v1/bsp/admin/vaults/${vault.body.id}/secrets`, adminToken, 'POST', { name: 'Header test value', type: 'value', value: 'synthetic' })
    assert.equal(secret.response.status, 201)
    secretId = Number(secret.body.id)
    const component = await request('/api/v1/admin/components', operatorToken, 'POST', { name: 'Vault header test' })
    const check = await request('/api/v1/admin/checks', adminToken, 'POST', { componentId: component.body.id, endpointId: endpoint.id, enabled: false, intervalMinutes: 1, expectedStatus: 200 })
    const advancedConfig = { method: 'POST', vaultHeaders: { 'x-token': { vaultId: vault.body.id, secretId: secret.body.id } } }
    const saved = await request(`/api/v1/bsp/admin/checks/${check.body.id}/advanced`, adminToken, 'PUT', { version: 1, advancedConfig })
    assert.equal(saved.response.status, 200)
    delete env.VAULT_ENCRYPTION_KEY
    const tested = await request('/api/v1/bsp/admin/monitors/test', adminToken, 'POST', { endpointId: endpoint.id, expectedStatus: 200, advancedConfig, checkId: check.body.id, checkVersion: 2 })
    assert.equal(tested.response.status, 200)
    assert.deepEqual(forwarded, { checkId: check.body.id, checkVersion: 2 })
  } finally {
    if (secretId) await db.prepare('DELETE FROM vault_secrets WHERE id=?').bind(secretId).run()
    if (vaultId) await db.prepare('DELETE FROM vaults WHERE id=?').bind(vaultId).run()
    await db.prepare('DELETE FROM vault_key_verifier').run()
    delete env.PROBE; delete env.VAULT_ENCRYPTION_KEY; delete env.MONITOR_AUTH_READY; delete env.MONITOR_REQUEST_READY; env.ENDPOINTS = '[]'
  }
})

test('publication fails before writes when requested subscriber delivery is unavailable', async () => {
  const incident = await request('/api/v1/bsp/admin/incidents', operatorToken, 'POST', {title:'Unavailable delivery test',body:'Opening',impact:'minor',status:'investigating',draft:false,monitorIds:[],notifySubscribers:true})
  assert.equal(incident.response.status,503)
  const maintenance = await request('/api/v1/bsp/admin/maintenance', operatorToken, 'POST', {name:'Unavailable delivery test',description:'',startsAt:Date.now()+60_000,endsAt:Date.now()+120_000,monitorIds:[],notifySubscribers:true})
  assert.equal(maintenance.response.status,503)
  const stored = await db.prepare("SELECT count(*) AS n FROM incidents WHERE title='Unavailable delivery test'").first<{n:number}>()
  assert.equal(stored?.n,0)
})

test('subscriber routes enforce Access identity, roles, origin and capability gates', async () => {
  const subscriberConfig = {
    SUBSCRIBERS_READY: 'true', SUBSCRIBER_EMAIL_READY: 'true',
    SUBSCRIBER_EMAIL_FROM: 'sender@example.com', SUBSCRIBER_PUBLIC_URL: 'https://status.example',
    SUBSCRIBER_EMAIL_DESTINATIONS: JSON.stringify([{id:'viewer',name:'Viewer',address:'viewer@example.com'}]),
    SUBSCRIBER_EMAIL: { send: async () => ({messageId:'test'}) },
  }
  const mutable = env as typeof env & Partial<typeof subscriberConfig>
  Object.assign(mutable, subscriberConfig)
  try {
    await db.prepare('UPDATE subscription_settings SET enabled=1,allow_email=1 WHERE id=1').run()
    assert.equal((await request('/api/v1/bsp/public/subscriptions/options')).response.status,401)
    assert.equal((await request('/api/v1/bsp/admin/subscribers/search',viewerToken,'POST',{})).response.status,403)
    assert.equal((await request('/api/v1/bsp/admin/subscribers/search',operatorToken,'POST',{})).response.status,200)
    const enrollment = {type:'email',email:'viewer@example.com',events:['incident.created'],monitorIds:[],tags:[]}
    assert.equal((await request('/api/v1/bsp/public/subscriptions',viewerToken,'POST',enrollment,'https://wrong.example')).response.status,403)
    assert.equal((await request('/api/v1/bsp/public/subscriptions',viewerToken,'POST',enrollment)).response.status,202)
    assert.equal((await request('/api/v1/bsp/public/subscriptions/preferences',operatorToken,'POST',{})).response.status,404)
    mutable.SUBSCRIBERS_READY = 'false'
    assert.equal((await request('/api/v1/bsp/public/subscriptions/preferences',viewerToken,'POST',{})).response.status,503)
  } finally {
    await db.prepare('DELETE FROM subscribers').run()
    await db.prepare('UPDATE subscription_settings SET enabled=0,allow_email=0 WHERE id=1').run()
    for (const key of Object.keys(subscriberConfig) as Array<keyof typeof subscriberConfig>) delete mutable[key]
  }
})

test('disabled subscription settings do not advertise or accept subscriber delivery', async () => {
  const configured = {
    SUBSCRIBERS_READY:'true', SUBSCRIBER_EMAIL_READY:'true', SUBSCRIBER_EMAIL_FROM:'sender@example.com',
    SUBSCRIBER_PUBLIC_URL:'https://status.example',
    SUBSCRIBER_EMAIL_DESTINATIONS:JSON.stringify([{id:'viewer',name:'Viewer',address:'viewer@example.com'}]),
    SUBSCRIBER_EMAIL:{ send:async () => ({messageId:'test'}) },
  }
  const mutable = env as typeof env & Partial<typeof configured>
  Object.assign(mutable,configured)
  try {
    await db.prepare('UPDATE subscription_settings SET enabled=0,allow_email=1 WHERE id=1').run()
    const caps = await request('/api/v1/bsp/capabilities',operatorToken)
    assert.equal((caps.body as unknown as {subscriberDelivery:boolean}).subscriberDelivery,false)
    const incident = await request('/api/v1/bsp/admin/incidents',operatorToken,'POST',{title:'Disabled subscription test',body:'Opening',impact:'minor',status:'investigating',draft:false,monitorIds:[],notifySubscribers:true})
    assert.equal(incident.response.status,503)
    await db.prepare('UPDATE subscription_settings SET enabled=1 WHERE id=1').run()
    assert.equal(((await request('/api/v1/bsp/capabilities',operatorToken)).body as unknown as {subscriberDelivery:boolean}).subscriberDelivery,true)
  } finally {
    await db.prepare('UPDATE subscription_settings SET enabled=0,allow_email=0 WHERE id=1').run()
    for (const key of Object.keys(configured) as Array<keyof typeof configured>) delete mutable[key]
  }
})

test('preview publication atomically queues only its lease-scoped subscribers', async () => {
  const a = 'a'.repeat(64), b = 'b'.repeat(64)
  const configured = {
    PREVIEW_SUBSCRIBER_REQUIRED:'true', PREVIEW_SUBSCRIBER_SCOPE:a,
    SUBSCRIBERS_READY:'true', SUBSCRIBER_EMAIL_READY:'true', SUBSCRIBER_EMAIL_FROM:'sender@example.com',
    SUBSCRIBER_PUBLIC_URL:'https://status.example',
    SUBSCRIBER_EMAIL_DESTINATIONS:JSON.stringify([{id:'viewer',name:'Viewer',address:'viewer@example.com'}]),
    SUBSCRIBER_EMAIL:{ send:async () => ({messageId:'test'}) },
  }
  const mutable = env as typeof env & Partial<typeof configured>
  Object.assign(mutable,configured)
  let maintenanceId = ''
  let secondMaintenanceId = ''
  const key = `${Date.now()}.${crypto.randomUUID()}`
  try {
    const viewer = await db.prepare("SELECT id FROM users WHERE subject='viewer-id'").first<{id:string}>()
    assert.ok(viewer)
    await db.prepare("INSERT INTO audit_events (id,actor_email,action,entity_type,entity_id,created_at,details) VALUES ('baseline-audit-fixture','tester@example.com','create','maintenance','baseline-audit-fixture',?,'{}')").bind(Date.now()).run()
    await assert.rejects(() => db.batch([
      db.prepare("INSERT INTO preview_audit_events (id,preview_scope,actor_email,action,entity_type,entity_id,created_at,details) VALUES ('rollback-preview-audit',?,'tester@example.com','create','maintenance','rollback-preview-audit',?,'{}')").bind(a,Date.now()),
      db.prepare("INSERT INTO audit_events (id,actor_email,action,entity_type,entity_id,created_at,details) VALUES ('baseline-audit-fixture','tester@example.com','create','maintenance','duplicate',?,'{}')").bind(Date.now()),
    ]))
    assert.equal(await db.prepare("SELECT id FROM preview_audit_events WHERE id='rollback-preview-audit'").first(),null)
    assert.equal(await db.prepare("SELECT id FROM audit_events WHERE id='rollback-preview-audit'").first(),null)
    await db.prepare("INSERT INTO preview_subscription_settings(scope,enabled,allow_email) VALUES (?,1,1)").bind(a).run()
    for (const [scope,slot] of [[a,1],[b,2]] as const) await db.prepare("INSERT INTO preview_subscriber_leases(scope,slot,target,release,expires_at) VALUES (?,?,'a',?,?)").bind(scope,slot,'c'.repeat(40),Date.now()+60000).run()
    for (const scope of [a,b]) await db.prepare("INSERT INTO preview_subscribers(scope,user_id,email,status,events,monitor_ids,created_at,updated_at) VALUES (?,?,'viewer@example.com','active','[\"maintenance.scheduled\"]','[]',0,0)").bind(scope,viewer.id).run()
    const publication = {name:'Scoped publication test',description:'',startsAt:Date.now()+60_000,endsAt:Date.now()+120_000,monitorIds:[],notifySubscribers:true}
    const result = await request('/api/v1/bsp/admin/maintenance',operatorToken,'POST',publication,undefined,key)
    assert.equal(result.response.status,201)
    const fixture = await db.prepare("SELECT id FROM maintenance WHERE name='Scoped publication test'").first<{id:string}>()
    assert.ok(fixture)
    maintenanceId = fixture.id
    assert.equal((await db.prepare("SELECT preview_scope FROM preview_audit_events WHERE entity_type='maintenance' AND entity_id=? AND action='create'").bind(maintenanceId).first<{preview_scope:string}>())?.preview_scope,a)
    const jobs = await db.prepare('SELECT scope,event_id FROM preview_subscriber_deliveries').all<{scope:string;event_id:string}>()
    assert.deepEqual(jobs.results.map(row => ({...row})),[{scope:a,event_id:maintenanceId}])
    assert.equal((await db.prepare('SELECT count(*) AS n FROM subscriber_deliveries').first<{n:number}>())?.n,0)
    const replay = await request('/api/v1/bsp/admin/maintenance',operatorToken,'POST',publication,undefined,key)
    assert.equal(replay.response.status,201)
    assert.equal(replay.body.id,result.body.id)
    mutable.PREVIEW_SUBSCRIBER_SCOPE = b
    const rejected = await request('/api/v1/bsp/admin/maintenance',operatorToken,'POST',{name:'Blocked scoped publication test',description:'',startsAt:Date.now()+60_000,endsAt:Date.now()+120_000,monitorIds:[],notifySubscribers:true})
    assert.equal(rejected.response.status,503)
    assert.equal((await db.prepare("SELECT count(*) AS n FROM maintenance WHERE name='Blocked scoped publication test'").first<{n:number}>())?.n,0)
    await db.prepare("INSERT INTO preview_subscription_settings(scope,enabled,allow_email) VALUES (?,1,1)").bind(b).run()
    const other = await request('/api/v1/bsp/admin/maintenance',operatorToken,'POST',publication,undefined,key)
    assert.equal(other.response.status,201)
    assert.notEqual(other.body.id,result.body.id)
    const secondJob = await db.prepare('SELECT event_id FROM preview_subscriber_deliveries WHERE scope=?').bind(b).first<{event_id:string}>()
    assert.ok(secondJob)
    secondMaintenanceId = secondJob.event_id
    assert.equal((await db.prepare("SELECT preview_scope FROM preview_audit_events WHERE entity_type='maintenance' AND entity_id=? AND action='create'").bind(secondMaintenanceId).first<{preview_scope:string}>())?.preview_scope,b)
    const auditLog = (await request('/api/v1/bsp/admin/audit-log?limit=100',adminToken)).body as unknown as {entries:Array<{entityId:string;entityType:string;diff:{previewScope?:string}}>}
    assert.ok(auditLog.entries.some(entry => entry.entityId === 'baseline-audit-fixture'))
    assert.equal(auditLog.entries.find(entry => entry.entityId === maintenanceId)?.entityType,'preview_slot_1_maintenance')
    assert.equal(auditLog.entries.find(entry => entry.entityId === maintenanceId)?.diff.previewScope,undefined)
    assert.equal(auditLog.entries.find(entry => entry.entityId === secondMaintenanceId)?.diff.previewScope,b)
    mutable.PREVIEW_SUBSCRIBER_SCOPE = a
    const firstLog = (await request('/api/v1/bsp/admin/audit-log?limit=100',adminToken)).body as unknown as typeof auditLog
    assert.ok(firstLog.entries.some(entry => entry.entityId === 'baseline-audit-fixture'))
    assert.equal(firstLog.entries.find(entry => entry.entityId === maintenanceId)?.diff.previewScope,a)
    assert.equal(firstLog.entries.filter(entry => entry.entityId === maintenanceId).length,1)
    assert.equal(firstLog.entries.find(entry => entry.entityId === secondMaintenanceId)?.entityType,'preview_slot_2_maintenance')
    assert.equal(firstLog.entries.find(entry => entry.entityId === secondMaintenanceId)?.diff.previewScope,undefined)
    delete mutable.PREVIEW_SUBSCRIBER_SCOPE
    delete mutable.PREVIEW_SUBSCRIBER_REQUIRED
    const baselineLog = (await request('/api/v1/bsp/admin/audit-log?limit=100',adminToken)).body as unknown as typeof auditLog
    assert.ok(baselineLog.entries.some(entry => entry.entityId === 'baseline-audit-fixture'))
    for (const [eventId,expectedType] of [[maintenanceId,'preview_slot_1_maintenance'],[secondMaintenanceId,'preview_slot_2_maintenance']] as const) {
      const event = baselineLog.entries.find(entry => entry.entityId === eventId)
      assert.equal(event?.entityType,expectedType)
      assert.equal(event?.diff.previewScope,undefined)
    }
    assert.notEqual(secondMaintenanceId,maintenanceId)
  } finally {
    await db.prepare('DELETE FROM preview_subscriber_deliveries').run()
    await db.prepare('DELETE FROM preview_subscribers').run()
    await db.prepare('DELETE FROM preview_subscription_settings').run()
    await db.prepare('DELETE FROM preview_subscriber_leases').run()
    await db.prepare("DELETE FROM audit_events WHERE id='baseline-audit-fixture'").run()
    await db.prepare("DELETE FROM audit_events WHERE id='rollback-preview-audit'").run()
    await db.prepare('DELETE FROM preview_audit_events WHERE preview_scope IN (?,?)').bind(a,b).run()
    await db.prepare("DELETE FROM audit_events WHERE entity_id IN (?,?) AND entity_type IN ('preview_slot_1_maintenance','preview_slot_2_maintenance')").bind(maintenanceId,secondMaintenanceId).run()
    if (maintenanceId) await db.prepare('DELETE FROM maintenance WHERE id=?').bind(maintenanceId).run()
    if (secondMaintenanceId) await db.prepare('DELETE FROM maintenance WHERE id=?').bind(secondMaintenanceId).run()
    await db.prepare('DELETE FROM mutation_receipts WHERE request_key IN (?,?)').bind(`preview:${a}:${key}`,`preview:${b}:${key}`).run()
    for (const key of Object.keys(configured) as Array<keyof typeof configured>) delete mutable[key]
  }
})

test('delivery history requires Access and administrator permissions even when dispatch is disabled', async () => {
  const path = '/api/v1/bsp/admin/delivery-history/notifications'
  assert.equal((await request(path)).response.status, 401)
  assert.equal((await request(path, viewerToken)).response.status, 403)
  assert.equal((await request(path, operatorToken)).response.status, 403)
  assert.equal((await request(path, adminToken)).response.status, 200)
  assert.equal((await request(`${path}?page=0`, adminToken)).response.status, 400)
  assert.equal((await request(`${path}/missing/retry`, adminToken, 'POST', {}, 'https://other.example')).response.status, 403)
  const capability = await request('/api/v1/bsp/capabilities', adminToken)
  assert.ok((capability.body as unknown as {supportedRoutes:string[]}).supportedRoutes.includes('/admin/delivery-history'))
})
