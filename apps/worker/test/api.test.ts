import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import worker from '../src/index.ts'
import { endpointFingerprint } from '../src/endpoint-config.ts'

// This adapter executes actual SQLite statements, including atomic batches, to
// exercise the API independently of a running Cloudflare account.
class SQLiteStatement {
  private values: unknown[] = []
  constructor(private sql: string, private database: DatabaseSync) {}
  bind(...values: unknown[]) { this.values = values; return this }
  async run() {
    const result = this.database.prepare(this.sql).run(...this.values as never[])
    return { success: true, meta: { changes: Number(result.changes) } }
  }
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
      for (const statement of statements) result.push(await statement.run())
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
const env = { DB: db, ASSETS: { fetch: async () => new Response('asset') }, ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com', ACCESS_AUD: audience, ENDPOINTS: '[]' }
const originalFetch = globalThis.fetch
const keySets = new Map<string, object[]>()
const keyFetches = new Map<string, number>()
let sign: (subject: string, email: string, aud?: string, expires?: string) => Promise<string>
let adminToken: string, operatorToken: string, viewerToken: string

async function request(path: string, token?: string, method = 'GET', body?: unknown, origin = 'https://status.example') {
  const headers: Record<string, string> = {}
  if (token) headers['Cf-Access-Jwt-Assertion'] = token
  if (method !== 'GET') { headers.origin = origin; headers['content-type'] = 'application/json' }
  const response = await worker.fetch(new Request(`https://status.example${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env as never)
  return { response, body: await response.json() as TestResponseBody }
}

before(async () => {
  if (process.env['USE_WORKERS_D1']) {
    miniflare = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response()}}', d1Databases: ['DB'] }))
    db = await miniflare.getD1Database('DB') as unknown as TestDatabase
    env.DB = db
    for (const file of ['0001_board.sql', '0002_checks.sql', '0003_endpoint_registry.sql', '0004_aliases.sql']) {
      const sql = readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8')
      const parts = sql.split(/(?=CREATE TRIGGER )/)
      const statements = parts.shift()!.split(';').map(value => value.trim()).filter(Boolean)
      statements.push(...parts.map(value => value.trim()).filter(Boolean))
      await db.batch(statements.map(statement => db.prepare(statement)))
    }
  } else {
    sqlite.db.exec(readFileSync(new URL('../migrations/0001_board.sql', import.meta.url), 'utf8'))
    sqlite.db.exec(readFileSync(new URL('../migrations/0002_checks.sql', import.meta.url), 'utf8'))
    sqlite.db.exec(readFileSync(new URL('../migrations/0003_endpoint_registry.sql', import.meta.url), 'utf8'))
    sqlite.db.exec(readFileSync(new URL('../migrations/0004_aliases.sql', import.meta.url), 'utf8'))
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
  assert.equal((await request(`/api/v1/admin/checks/${created.body.id}`, adminToken, 'PATCH', { ...config, endpointId: 'api', expectedStatus: 204, version: 1 })).response.status, 200)
  const audits = Number((await db.prepare('SELECT count(*) AS count FROM audit_events').first())?.count)
  assert.equal((await request(`/api/v1/admin/checks/${created.body.id}`, adminToken, 'PATCH', { ...config, endpointId: 'api', version: 1 })).response.status, 409)
  assert.equal(Number((await db.prepare('SELECT count(*) AS count FROM audit_events').first())?.count), audits)
  assert.equal(Number((await db.prepare('SELECT expected_status FROM http_checks WHERE id=?').bind(created.body.id).first())?.expected_status), 204)
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
