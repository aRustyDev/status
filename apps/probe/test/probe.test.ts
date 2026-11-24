import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { buildSyncSql } from '../scripts/sync-endpoints.ts'
import worker, { runChecks } from '../src/index.ts'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

function fixture(count = 1) {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(readFileSync(new URL('../../worker/migrations/0001_board.sql', import.meta.url), 'utf8'))
  sqlite.exec(readFileSync(new URL('../../worker/migrations/0002_checks.sql', import.meta.url), 'utf8'))
  sqlite.exec(readFileSync(new URL('../../worker/migrations/0003_endpoint_registry.sql', import.meta.url), 'utf8'))
  sqlite.exec(readFileSync(new URL('../../worker/migrations/0006_advanced_http.sql', import.meta.url), 'utf8'))
  const now = 1_800_000_000_000
  const endpoints = []
  for (let i = 0; i < count; i++) {
    sqlite.prepare('INSERT INTO components(id,name,updated_at) VALUES (?,?,?)').run(`component-${i}`, `Component ${i}`, now)
    sqlite.prepare('INSERT INTO http_checks(id,component_id,endpoint_id,enabled,interval_minutes,expected_status) VALUES (?,?,?,1,1,200)').run(`check-${i}`, `component-${i}`, `endpoint-${i}`)
    endpoints.push({ id: `endpoint-${i}`, name: `Endpoint ${i}`, url: `https://example.com/${i}` })
  }
  function sync(endpoints: { id: string; url: string; binding?: string; serviceId?: string; revision?: string }[]) {
    for (const endpoint of endpoints) {
      const fingerprint = createHash('sha256').update(JSON.stringify([endpoint.url, endpoint.binding ?? null, endpoint.serviceId ?? null, endpoint.revision ?? null])).digest('hex')
      sqlite.prepare('INSERT INTO endpoint_registry(endpoint_id,fingerprint) VALUES (?,?) ON CONFLICT(endpoint_id) DO UPDATE SET fingerprint=excluded.fingerprint').run(endpoint.id, fingerprint)
    }
  }
  sync(endpoints)
  function prepare(sql: string) {
    let params: (string | number | null)[] = []
    return {
      bind(...values: (string | number | null)[]) { params = values; return this },
      async all() { return { results: sqlite.prepare(sql).all(...params) } },
      async first() { return sqlite.prepare(sql).get(...params) ?? null },
      runSync() { return sqlite.prepare(sql).run(...params) },
      async run() { return this.runSync() },
    }
  }
  const db = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      sqlite.exec('BEGIN')
      try {
        const results = []
        for (const statement of statements) {
          const result = statement.runSync()
          results.push({ meta: { changes: Number(result.changes) } })
        }
        sqlite.exec('COMMIT')
        return results
      } catch (error) { sqlite.exec('ROLLBACK'); throw error }
    },
  }
  return { sqlite, now, sync, env: { DB: db, ENDPOINTS: JSON.stringify(endpoints) } }
}

test('draft tests use the approved endpoint and do not record a check result', async () => {
  const { sqlite, env } = fixture()
  let calls = 0
  globalThis.fetch = async () => { calls++; return new Response('ready', { status: 200 }) }
  const request = () => new Request('https://probe.internal/test', { method: 'POST', body: JSON.stringify({ endpointId: 'endpoint-0', expectedStatus: 200, advancedConfig: { keyword: 'ready', timeoutMs: 5000, attempts: 1 } }) })
  const response = await worker.fetch(request(), env as never)
  assert.equal(response.status, 200)
  assert.equal((await response.json() as { overall: string }).overall, 'ok')
  assert.equal(calls, 1)
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM http_check_results').get()?.count, 0)
  sqlite.prepare('DELETE FROM endpoint_registry').run()
  assert.equal((await worker.fetch(request(), env as never)).status, 409)
  assert.equal(calls, 1)
  sqlite.close()
})

test('checks use four concurrent requests and record nonmatching status', async () => {
  const { sqlite, now, env } = fixture(9)
  let active = 0
  let maxActive = 0
  globalThis.fetch = async () => {
    active++
    maxActive = Math.max(maxActive, active)
    await new Promise(resolve => setTimeout(resolve, 2))
    active--
    return new Response(null, { status: 503 })
  }
  await runChecks(now, env as never)
  assert.equal(maxActive, 4)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM http_checks WHERE last_status='down' AND last_http_status=503").get()?.count, 9)
  sqlite.close()
})

test('timeout is recorded as down and duplicate or older ticks cannot replace the result', async () => {
  const { sqlite, now, env } = fixture()
  let calls = 0
  globalThis.fetch = async (_input, init) => {
    calls++
    assert.ok(init?.signal)
    throw new DOMException('timed out', 'TimeoutError')
  }
  await runChecks(now, env as never)
  globalThis.fetch = async () => { calls++; return new Response(null, { status: 200 }) }
  await runChecks(now, env as never)
  await runChecks(now - 60_000, env as never)
  assert.equal(calls, 1)
  assert.equal(sqlite.prepare('SELECT last_status FROM http_checks').get()?.last_status, 'down')
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM http_check_results').get()?.count, 1)
  sqlite.close()
})

test('a result from an old configuration is discarded', async () => {
  const { sqlite, now, env } = fixture()
  globalThis.fetch = async () => {
    sqlite.exec('UPDATE http_checks SET config_version = config_version + 1 WHERE id = \'check-0\'')
    return new Response(null, { status: 200 })
  }
  await runChecks(now, env as never)
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM http_check_results').get()?.count, 0)
  assert.equal(sqlite.prepare('SELECT last_status FROM http_checks').get()?.last_status, null)
  sqlite.close()
})

test('concurrent duplicate runs and a late older result preserve the latest observation', async () => {
  const { sqlite, now, env } = fixture()
  let releaseOlder!: () => void
  const olderStarted = new Promise<void>(resolve => {
    globalThis.fetch = async () => {
      resolve()
      await new Promise<void>(release => { releaseOlder = release })
      return new Response(null, { status: 503 })
    }
  })
  const oldRun = runChecks(now, env as never)
  await olderStarted
  globalThis.fetch = async () => new Response(null, { status: 200 })
  await Promise.all([runChecks(now + 60_000, env as never), runChecks(now + 60_000, env as never)])
  releaseOlder()
  await oldRun
  const check = sqlite.prepare('SELECT last_status, last_scheduled_at FROM http_checks').get()
  assert.equal(check?.last_status, 'up')
  assert.equal(check?.last_scheduled_at, now + 60_000)
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM http_check_results').get()?.count, 2)
  sqlite.close()
})

test('private endpoint uses the configured VPC service binding', async () => {
  const { sqlite, now, env, sync } = fixture()
  const endpoints = [{ id: 'endpoint-0', name: 'Private', url: 'https://service.internal/health', binding: 'PRIVATE', serviceId: 'test-service' }]
  env.ENDPOINTS = JSON.stringify(endpoints)
  sync(endpoints)
  let destination = ''
  const privateEnv = { ...env, PRIVATE: { async fetch(url: string) { destination = url; return new Response(null, { status: 200 }) } } }
  globalThis.fetch = async () => { throw new Error('Unexpected public fetch') }
  await runChecks(now, privateEnv as never)
  assert.equal(destination, 'https://service.internal/health')
  assert.equal(sqlite.prepare('SELECT last_status FROM http_checks').get()?.last_status, 'up')
  sqlite.close()
})


test('VPC failure logs contain only a documented error code and no exception data', async () => {
  const messages = [
    { message: 'ProxyError: dns_timeout at https://private.internal/health?token=secret', name: 'https://private.internal/?token=secret', expected: 'dns_timeout' },
    { message: 'ProxyError: dns_timeoutSecret at https://private.internal/?token=secret', name: 'Error', expected: 'unknown' },
    { message: 'https://private.internal/?token=secret', name: 'Error', expected: 'unknown' },
  ]
  const originalLog = console.log
  const logs: string[] = []
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')) }
  try {
    for (const [index, item] of messages.entries()) {
      const { sqlite, now, env, sync } = fixture()
      const endpoints = [{ id: 'endpoint-0', name: 'Private', url: 'https://private.internal/health', binding: 'PRIVATE', serviceId: 'test-service' }]
      env.ENDPOINTS = JSON.stringify(endpoints)
      sync(endpoints)
      const privateEnv = { ...env, PRIVATE: { async fetch() { const error = new Error(item.message); error.name = item.name; throw error } } }
      await runChecks(now, privateEnv as never)
      const failures = logs.map(line => JSON.parse(line) as { event: string; vpcErrorCode?: string; errorName?: string }).filter(line => line.event === 'probe_failure')
      assert.equal(failures[index]?.vpcErrorCode, item.expected)
      if (index === 0) assert.equal(failures[index]?.errorName, 'UnknownError')
      assert.equal(sqlite.prepare('SELECT last_status FROM http_checks').get()?.last_status, 'down')
      sqlite.close()
    }
    assert.doesNotMatch(logs.join('\n'), /private\.internal|secret/)
  } finally {
    console.log = originalLog
  }
})

test('registry change rejects an in-flight old target and makes the new target eligible immediately', async () => {
  const { sqlite, now, env, sync } = fixture()
  let release!: () => void
  let oldStarted!: () => void
  const started = new Promise<void>(resolve => { oldStarted = resolve })
  globalThis.fetch = async () => {
    oldStarted()
    await new Promise<void>(resolve => { release = resolve })
    return new Response(null, { status: 503 })
  }
  const old = runChecks(now, env as never)
  await started
  const replacement = [{ id: 'endpoint-0', name: 'Endpoint 0', url: 'https://example.com/replacement' }]
  sync(replacement)
  const freshEnv = { ...env, ENDPOINTS: JSON.stringify(replacement) }
  globalThis.fetch = async () => new Response(null, { status: 200 })
  await runChecks(now, freshEnv as never)
  release()
  await old
  const check = sqlite.prepare('SELECT last_status, last_http_status FROM http_checks').get()
  assert.equal(check?.last_status, 'up')
  assert.equal(check?.last_http_status, 200)
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM http_check_results').get()?.count, 1)
  // Old code still deployed later cannot roll back the registry or record a result.
  await runChecks(now + 60_000, env as never)
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM http_check_results').get()?.count, 1)
  sqlite.close()
})

test('reviewed sync validates both workers, the D1 target and private VPC binding', async () => {
  const endpoint = { id: "target'quote", name: 'Private', url: 'https://secret.internal/health?token=secret', binding: 'PRIVATE', serviceId: 'vpc-1' }
  const config = { env: { staging: { vars: { ENDPOINTS: JSON.stringify([endpoint]) }, d1_databases: [{ binding: 'DB', database_id: 'db-1' }], vpc_services: [{ binding: 'PRIVATE', service_id: 'vpc-1' }] } } }
  const missingVars = { env: { staging: { d1_databases: [{ binding: 'DB', database_id: 'db-1' }] } } }
  await assert.rejects(buildSyncSql(missingVars, missingVars, 'staging'), /explicit ENDPOINTS/)
  const missing = structuredClone(config)
  missing.env.staging.vars.ENDPOINTS = ''
  await assert.rejects(buildSyncSql(missing, missing, 'staging'), /explicit ENDPOINTS/)
  missing.env.staging.vars.ENDPOINTS = '[]'
  assert.match(await buildSyncSql(missing, missing, 'staging'), /DELETE FROM endpoint_registry;/)
  const sql = await buildSyncSql(config, config, 'staging')
  assert.match(sql, /target''quote/)
  assert.doesNotMatch(sql, /secret\.internal|token=secret/)
  const mismatched = structuredClone(config)
  mismatched.env.staging.vpc_services[0].service_id = 'vpc-2'
  await assert.rejects(buildSyncSql(config, mismatched, 'staging'), /VPC service ID/)
  mismatched.env.staging.vpc_services[0].service_id = 'vpc-1'
  mismatched.env.staging.d1_databases[0].database_id = 'different-db'
  await assert.rejects(buildSyncSql(config, mismatched, 'staging'), /database IDs/)
  mismatched.env.staging.d1_databases[0].database_id = 'db-1'
  mismatched.env.staging.vars.ENDPOINTS = '[]'
  await assert.rejects(buildSyncSql(config, mismatched, 'staging'), /endpoint lists differ/)
})

test('registry sync preserves unchanged checks and invalidates changed or removed endpoints', async () => {
  const { sqlite, now } = fixture()
  sqlite.prepare("UPDATE http_checks SET last_status='up',last_result_at=?,last_scheduled_at=? WHERE id='check-0'").run(now, now)
  const endpoint = { id: 'endpoint-0', name: 'Endpoint 0', url: 'https://example.com/0' }
  const config = { env: { staging: { vars: { ENDPOINTS: JSON.stringify([endpoint]) }, d1_databases: [{ binding: 'DB', database_id: 'db-1' }] } } }
  const initialVersion = sqlite.prepare('SELECT config_version FROM http_checks').get()?.config_version
  sqlite.exec(await buildSyncSql(config, config, 'staging'))
  assert.equal(sqlite.prepare('SELECT config_version FROM http_checks').get()?.config_version, initialVersion)
  assert.equal(sqlite.prepare('SELECT last_status FROM http_checks').get()?.last_status, 'up')
  endpoint.url = 'https://example.com/new'
  config.env.staging.vars.ENDPOINTS = JSON.stringify([endpoint])
  sqlite.exec(await buildSyncSql(config, config, 'staging'))
  let check = sqlite.prepare('SELECT config_version,last_status,last_result_at,last_scheduled_at FROM http_checks').get()
  assert.equal(check?.config_version, Number(initialVersion) + 1)
  assert.equal(check?.last_status, null)
  assert.equal(check?.last_result_at, null)
  assert.equal(check?.last_scheduled_at, null)
  sqlite.prepare("UPDATE http_checks SET last_status='up',last_result_at=? WHERE id='check-0'").run(now)
  config.env.staging.vars.ENDPOINTS = '[]'
  sqlite.exec(await buildSyncSql(config, config, 'staging'))
  check = sqlite.prepare('SELECT config_version,last_status FROM http_checks').get()
  assert.equal(check?.config_version, Number(initialVersion) + 2)
  assert.equal(check?.last_status, null)
  sqlite.close()
})

test('advanced response assertions store degraded alongside conservative legacy status', async () => {
  const { sqlite, now, env } = fixture()
  sqlite.prepare('UPDATE http_checks SET advanced_config=? WHERE id=?').run(JSON.stringify({
    acceptedStatusRanges: [{ min: 200, max: 204 }],
    keyword: 'expected',
    assertions: [{ type: 'header', name: 'x-probe', op: 'equals', value: 'ok' }],
  }), 'check-0')
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    calls++
    assert.equal(init?.method, 'GET')
    assert.equal(init?.redirect, 'manual')
    return new Response('other', { status: 201, headers: { 'x-probe': 'ok' } })
  }
  await runChecks(now, env as never)
  assert.equal(calls, 1)
  const result = sqlite.prepare('SELECT status, effective_status FROM http_check_results').get()
  assert.equal(result?.status, 'down')
  assert.equal(result?.effective_status, 'degraded')
  const check = sqlite.prepare('SELECT last_status, last_effective_status FROM http_checks').get()
  assert.equal(check?.last_status, 'down')
  assert.equal(check?.last_effective_status, 'degraded')
  sqlite.close()
})

test('changing advanced configuration invalidates previous status and fences in-flight results', async () => {
  const { sqlite, now, env } = fixture()
  sqlite.prepare('UPDATE http_checks SET advanced_config=? WHERE id=?').run(JSON.stringify({ keyword: 'old' }), 'check-0')
  const firstVersion = Number(sqlite.prepare('SELECT config_version FROM http_checks').get()?.config_version)
  globalThis.fetch = async () => {
    sqlite.prepare('UPDATE http_checks SET advanced_config=? WHERE id=?').run(JSON.stringify({ keyword: 'new' }), 'check-0')
    return new Response('old')
  }
  await runChecks(now, env as never)
  let check = sqlite.prepare('SELECT config_version, last_status, last_effective_status FROM http_checks').get()
  assert.equal(check?.config_version, firstVersion + 1)
  assert.equal(check?.last_status, null)
  assert.equal(check?.last_effective_status, null)
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM http_check_results').get()?.count, 0)
  globalThis.fetch = async () => new Response('new')
  await runChecks(now + 60_000, env as never)
  check = sqlite.prepare('SELECT last_status, last_effective_status FROM http_checks').get()
  assert.equal(check?.last_status, 'up')
  assert.equal(check?.last_effective_status, 'up')
  sqlite.close()
})

test('advanced config refuses credential, request-body and unapproved POST settings at write time', async () => {
  const { sqlite } = fixture()
  const sql = sqlite.prepare('UPDATE http_checks SET advanced_config=? WHERE id=?')
  const badSettings = [
    { headers: { Authorization: 'do-not-log-secret' } },
    { body: 'do-not-log-secret' },
    { auth: { type: 'basic', password: 'do-not-log-secret' } },
    { method: 'POST' },
    { assertions: [{ type: 'header', name: 'x', op: 'exists', headers: { Authorization: 'do-not-log-secret' } }] },
    { acceptedStatusRanges: [{ min: 200, max: 299, body: 'do-not-log-secret' }] },
  ]
  for (const bad of badSettings) assert.throws(() => sql.run(JSON.stringify(bad), 'check-0'), /invalid advanced check configuration/)
  assert.equal(sqlite.prepare('SELECT advanced_config FROM http_checks').get()?.advanced_config, null)
  sqlite.close()
})

test('invalid advanced assertion fails closed without a network call or value disclosure', async () => {
  const { sqlite, now, env } = fixture()
  sqlite.prepare('UPDATE http_checks SET advanced_config=? WHERE id=?').run(JSON.stringify({ assertions: [{ type: 'json', path: '$.invalid[', op: 'exists' }] }), 'check-0')
  let calls = 0
  const events: string[] = []
  const previous = console.error
  console.error = (...args: unknown[]) => { events.push(args.map(String).join(' ')) }
  globalThis.fetch = async () => { calls++; return new Response() }
  try {
    await runChecks(now, env as never)
  } finally { console.error = previous }
  assert.equal(calls, 0)
  assert.equal(events.length, 1)
  assert.ok(events.every(event => event.includes('probe_config_invalid')))
  assert.ok(!events.some(event => event.includes('do-not-log-secret')))
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM http_check_results').get()?.count, 0)
  assert.equal(sqlite.prepare('SELECT last_status FROM http_checks').get()?.last_status, null)
  sqlite.close()
})

test('advanced HEAD checks use the approved VPC binding and accepted ranges', async () => {
  const { sqlite, now, env, sync } = fixture()
  const endpoints = [{ id: 'endpoint-0', name: 'Private', url: 'https://internal.example/health', binding: 'PRIVATE', serviceId: 'svc-1' }]
  env.ENDPOINTS = JSON.stringify(endpoints)
  sync(endpoints)
  sqlite.prepare('UPDATE http_checks SET advanced_config=? WHERE id=?').run(JSON.stringify({ method: 'head', acceptedStatusRanges: [{ min: 200, max: 204 }] }), 'check-0')
  let calls = 0
  const privateEnv = { ...env, PRIVATE: { fetch: async (url: string, init: RequestInit) => {
    calls++
    assert.equal(url, endpoints[0]!.url)
    assert.equal(init.method, 'HEAD')
    assert.equal(init.redirect, 'manual')
    return new Response(null, { status: 204 })
  } } }
  globalThis.fetch = async () => { throw new Error('public fetch must not be used') }
  await runChecks(now, privateEnv as never)
  assert.equal(calls, 1)
  const check = sqlite.prepare('SELECT last_status, last_effective_status, last_http_status FROM http_checks').get()
  assert.equal(check?.last_status, 'up')
  assert.equal(check?.last_effective_status, 'up')
  assert.equal(check?.last_http_status, 204)
  sqlite.close()
})

test('scheduled checks reject a total timeout budget over ten seconds before network access', async () => {
  const { sqlite, now, env } = fixture()
  sqlite.prepare('UPDATE http_checks SET advanced_config=? WHERE id=?').run(JSON.stringify({ timeoutMs: 5001, attempts: 2 }), 'check-0')
  let calls = 0
  globalThis.fetch = async () => { calls++; return new Response() }
  await runChecks(now, env as never)
  assert.equal(calls, 0)
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM http_check_results').get()?.count, 0)
  sqlite.close()
})
