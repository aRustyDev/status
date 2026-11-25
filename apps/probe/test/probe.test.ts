import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { buildSyncSql } from '../scripts/sync-endpoints.ts'
import worker, { runChecks } from '../src/index.ts'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

function fixture(count = 1, withAutomation = true) {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(readFileSync(new URL('../../worker/migrations/0001_board.sql', import.meta.url), 'utf8'))
  sqlite.exec(readFileSync(new URL('../../worker/migrations/0002_checks.sql', import.meta.url), 'utf8'))
  sqlite.exec(readFileSync(new URL('../../worker/migrations/0003_endpoint_registry.sql', import.meta.url), 'utf8'))
  sqlite.exec(readFileSync(new URL('../../worker/migrations/0006_advanced_http.sql', import.meta.url), 'utf8'))
  sqlite.exec(readFileSync(new URL('../../worker/migrations/0005_gatus_sources.sql', import.meta.url), 'utf8'))
  sqlite.exec(readFileSync(new URL('../../worker/migrations/0009_monitor_auth.sql', import.meta.url), 'utf8'))
  if (withAutomation) for (const file of ['0009_channels.sql','0009_actions.sql','0010_monitor_alert_links.sql','0010_notification_transition_state.sql','0011_email_channels.sql','0012_notification_delivery_state.sql','0013_notification_unlink_cancel.sql']) sqlite.exec(readFileSync(new URL(`../../worker/migrations/${file}`, import.meta.url), 'utf8'))
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
      async run() { const result = this.runSync(); return { meta: { changes: Number(result.changes) } } },
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

test('draft and scheduled checks agree on status ranges and assertion outcomes', async () => {
  for (const scenario of [
    { status: 201, body: 'ready', header: 'ok', expected: 'up', label: 'HTTP check passed' },
    { status: 204, body: 'missing', header: 'ok', expected: 'degraded', label: 'HTTP check degraded' },
    { status: 201, body: 'ready', header: 'wrong', expected: 'down', label: 'HTTP check failed' },
    { status: 404, body: 'ready', header: 'ok', expected: 'down', label: 'HTTP check failed' },
  ]) {
    const { sqlite, now, env } = fixture()
    const advancedConfig = { acceptedStatusRanges: [{ min: 200, max: 204 }], keyword: 'ready', assertions: [{ type: 'header', name: 'x-health', op: 'equals', value: 'ok', onFail: 'down' }], timeoutMs: 5000, attempts: 1 }
    sqlite.prepare('UPDATE http_checks SET advanced_config=? WHERE id=?').run(JSON.stringify(advancedConfig), 'check-0')
    globalThis.fetch = async () => new Response(scenario.status === 204 ? null : scenario.body, { status: scenario.status, headers: { 'x-health': scenario.header } })
    const request = new Request('https://probe.internal/test', { method: 'POST', body: JSON.stringify({ endpointId: 'endpoint-0', expectedStatus: 200, advancedConfig }) })
    const response = await worker.fetch(request, env as never)
    assert.equal(response.status, 200)
    assert.equal((await response.json() as { steps: { label: string }[] }).steps[0]?.label, scenario.label)
    await runChecks(now, env as never)
    assert.equal(sqlite.prepare('SELECT effective_status FROM http_check_results').get()?.effective_status, scenario.expected)
    sqlite.close()
  }
})

test('legacy exact-status tests and schedules both reject redirects with a location', async () => {
  for (const location of [true, false]) {
    const { sqlite, now, env } = fixture()
    sqlite.prepare('UPDATE http_checks SET expected_status=302 WHERE id=?').run('check-0')
    globalThis.fetch = async (_input, init) => {
      assert.equal(init?.redirect, 'manual')
      return new Response(null, { status: 302, headers: location ? { location: 'https://unapproved.example/' } : {} })
    }
    const response = await worker.fetch(new Request('https://probe.internal/test', {
      method: 'POST', body: JSON.stringify({ endpointId: 'endpoint-0', expectedStatus: 302, advancedConfig: null }),
    }), env as never)
    const tested = await response.json() as { overall: string; steps: { detail?: string }[] }
    await runChecks(now, env as never)
    assert.equal(tested.overall, location ? 'error' : 'ok')
    if (location) assert.equal(tested.steps[0]?.detail, 'redirect_blocked')
    assert.equal(sqlite.prepare('SELECT effective_status FROM http_check_results').get()?.effective_status, location ? 'down' : 'up')
    sqlite.close()
  }
})

test('tests and schedules saved multibyte assertions without a smaller test byte limit', async () => {
  const { sqlite, now, env } = fixture()
  const value = '界'.repeat(1000)
  const advancedConfig = { assertions: Array.from({ length: 20 }, () => ({ type: 'json', path: '$.value', op: 'equals', value, onFail: 'down' })) }
  const serialized = JSON.stringify(advancedConfig)
  assert.ok(serialized.length < 32_000)
  assert.ok(new TextEncoder().encode(serialized).length > 32_000)
  sqlite.prepare('UPDATE http_checks SET advanced_config=? WHERE id=?').run(serialized, 'check-0')
  globalThis.fetch = async () => Response.json({ value })
  const response = await worker.fetch(new Request('https://probe.internal/test', {
    method: 'POST', body: JSON.stringify({ endpointId: 'endpoint-0', expectedStatus: 200, advancedConfig }),
  }), env as never)
  assert.equal(response.status, 200)
  assert.equal((await response.json() as { overall: string }).overall, 'ok')
  await runChecks(now, env as never)
  assert.equal(sqlite.prepare('SELECT effective_status FROM http_check_results').get()?.effective_status, 'up')
  const oversized = await worker.fetch(new Request('https://probe.internal/test', { method: 'POST', body: 'x'.repeat(256_001) }), env as never)
  assert.equal(oversized.status, 413)
  sqlite.close()
})

test('saved advanced checks without a timeout use the same deadline in Test and schedule', async () => {
  const { sqlite, now, env } = fixture()
  const originalSetTimeout = globalThis.setTimeout
  const deadlines: number[] = []
  try {
    sqlite.prepare('UPDATE http_checks SET advanced_config=? WHERE id=?').run(JSON.stringify({ keyword: 'ready' }), 'check-0')
    globalThis.setTimeout = ((fn: () => void, delay?: number) => {
      if (delay === 10_000) deadlines.push(delay)
      return originalSetTimeout(fn, delay === 10_000 ? 1 : delay)
    }) as typeof setTimeout
    globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
    const response = await worker.fetch(new Request('https://probe.internal/test', {
      method: 'POST', body: JSON.stringify({ endpointId: 'endpoint-0', expectedStatus: 200, advancedConfig: { keyword: 'ready', timeoutMs: 10_000, attempts: 1 } }),
    }), env as never)
    const result = await response.json() as { overall: string; steps: { detail?: string }[] }
    await runChecks(now, env as never)
    assert.deepEqual(deadlines, [10_000, 10_000])
    assert.equal(result.overall, 'error')
    assert.equal(result.steps[0]?.detail, 'request_timeout')
    assert.equal(sqlite.prepare('SELECT effective_status FROM http_check_results').get()?.effective_status, 'down')
  } finally { globalThis.setTimeout = originalSetTimeout; sqlite.close() }
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

test('reviewed sync validates Worker service bindings by exact service name', async () => {
  const endpoint = { id:'test', name:'Synthetic', url:'https://test.internal/', binding:'SYNTHETIC', serviceId:'status-synthetic-staging' }
  const config = { env:{ staging:{ vars:{ ENDPOINTS:JSON.stringify([endpoint]) }, d1_databases:[{binding:'DB',database_id:'db-1'}], services:[{binding:'SYNTHETIC',service:'status-synthetic-staging'}] } } }
  assert.match(await buildSyncSql(config,config,'staging'),/INSERT INTO endpoint_registry/)
  const mismatch = structuredClone(config); mismatch.env.staging.services[0]!.service = 'other'
  await assert.rejects(buildSyncSql(config,mismatch,'staging'),/does not match/)
  const namedEntrypoint = { env:{ staging:{ ...config.env.staging, services:[{binding:'SYNTHETIC',service:'status-synthetic-staging',entrypoint:'Other'}] } } }
  await assert.rejects(buildSyncSql(config,namedEntrypoint,'staging'),/does not match/)
  const ambiguous = { env:{ staging:{ ...config.env.staging, vpc_services:[{binding:'SYNTHETIC',service_id:'status-synthetic-staging'}] } } }
  await assert.rejects(buildSyncSql(config,ambiguous,'staging'),/does not match/)
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

test('saved Basic Vault credentials are resolved only for the configured check and never enter results', async () => {
  const { sqlite, now, env } = fixture()
  sqlite.exec(readFileSync(new URL('../../worker/migrations/0008_vault.sql', import.meta.url), 'utf8'))
  const keyHex = 'ab'.repeat(32)
  const { vaultKeyReady } = await import('../../worker/src/vault.ts')
  assert.equal(await vaultKeyReady(env.DB as never, keyHex), true)
  sqlite.prepare('INSERT INTO vaults(id,name,created_at,updated_at) VALUES (1,?,?,?)').run('fixture', now, now)
  const credential = { username: 'user-λ', password: 'synthetic-password-1' }
  async function putCredential(data: typeof credential) {
    const key = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(0xab), 'AES-GCM', false, ['encrypt'])
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    const bytes = await crypto.subtle.encrypt({ name:'AES-GCM', iv:nonce, additionalData:new TextEncoder().encode('status-vault-v1:1:2:userpass') }, key, new TextEncoder().encode(JSON.stringify(data)))
    const b64 = (v: Uint8Array) => btoa(Array.from(v, b => String.fromCharCode(b)).join(''))
    sqlite.prepare(`INSERT INTO vault_secrets(id,vault_id,name,type,ciphertext,nonce,created_at,updated_at) VALUES (2,1,'fixture','userpass',?,?,?,?) ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext,nonce=excluded.nonce`).run(b64(new Uint8Array(bytes)),b64(nonce),now,now)
  }
  await putCredential(credential)
  const advanced = { method:'GET', timeoutMs:5000, attempts:1, auth:{type:'basic',basic:{vault:{vaultId:1,secretId:2}}} }
  sqlite.prepare('UPDATE http_checks SET advanced_config=? WHERE id=?').run(JSON.stringify(advanced), 'check-0')
  const runtime = { ...env, VAULT_ENCRYPTION_KEY:keyHex, MONITOR_AUTH_READY:'true' }
  const checkVersion = Number(sqlite.prepare('SELECT config_version FROM http_checks WHERE id=?').get('check-0')?.config_version)
  const seen: string[] = []
  globalThis.fetch = async (_url, init) => {
    assert.equal(init?.redirect, 'manual')
    seen.push(new Headers(init?.headers).get('authorization') ?? '')
    return new Response('not returned in results', { status: 200 })
  }
  const req = (input: unknown) => new Request('https://probe.internal/test', { method:'POST', body:JSON.stringify(input) })
  const result = await worker.fetch(req({checkId:'check-0',checkVersion}), runtime as never)
  const body = await result.text()
  assert.equal(result.status,200)
  assert.match(body,/HTTP check passed/)
  assert.doesNotMatch(body,/synthetic-password|user-λ|not returned/)
  await runChecks(now,runtime as never)
  assert.equal(seen.length,2)
  const expected = `Basic ${btoa(Array.from(new TextEncoder().encode(`${credential.username}:${credential.password}`), b => String.fromCharCode(b)).join(''))}`
  assert.equal(seen[0], expected)
  assert.equal(seen[1], expected)
  assert.equal((await worker.fetch(req({endpointId:'endpoint-0',expectedStatus:200,advancedConfig:advanced}),runtime as never)).status,400)
  assert.equal((await worker.fetch(req({checkId:'check-0',checkVersion:checkVersion+1}),runtime as never)).status,409)
  assert.equal(seen.length,2)
  await putCredential({ username:'rotated', password:'synthetic-password-2' })
  await worker.fetch(req({checkId:'check-0',checkVersion}),runtime as never)
  assert.notEqual(seen[2],seen[1])
  await putCredential({username:'u',password:'x'.repeat(6136)})
  const boundary = await worker.fetch(req({checkId:'check-0',checkVersion}),runtime as never)
  assert.match(await boundary.text(),/HTTP check passed/)
  assert.equal(seen[3]?.length,8190)
  await putCredential({username:'u',password:'x'.repeat(6137)})
  const oversized = await worker.fetch(req({checkId:'check-0',checkVersion}),runtime as never)
  assert.match(await oversized.text(),/credential_unavailable/)
  assert.equal(seen.length,4)
  sqlite.prepare('DELETE FROM vault_secrets WHERE id=2').run()
  const missing = await worker.fetch(req({checkId:'check-0',checkVersion}),runtime as never)
  assert.match(await missing.text(),/credential_unavailable/)
  assert.equal(seen.length,4)
  const warnings: string[] = []
  const originalWarn = console.warn
  try {
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
    await runChecks(now + 60_000,runtime as never)
  } finally { console.warn = originalWarn }
  assert.deepEqual(warnings.map(value => JSON.parse(value)), [{event:'probe_credential_unavailable',checkId:'check-0'}])
  assert.doesNotMatch(warnings.join(' '),/synthetic-password|user-λ|example\.com/)
  assert.equal(sqlite.prepare('SELECT last_status FROM http_checks WHERE id=?').get('check-0')?.last_status,'down')
  assert.equal(seen.length,4)
  sqlite.close()
})

test('monitor auth readiness gates saved tests and scheduled probes before credential access', async () => {
  for (const readiness of [undefined, 'false']) {
    const { sqlite, now, env } = fixture()
    sqlite.prepare('UPDATE http_checks SET advanced_config=? WHERE id=?').run(JSON.stringify({auth:{type:'basic',basic:{vault:{vaultId:1,secretId:2}}}}),'check-0')
    const checkVersion = Number(sqlite.prepare('SELECT config_version FROM http_checks WHERE id=?').get('check-0')?.config_version)
    let credentialReads = 0, networkCalls = 0
    const guardedDb = { ...env.DB, prepare(sql: string) {
      if (sql.includes('vault_')) { credentialReads++; throw new Error('Unexpected credential access') }
      return env.DB.prepare(sql)
    } }
    globalThis.fetch = async () => { networkCalls++; return new Response() }
    const runtime = { ...env, DB: guardedDb, MONITOR_AUTH_READY: readiness, VAULT_ENCRYPTION_KEY:'ab'.repeat(32) }
    const result = await worker.fetch(new Request('https://probe.internal/test', {method:'POST',body:JSON.stringify({checkId:'check-0',checkVersion})}), runtime as never)
    assert.match(await result.text(), /credential_unavailable/)
    await runChecks(now, runtime as never)
    assert.equal(credentialReads, 0)
    assert.equal(networkCalls, 0)
    assert.equal(sqlite.prepare('SELECT transition_suppressed FROM http_checks WHERE id=?').get('check-0')?.transition_suppressed, 1)
    sqlite.close()
  }
})

test('credentialed checks reject redirects and stale or non-HTTPS targets without disclosure', async () => {
  const { sqlite, env, sync } = fixture()
  sqlite.exec(readFileSync(new URL('../../worker/migrations/0008_vault.sql', import.meta.url), 'utf8'))
  const { vaultKeyReady } = await import('../../worker/src/vault.ts')
  const keyHex = 'ab'.repeat(32)
  assert.equal(await vaultKeyReady(env.DB as never,keyHex),true)
  sqlite.prepare('INSERT INTO vaults(id,name,created_at,updated_at) VALUES (1,?,?,?)').run('fixture',0,0)
  const key = await crypto.subtle.importKey('raw',new Uint8Array(32).fill(0xab),'AES-GCM',false,['encrypt'])
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:new TextEncoder().encode('status-vault-v1:1:2:userpass')},key,new TextEncoder().encode(JSON.stringify({username:'user',password:'fixture-secret'})))
  const b64 = (v:Uint8Array) => btoa(Array.from(v,b=>String.fromCharCode(b)).join(''))
  sqlite.prepare("INSERT INTO vault_secrets(id,vault_id,name,type,ciphertext,nonce,created_at,updated_at) VALUES (2,1,'fixture','userpass',?,?,0,0)").run(b64(new Uint8Array(encrypted)),b64(nonce))
  sqlite.prepare('UPDATE http_checks SET advanced_config=? WHERE id=?').run(JSON.stringify({auth:{type:'basic',basic:{vault:{vaultId:1,secretId:2}}}}),'check-0')
  let calls = 0
  globalThis.fetch = async (_url, init) => { calls++; assert.equal(init?.redirect,'manual'); return new Response(null,{status:302,headers:{location:'https://unapproved.example/'}}) }
  const req = () => new Request('https://probe.internal/test',{method:'POST',body:JSON.stringify({checkId:'check-0',checkVersion:Number(sqlite.prepare('SELECT config_version FROM http_checks WHERE id=?').get('check-0')?.config_version)})})
  const runtime = { ...env, VAULT_ENCRYPTION_KEY:keyHex, MONITOR_AUTH_READY:'true' }
  const redirect = await worker.fetch(req(),runtime as never)
  const text = await redirect.text()
  assert.match(text,/redirect_blocked/)
  assert.doesNotMatch(text,/fixture-secret|unapproved/)
  assert.equal(calls,1)
  let race = true
  const fencedDb = { ...env.DB, prepare(sql: string) {
    if (race && sql.includes('SELECT c.advanced_config AS advanced_config')) {
      race = false
      sqlite.prepare('UPDATE http_checks SET config_version=config_version+1 WHERE id=?').run('check-0')
    }
    return env.DB.prepare(sql)
  } }
  const changed = await worker.fetch(req(), { ...runtime, DB:fencedDb } as never)
  assert.match(await changed.text(),/credential_unavailable/)
  assert.equal(calls,1)
  sqlite.prepare('DELETE FROM endpoint_registry').run()
  assert.equal((await worker.fetch(req(),runtime as never)).status,409)
  assert.equal(calls,1)
  const privateEndpoint = {id:'endpoint-0',name:'Private',url:'http://private.example/',binding:'PRIVATE',serviceId:'service'}
  sync([privateEndpoint])
  const privateEnv = { ...runtime, ENDPOINTS:JSON.stringify([privateEndpoint]), PRIVATE:{ fetch: async () => { calls++; return new Response() } } }
  const notHttps = await worker.fetch(req(),privateEnv as never)
  assert.match(await notHttps.text(),/credential_unavailable/)
  assert.equal(calls,1)
  sqlite.close()
})

test('scheduler sends degraded transitions to configured channels and actions', async () => {
  const {sqlite,now,env} = fixture()
  for (const file of ['0008_vault.sql']) sqlite.exec(readFileSync(new URL(`../../worker/migrations/${file}`,import.meta.url),'utf8'))
  sqlite.prepare("INSERT INTO users (id,issuer,subject,email,role) VALUES ('admin','issuer','subject','admin@example.test','admin')").run()
  const checkId = '00000000-0000-4000-8000-000000000001'
  sqlite.prepare('UPDATE http_checks SET id=?,advanced_config=? WHERE id=?').run(checkId,JSON.stringify({keyword:'ready'}),'check-0')
  const actor={id:'admin',email:'admin@example.test',version:1}, key='ab'.repeat(32)
  const req=(body:unknown)=>new Request('https://status.example/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
  const {vaultApi}=await import('../../worker/src/vault.ts')
  const {channelApi}=await import('../../worker/src/channels.ts')
  const {actionApi}=await import('../../worker/src/actions.ts')
  const vault=await (await vaultApi(req({name:'fixture'}),env.DB as never,key,actor,'/admin/vaults')).json() as {id:number}
  const secret=await (await vaultApi(req({name:'fixture',type:'value',value:'synthetic-token'}),env.DB as never,key,actor,`/admin/vaults/${vault.id}/secrets`)).json() as {id:number}
  const destinations=JSON.stringify([{id:'sink',name:'Fixture',url:'https://sink.internal/',binding:'SINK',serviceId:'sink-worker'}])
  const bodies: unknown[]=[]
  const runtime={...env,VAULT_ENCRYPTION_KEY:key,MONITOR_AUTH_READY:'true',CHANNELS_READY:'true',CHANNEL_ENDPOINTS:destinations,ACTIONS_READY:'true',ACTION_ENDPOINTS:destinations,SINK:{fetch:async (_url:string,init:RequestInit)=>{bodies.push(JSON.parse(String(init.body))); return new Response(null,{status:200})}}}
  const common={endpointId:'sink',vaultId:vault.id,secretId:secret.id,enabled:true,checkIds:[checkId]}
  const expectedChecks=[{id:checkId,componentId:'component-0',version:Number(sqlite.prepare('SELECT config_version FROM http_checks WHERE id=?').get(checkId)?.config_version)}]
  assert.equal((await channelApi(req({...common,name:'Channel',expectedChecks}),runtime as never,actor,'/admin/notifications/channels')).status,201)
  assert.equal((await actionApi(req({...common,name:'Action',triggerStatus:'degraded'}),runtime as never,actor,'/admin/actions')).status,201)
  globalThis.fetch = async () => new Response('ready',{status:200})
  await runChecks(now,runtime as never)
  globalThis.fetch = async () => new Response('absent',{status:200})
  await runChecks(now+60_000,runtime as never)
  assert.equal(bodies.length,2)
  assert.deepEqual(bodies.map(body => (body as {status:string}).status),['degraded','degraded'])
  assert.doesNotMatch(JSON.stringify(bodies),/synthetic-token/)

  // A resolver failure is an internal fault, not an event suitable for automation.
  // Its first healthy observation establishes a fresh baseline without a false recovery.
  const login=await (await vaultApi(req({name:'login',type:'userpass',userpass:{username:'fixture',password:'synthetic-password'}}),env.DB as never,key,actor,`/admin/vaults/${vault.id}/secrets`)).json() as {id:number}
  sqlite.prepare('UPDATE http_checks SET advanced_config=? WHERE id=?').run(JSON.stringify({keyword:'ready',auth:{type:'basic',basic:{vault:{vaultId:vault.id,secretId:login.id}}}}),checkId)
  sqlite.prepare("UPDATE http_checks SET last_status='up',last_effective_status='up',last_scheduled_at=?,last_effective_scheduled_at=? WHERE id=?").run(now+60_000,now+60_000,checkId)
  let monitoredCalls=0
  globalThis.fetch = async () => { monitoredCalls++; return new Response('ready',{status:200}) }
  await runChecks(now+120_000,{...runtime,VAULT_ENCRYPTION_KEY:'cd'.repeat(32)} as never)
  assert.equal(monitoredCalls,0)
  assert.equal(bodies.length,2)
  assert.deepEqual({...sqlite.prepare('SELECT last_status,transition_suppressed FROM http_checks WHERE id=?').get(checkId)},{last_status:'down',transition_suppressed:1})
  await runChecks(now+180_000,runtime as never)
  assert.equal(monitoredCalls,1)
  assert.equal(bodies.length,2)
  assert.deepEqual({...sqlite.prepare('SELECT last_status,transition_suppressed FROM http_checks WHERE id=?').get(checkId)},{last_status:'up',transition_suppressed:0})
  globalThis.fetch = async () => { monitoredCalls++; return new Response('absent',{status:200}) }
  await runChecks(now+240_000,runtime as never)
  assert.equal(bodies.length,4)
  assert.deepEqual(bodies.slice(2).map(body => (body as {status:string}).status),['degraded','degraded'])

  const failingDb={...env.DB,prepare(sql:string) {
    if (sql.includes('SELECT c.advanced_config AS advanced_config')) throw new Error('internal database details')
    return env.DB.prepare(sql)
  }}
  const before=monitoredCalls, warnings:string[]=[]
  const originalWarn=console.warn
  try {
    console.warn=(...args:unknown[]) => { warnings.push(args.map(String).join(' ')) }
    await runChecks(now+300_000,{...runtime,DB:failingDb} as never)
  } finally { console.warn=originalWarn }
  assert.deepEqual(warnings.map(value => JSON.parse(value)),[{event:'probe_credential_unavailable',checkId}])
  assert.doesNotMatch(warnings.join(' '),/internal database details|synthetic-password|synthetic-token/)
  assert.equal(monitoredCalls,before)
  assert.equal(bodies.length,4)
  assert.equal(sqlite.prepare('SELECT transition_suppressed FROM http_checks WHERE id=?').get(checkId)?.transition_suppressed,1)
  globalThis.fetch = async () => { monitoredCalls++; return new Response('ready',{status:200}) }
  await runChecks(now+360_000,runtime as never)
  assert.equal(bodies.length,5)
  assert.equal((bodies[4] as {status:string}).status,'up')
  assert.equal(sqlite.prepare('SELECT transition_suppressed FROM http_checks WHERE id=?').get(checkId)?.transition_suppressed,0)

  // Vault accepts this string, but UTF-8 and Base64 produce a header over the
  // transport limit. Neither Test nor the scheduler may transmit or automate it.
  const rotate=(version:number,password:string)=>new Request('https://status.example/',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({version,userpass:{username:'fixture',password}})})
  assert.equal((await vaultApi(rotate(1,'界'.repeat(3000)),env.DB as never,key,actor,`/admin/vaults/${vault.id}/secrets/${login.id}`)).status,200)
  const checkVersion=Number(sqlite.prepare('SELECT config_version FROM http_checks WHERE id=?').get(checkId)?.config_version)
  const beforeOversized=monitoredCalls, oversizedWarnings:string[]=[]
  const counts=()=>({channels:sqlite.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get()?.n,actions:sqlite.prepare('SELECT COUNT(*) AS n FROM worker_action_outbox').get()?.n})
  const beforeJobs=counts()
  const testResponse=await worker.fetch(new Request('https://probe.internal/test',{method:'POST',body:JSON.stringify({checkId,checkVersion})}),runtime as never)
  assert.match(await testResponse.text(),/credential_unavailable/)
  const warn=console.warn
  try {
    console.warn=(...args:unknown[])=>{oversizedWarnings.push(args.map(String).join(' '))}
    await runChecks(now+420_000,runtime as never)
  } finally { console.warn=warn }
  assert.equal(monitoredCalls,beforeOversized)
  assert.equal(bodies.length,5)
  assert.deepEqual(counts(),beforeJobs)
  assert.deepEqual({...sqlite.prepare('SELECT last_status,transition_suppressed FROM http_checks WHERE id=?').get(checkId)},{last_status:'down',transition_suppressed:1})
  assert.deepEqual(oversizedWarnings.map(value=>JSON.parse(value)),[{event:'probe_credential_unavailable',checkId}])
  assert.doesNotMatch(oversizedWarnings.join(' '),/界|fixture|synthetic/)
  assert.equal((await vaultApi(rotate(2,'synthetic-password'),env.DB as never,key,actor,`/admin/vaults/${vault.id}/secrets/${login.id}`)).status,200)
  await runChecks(now+480_000,runtime as never)
  assert.equal(bodies.length,5)
  assert.equal(sqlite.prepare('SELECT transition_suppressed FROM http_checks WHERE id=?').get(checkId)?.transition_suppressed,0)
  sqlite.close()
})

test('enabled delivery without its schema rolls back the check result rather than dropping the transition', async () => {
  for (const kind of ['channel','action'] as const) {
    const {sqlite,now,env}=fixture(1,false)
    globalThis.fetch=async()=>new Response(null,{status:200})
    const configured=kind==='channel' ? {CHANNELS_READY:'true',CHANNEL_ENDPOINTS:JSON.stringify([{id:'sink',name:'Sink',url:'https://sink.test/'}])} : {ACTIONS_READY:'true',ACTION_ENDPOINTS:'[]'}
    await assert.rejects(runChecks(now,{...env,...configured} as never),/no such table/)
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM http_check_results').get()?.n,0)
    assert.equal(sqlite.prepare('SELECT last_status FROM http_checks WHERE id=?').get('check-0')?.last_status,null)
    sqlite.close()
  }
})

test('maintenance preserves a shared automation baseline and re-evaluates global and targeted outages after the window',async()=>{
 for (const targeted of [false,true]) {
  const {sqlite,env}=fixture()
  for (const file of ['0008_vault.sql']) sqlite.exec(readFileSync(new URL(`../../worker/migrations/${file}`,import.meta.url),'utf8'))
  const check='check-0', tick=Math.floor(Date.now()/60_000)*60_000-240_000
  sqlite.prepare("INSERT INTO notification_channels (id,name,endpoint_id,endpoint_fingerprint,vault_id,secret_id,enabled,created_at,updated_at) VALUES ('c','channel','sink','f',1,1,1,0,0)").run()
  sqlite.prepare("INSERT INTO notification_channel_checks (channel_id,check_id) VALUES ('c',?)").run(check)
  sqlite.prepare("INSERT INTO worker_actions (id,name,endpoint_id,endpoint_fingerprint,vault_id,secret_id,enabled,trigger_status,created_at,updated_at) VALUES ('a','action','sink','f',1,1,1,'all',0,0)").run()
  sqlite.prepare("INSERT INTO worker_action_checks (action_id,check_id) VALUES ('a',?)").run(check)
  const runtime={...env,CHANNELS_READY:'true',CHANNEL_ENDPOINTS:JSON.stringify([{id:'sink',name:'Sink',url:'https://sink.test/'}]),ACTIONS_READY:'true',ACTION_ENDPOINTS:'[]'}
  const realNow=Date.now
  try {
   Date.now=()=>tick
   globalThis.fetch=async()=>new Response(null,{status:200})
   await runChecks(tick,runtime as never)
   sqlite.prepare("INSERT INTO maintenance (id,name,starts_at,ends_at,created_at,updated_at) VALUES ('m','window',?,?,?,?)").run(tick+30_000,tick+150_000,tick,tick)
   if(targeted) sqlite.prepare("INSERT INTO maintenance_components (maintenance_id,component_id) VALUES ('m','component-0')").run()
   globalThis.fetch=async()=>new Response(null,{status:500})
   Date.now=()=>tick+60_000;await runChecks(tick+60_000,runtime as never)
   Date.now=()=>tick+120_000;await runChecks(tick+120_000,runtime as never)
   assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get()?.n,0)
   assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM worker_action_outbox').get()?.n,0)
   assert.equal(sqlite.prepare('SELECT status FROM automation_transition_state WHERE check_id=?').get(check)?.status,'up')
   Date.now=()=>tick+180_000;await runChecks(tick+180_000,runtime as never)
   assert.equal(sqlite.prepare('SELECT status FROM automation_transition_state WHERE check_id=?').get(check)?.status,'down')
   assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get()?.n,1)
   assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM worker_action_outbox').get()?.n,1)
  } finally { Date.now=realNow;sqlite.close() }
 }
})

test('email-only configuration enqueues and sends confirmed monitor transitions',async()=>{
 const {sqlite,now,env}=fixture()
 const {emailChannelFingerprint}=await import('../../worker/src/email-channel.ts')
 const sender='sender@example.test', recipient='alerts@example.test'
 const fingerprint=await emailChannelFingerprint(sender,recipient)
 sqlite.prepare("INSERT INTO notification_channels (id,name,endpoint_id,endpoint_fingerprint,vault_id,secret_id,enabled,created_at,updated_at,channel_type,recipient_id,email_fingerprint) VALUES ('c','Email','','',0,0,1,0,0,'email','ops',?)").run(fingerprint)
 sqlite.prepare("INSERT INTO notification_channel_checks (channel_id,check_id) VALUES ('c','check-0')").run()
 const messages:unknown[]=[]
 const runtime={...env,CHANNELS_READY:'true',EMAIL_READY:'true',EMAIL_FROM:sender,EMAIL_DESTINATIONS:JSON.stringify([{id:'ops',name:'Ops',address:recipient}]),EMAIL:{send:async(message:unknown)=>{messages.push(message)}}}
 globalThis.fetch=async()=>new Response(null,{status:200});await runChecks(now,runtime as never)
 globalThis.fetch=async()=>new Response(null,{status:500});await runChecks(now+60_000,runtime as never)
 assert.equal(messages.length,1)
 assert.match(JSON.stringify(messages[0]),/down/)
 assert.equal(sqlite.prepare('SELECT state FROM notification_outbox').get()?.state,'sent')
 sqlite.close()
})

test('a first trustworthy unhealthy observation alerts when no automation baseline exists',async()=>{
 for(const prior of ['new','migrated','credential'] as const) {
  const {sqlite,now,env}=fixture()
  const {emailChannelFingerprint}=await import('../../worker/src/email-channel.ts')
  const sender='sender@example.test', recipient='alerts@example.test'
  const fingerprint=await emailChannelFingerprint(sender,recipient)
  sqlite.prepare("INSERT INTO notification_channels (id,name,endpoint_id,endpoint_fingerprint,vault_id,secret_id,enabled,created_at,updated_at,channel_type,recipient_id,email_fingerprint) VALUES ('c','Email','','',0,0,1,0,0,'email','ops',?)").run(fingerprint)
  sqlite.prepare("INSERT INTO notification_channel_checks (channel_id,check_id) VALUES ('c','check-0')").run()
  if(prior!=='new') sqlite.prepare('UPDATE http_checks SET last_scheduled_at=?,last_result_at=?,last_status=?,transition_suppressed=? WHERE id=?').run(now-60_000,now-60_000,'down',prior==='credential'?1:0,'check-0')
  const messages:unknown[]=[]
  const runtime={...env,CHANNELS_READY:'true',EMAIL_READY:'true',EMAIL_FROM:sender,EMAIL_DESTINATIONS:JSON.stringify([{id:'ops',name:'Ops',address:recipient}]),EMAIL:{send:async(message:unknown)=>{messages.push(message)}}}
  globalThis.fetch=async()=>new Response(null,{status:500});await runChecks(now,runtime as never)
  assert.equal(messages.length,1,prior)
  assert.equal(sqlite.prepare('SELECT status FROM automation_transition_state WHERE check_id=?').get('check-0')?.status,'down')
  sqlite.close()
 }
})

test('Basic credentials rotated or deleted after resolution are not sent by tests or scheduled checks', async () => {
  for (const mode of ['test', 'scheduled'] as const) for (const change of ['rotate', 'delete', 'replace'] as const) {
    const { sqlite, now, env } = fixture()
    sqlite.exec(readFileSync(new URL('../../worker/migrations/0008_vault.sql', import.meta.url), 'utf8'))
    const keyHex = 'ab'.repeat(32)
    const { vaultKeyReady } = await import('../../worker/src/vault.ts')
    assert.equal(await vaultKeyReady(env.DB as never, keyHex), true)
    sqlite.prepare('INSERT INTO vaults(id,name,created_at,updated_at) VALUES (1,?,?,?)').run('fixture', now, now)
    const key = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(0xab), 'AES-GCM', false, ['encrypt'])
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    const bytes = await crypto.subtle.encrypt({ name:'AES-GCM', iv:nonce, additionalData:new TextEncoder().encode('status-vault-v1:1:2:userpass') }, key, new TextEncoder().encode(JSON.stringify({username:'fixture-user',password:'fixture-password'})))
    const b64 = (v: Uint8Array) => btoa(Array.from(v, b => String.fromCharCode(b)).join(''))
    sqlite.prepare("INSERT INTO vault_secrets(id,vault_id,name,type,ciphertext,nonce,created_at,updated_at) VALUES (2,1,'fixture','userpass',?,?,?,?)").run(b64(new Uint8Array(bytes)), b64(nonce), now, now)
    sqlite.prepare('UPDATE http_checks SET advanced_config=? WHERE id=?').run(JSON.stringify({ auth:{type:'basic',basic:{vault:{vaultId:1,secretId:2}}} }), 'check-0')
    let changed = false, calls = 0
    const guardedDb = { ...env.DB, prepare(sql: string) {
      if (!changed && sql.includes('SELECT c.advanced_config AS advanced_config FROM http_checks c JOIN endpoint_registry')) {
        changed = true
        if (change === 'delete') sqlite.prepare('DELETE FROM vault_secrets WHERE id=2').run()
        else if (change === 'rotate') sqlite.prepare('UPDATE vault_secrets SET version=version+1 WHERE id=2').run()
        else sqlite.prepare("UPDATE vault_secrets SET nonce='replacement' WHERE id=2").run()
      }
      return env.DB.prepare(sql)
    } }
    globalThis.fetch = async () => { calls++; return new Response() }
    const runtime = { ...env, DB:guardedDb, VAULT_ENCRYPTION_KEY:keyHex, MONITOR_AUTH_READY:'true' }
    if (mode === 'test') {
      const checkVersion = Number(sqlite.prepare('SELECT config_version FROM http_checks WHERE id=?').get('check-0')?.config_version)
      const response = await worker.fetch(new Request('https://probe.internal/test', {method:'POST',body:JSON.stringify({checkId:'check-0',checkVersion})}), runtime as never)
      assert.match(await response.text(), /credential_unavailable/)
    } else {
      await runChecks(now, runtime as never)
      assert.equal(sqlite.prepare('SELECT transition_suppressed FROM http_checks WHERE id=?').get('check-0')?.transition_suppressed, 1)
    }
    assert.equal(changed, true, `${mode} ${change} reached transport fence`)
    assert.equal(calls, 0, `${mode} ${change} sent no credentials`)
    sqlite.close()
  }
})

test('first trustworthy observation after an initial credential fault or maintenance alerts only when unhealthy', async () => {
  for (const reason of ['credential', 'maintenance'] as const) for (const status of [200, 503]) {
    const { sqlite, now, env } = fixture()
    sqlite.exec(readFileSync(new URL('../../worker/migrations/0008_vault.sql', import.meta.url), 'utf8'))
    const checkId = '00000000-0000-4000-8000-000000000001'
    sqlite.prepare('UPDATE http_checks SET id=? WHERE id=?').run(checkId, 'check-0')
    sqlite.prepare("INSERT INTO users (id,issuer,subject,email,role) VALUES ('admin','issuer','subject','admin@example.test','admin')").run()
    const actor = { id: 'admin', email: 'admin@example.test', version: 1 }, key = 'ab'.repeat(32)
    const req = (body: unknown) => new Request('https://status.example/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const { vaultApi } = await import('../../worker/src/vault.ts')
    const { channelApi } = await import('../../worker/src/channels.ts')
    const vault = await (await vaultApi(req({ name: 'fixture' }), env.DB as never, key, actor, '/admin/vaults')).json() as { id: number }
    const token = await (await vaultApi(req({ name: 'token', type: 'value', value: 'fixture-token' }), env.DB as never, key, actor, `/admin/vaults/${vault.id}/secrets`)).json() as { id: number }
    const login = await (await vaultApi(req({ name: 'login', type: 'userpass', userpass: { username: 'fixture', password: 'secret' } }), env.DB as never, key, actor, `/admin/vaults/${vault.id}/secrets`)).json() as { id: number }
    const destinations = JSON.stringify([{ id: 'sink', name: 'Fixture', url: 'https://sink.internal/', binding: 'SINK', serviceId: 'sink-worker' }])
    const bodies: unknown[] = []
    const runtime = { ...env, VAULT_ENCRYPTION_KEY: key, MONITOR_AUTH_READY: 'true', CHANNELS_READY: 'true', CHANNEL_ENDPOINTS: destinations, SINK: { fetch: async (_url: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response(null, { status: 200 }) } } }
    assert.equal((await channelApi(req({ name: 'Channel', endpointId: 'sink', vaultId: vault.id, secretId: token.id, enabled: true, checkIds: [checkId], expectedChecks: [{ id: checkId, componentId: 'component-0', version: Number(sqlite.prepare('SELECT config_version FROM http_checks WHERE id=?').get(checkId)?.config_version) }] }), runtime as never, actor, '/admin/notifications/channels')).status, 201)
    if (reason === 'credential') sqlite.prepare('UPDATE http_checks SET advanced_config=? WHERE id=?').run(JSON.stringify({ auth: { type: 'basic', basic: { vault: { vaultId: vault.id, secretId: login.id } } } }), checkId)
    else sqlite.prepare("INSERT INTO maintenance (id,name,starts_at,ends_at,created_at,updated_at) VALUES ('m','window',?,?,?,?)").run(Date.now() - 1000, Date.now() + 60_000, Date.now(), Date.now())
    globalThis.fetch = async () => new Response(null, { status })
    await runChecks(now, reason === 'credential' ? { ...runtime, VAULT_ENCRYPTION_KEY: 'cd'.repeat(32) } as never : runtime as never)
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM automation_transition_state').get()?.n, 0)
    assert.equal(bodies.length, 0)
    if (reason === 'maintenance') sqlite.prepare("UPDATE maintenance SET ends_at=? WHERE id='m'").run(Date.now() - 1)
    await runChecks(now + 60_000, runtime as never)
    assert.deepEqual(bodies.map(body => (body as { status: string }).status), status === 503 ? ['down'] : [])
    assert.equal(sqlite.prepare('SELECT status FROM automation_transition_state WHERE check_id=?').get(checkId)?.status, status === 503 ? 'down' : 'up')
    sqlite.close()
  }
})

test('first observation after a configuration version change still establishes a baseline without alerting', async () => {
  const { sqlite, now, env } = fixture()
  sqlite.exec(readFileSync(new URL('../../worker/migrations/0008_vault.sql', import.meta.url), 'utf8'))
  const checkId = '00000000-0000-4000-8000-000000000001'
  sqlite.prepare('UPDATE http_checks SET id=?,config_version=2 WHERE id=?').run(checkId, 'check-0')
  sqlite.prepare("INSERT INTO automation_transition_state (check_id,check_version,status) VALUES (?,1,'up')").run(checkId)
  sqlite.prepare("INSERT INTO users (id,issuer,subject,email,role) VALUES ('admin','issuer','subject','admin@example.test','admin')").run()
  const actor = { id: 'admin', email: 'admin@example.test', version: 1 }, key = 'ab'.repeat(32)
  const req = (body: unknown) => new Request('https://status.example/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const { vaultApi } = await import('../../worker/src/vault.ts')
  const { channelApi } = await import('../../worker/src/channels.ts')
  const vault = await (await vaultApi(req({ name: 'fixture' }), env.DB as never, key, actor, '/admin/vaults')).json() as { id: number }
  const token = await (await vaultApi(req({ name: 'token', type: 'value', value: 'fixture-token' }), env.DB as never, key, actor, `/admin/vaults/${vault.id}/secrets`)).json() as { id: number }
  const destinations = JSON.stringify([{ id: 'sink', name: 'Fixture', url: 'https://sink.internal/', binding: 'SINK', serviceId: 'sink-worker' }])
  let deliveries = 0
  const runtime = { ...env, VAULT_ENCRYPTION_KEY: key, CHANNELS_READY: 'true', CHANNEL_ENDPOINTS: destinations, SINK: { fetch: async () => { deliveries++; return new Response(null, { status: 200 }) } } }
  await channelApi(req({ name: 'Channel', endpointId: 'sink', vaultId: vault.id, secretId: token.id, enabled: true, checkIds: [checkId], expectedChecks: [{ id: checkId, componentId: 'component-0', version: Number(sqlite.prepare('SELECT config_version FROM http_checks WHERE id=?').get(checkId)?.config_version) }] }), runtime as never, actor, '/admin/notifications/channels')
  globalThis.fetch = async () => new Response(null, { status: 503 })
  await runChecks(now, runtime as never)
  assert.equal(deliveries, 0)
  assert.deepEqual({ ...sqlite.prepare('SELECT check_version,status FROM automation_transition_state WHERE check_id=?').get(checkId) }, { check_version: 2, status: 'down' })
  sqlite.close()
})
