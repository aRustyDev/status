import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getGatusSnapshot, type GatusBinding, type GatusCatalogEntry } from '../src/gatus'

const now = Date.parse('2026-11-23T20:00:00Z')
const catalog: GatusCatalogEntry[] = [
  { kind: 'endpoint', key: 'core_http', name: 'HTTP', group: 'Core', staleAfterSeconds: 180, advisory: false },
  { kind: 'endpoint', key: 'advisories_cert', name: 'Certificate', group: 'Advisories', staleAfterSeconds: 64800, advisory: true },
  { kind: 'suite', key: 'core_multi', name: 'Multi', group: 'Core', staleAfterSeconds: 900, advisory: false },
]
function status(key: string, name: string, group: string, success: boolean, minutesAgo = 0, extra: Record<string, unknown> = {}) {
  return { key, name, group, results: [{ success, timestamp: new Date(now - minutesAgo * 60_000).toISOString(), duration: 7_000_000, ...extra }] }
}
const endpoints = () => [status('core_http', 'HTTP', 'Core', true, 1), status('advisories_cert', 'Certificate', 'Advisories', false, 300)]
const suites = () => [status('core_multi', 'Multi', 'Core', false, 1, { endpointResults: [{ secret: 'ignore' }] })]
function mockBinding(endpointBody: unknown = endpoints(), suiteBody: unknown = suites()): GatusBinding {
  return { async fetch(request) {
    const url = new URL(request.url)
    assert.equal(url.host, 'gatus.internal')
    assert.equal(url.searchParams.get('pageSize'), '1')
    assert.equal(request.method, 'GET')
    assert.equal(request.redirect, 'manual')
    assert.equal(request.headers.get('authorization'), null)
    return Response.json(url.pathname.includes('/endpoints/') ? endpointBody : suiteBody)
  } }
}

test('maps independently configured cadence, suites and advisory failures without exposing upstream internals', async () => {
  const result = await getGatusSnapshot(mockBinding(), catalog, { now })
  assert.equal(result.available, true)
  assert.deepEqual(result.monitors.map(m => m.health), ['up', 'degraded', 'down'])
  assert.deepEqual(result.monitors.map(m => m.durationMs), [7, 7, 7])
  assert.equal(result.monitors[0].lastCheckedAt, now - 60_000)
  assert.equal(result.monitors[0].sourceId, JSON.stringify(['gatus', 'endpoint', 'Core', 'HTTP']))
  assert.doesNotMatch(JSON.stringify(result), /endpointResults|secret|core_http/)
})

test('missing, stale, future, and invalid results stay pending', async () => {
  const invalid = [
    status('core_http', 'HTTP', 'Core', true, 4),
    { key: 'advisories_cert', name: 'Certificate', group: 'Advisories', results: [{ success: true, timestamp: new Date(now + 120_000).toISOString() }] },
  ]
  const result = await getGatusSnapshot(mockBinding(invalid, [{ key: 'core_multi', name: 'Multi', group: 'Core', results: [] }]), catalog, { now })
  assert.equal(result.available, true)
  assert.deepEqual(result.monitors.map(m => m.health), ['pending', 'pending', 'pending'])
  assert.equal(result.monitors[0].lastCheckedAt, now - 4 * 60_000)
  assert.equal(result.monitors[1].lastCheckedAt, null)
})

test('a name mismatch makes the entire source unavailable', async () => {
  const responses = [
    { key: 'core_http', name: 'wrong', group: 'Core', results: [{ success: true, timestamp: new Date(now).toISOString() }] },
    { key: 'advisories_cert', name: 'Certificate', group: 'Advisories', results: [
      { success: true, timestamp: new Date(now - 60_000).toISOString() },
      { success: false, timestamp: new Date(now - 1000).toISOString() },
      { success: true, timestamp: 'invalid' },
    ] },
  ]
  const result = await getGatusSnapshot(mockBinding(responses, suites()), catalog, { now })
  assert.equal(result.available, false)
  assert.deepEqual(result.monitors.map(m => m.health), ['pending', 'pending', 'pending'])
})

test('an ignored page limit cannot mask an invalid newest result with older healthy data', async () => {
  const responses = [endpoints()[0], { key: 'advisories_cert', name: 'Certificate', group: 'Advisories', results: [
    { success: true, timestamp: new Date(now - 60_000).toISOString() },
    { success: false, timestamp: new Date(now - 1000).toISOString() },
    { success: true, timestamp: 'invalid' },
  ] }]
  const result = await getGatusSnapshot(mockBinding(responses, suites()), catalog, { now })
  assert.equal(result.available, false)
  assert.deepEqual(result.monitors.map(m => m.health), ['pending', 'pending', 'pending'])
})

test('a partial or ambiguous upstream response fails closed for the entire snapshot', async () => {
  const duplicate = [...endpoints(), endpoints()[0]]
  for (const binding of [
    mockBinding(duplicate, suites()),
    mockBinding(endpoints().slice(0, 1), suites()),
    mockBinding([...endpoints(), status('extra', 'Extra', 'Core', true)], suites()),
    { async fetch(request: Request) { return new URL(request.url).pathname.includes('suites') ? new Response('error', { status: 500 }) : Response.json(endpoints()) } },
    mockBinding('not an array', suites()),
    { async fetch() { return new Response('not json', { headers: { 'content-type': 'application/json' } }) } },
  ]) {
    const result = await getGatusSnapshot(binding, catalog, { now })
    assert.equal(result.available, false)
    assert.deepEqual(result.monitors.map(m => m.health), ['pending', 'pending', 'pending'])
  }
})

test('a single malformed success, duration or future timestamp is pending', async () => {
  for (const badSample of [
    { success: 'true', timestamp: new Date(now).toISOString(), duration: 1 },
    { success: true, timestamp: new Date(now).toISOString(), duration: 'bad' },
    { success: true, timestamp: new Date(now + 120_000).toISOString(), duration: 1 },
  ]) {
    const result = await getGatusSnapshot(mockBinding([
      { key: 'core_http', name: 'HTTP', group: 'Core', results: [badSample] }, endpoints()[1],
    ], suites()), catalog, { now })
    assert.equal(result.monitors[0].health, 'pending')
  }
})

test('catalog rejects source key collisions and malformed cadence before contacting Gatus', async () => {
  let called = false
  const binding = { async fetch() { called = true; return Response.json([]) } }
  await assert.rejects(getGatusSnapshot(binding, [...catalog, { ...catalog[0], name: 'Colliding name' }], { now }), /Ambiguous/)
  await assert.rejects(getGatusSnapshot(binding, [{ ...catalog[0], staleAfterSeconds: 0 }], { now }), /Invalid/)
  await assert.rejects(getGatusSnapshot(binding, [], { now }), /Invalid/)
  await assert.rejects(getGatusSnapshot(binding, [{ ...catalog[0], name: 'https://private.example' }], { now }), /Invalid/)
  assert.equal(called, false)
})

test('an over-limit response or hanging connection yields pending without exposing upstream data', async () => {
  const large = { async fetch() { return new Response('x'.repeat(1_048_577), { headers: { 'content-type': 'application/json' } }) } }
  const hanging = { async fetch() { return await new Promise<Response>(() => {}) } }
  for (const binding of [large, hanging]) {
    const result = await getGatusSnapshot(binding, catalog, { now, timeoutMs: 20 })
    assert.equal(result.available, false)
    assert.ok(result.monitors.every(m => m.health === 'pending'))
  }
})

test('a null response is empty only for a kind absent from the reviewed catalog', async () => {
  const endpointsOnly = catalog.filter(entry => entry.kind === 'endpoint')
  const valid = await getGatusSnapshot(mockBinding(endpoints(), null), endpointsOnly, { now })
  assert.equal(valid.available, true)
  assert.deepEqual(valid.monitors.map(item => item.health), ['up', 'degraded'])

  const missingSuite = await getGatusSnapshot(mockBinding(endpoints(), null), catalog, { now })
  assert.equal(missingSuite.available, false)
  assert.ok(missingSuite.monitors.every(item => item.health === 'pending'))

  const suitesOnly = catalog.filter(entry => entry.kind === 'suite')
  const validSuites = await getGatusSnapshot(mockBinding(null, suites()), suitesOnly, { now })
  assert.equal(validSuites.available, true)
  assert.equal(validSuites.monitors[0].health, 'down')
  const missingEndpoints = await getGatusSnapshot(mockBinding(null, suites()), catalog, { now })
  assert.equal(missingEndpoints.available, false)
  assert.ok(missingEndpoints.monitors.every(item => item.health === 'pending'))
})

test('a response body stalled beyond its timeout is cancelled and all monitors remain pending', async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    pull() { return new Promise(() => {}) },
    cancel() { cancelled = true },
  })
  const binding: GatusBinding = { async fetch(request) {
    return new URL(request.url).pathname.includes('/endpoints/')
      ? new Response(stream, { headers: { 'content-type': 'application/json' } })
      : Response.json(suites())
  } }
  const result = await getGatusSnapshot(binding, catalog, { now, timeoutMs: 20 })
  assert.equal(result.available, false)
  assert.ok(result.monitors.every(item => item.health === 'pending'))
  assert.equal(cancelled, true)
})
