import { test } from 'node:test'
import assert from 'node:assert/strict'
import { endpointFingerprint, parseEndpoints } from '../../worker/src/endpoint-config.ts'
import { evaluateHttpMonitor, parsePersistedHttpConfig, type HttpMonitorConfig, type HttpMonitorEnvironment } from '../src/http-monitor.ts'

const endpoints = parseEndpoints(JSON.stringify([{ id: 'approved', name: 'Approved', url: 'https://example.test/status' }]))
const registered = endpoints.get('approved')!
const fingerprint = await endpointFingerprint(registered)
const base = (): HttpMonitorConfig => ({ endpointId: 'approved', registryFingerprint: fingerprint })
const environment = (fetcher: HttpMonitorEnvironment['fetch']): HttpMonitorEnvironment => ({ endpoints, fetch: fetcher })

test('allows only the registry target with a matching fingerprint', async () => {
  let calls = 0
  const env = environment(async () => { calls++; return new Response('', { status: 200 }) })
  assert.deepEqual((await evaluateHttpMonitor({ ...base(), endpointId: 'unapproved' }, env)).reasons, ['unapproved_destination'])
  assert.deepEqual((await evaluateHttpMonitor({ ...base(), registryFingerprint: 'wrong' }, env)).reasons, ['destination_fingerprint_mismatch'])
  assert.equal(calls, 0)
  const result = await evaluateHttpMonitor(base(), env)
  assert.equal(result.status, 'up')
  assert.equal(result.httpStatus, 200)
  assert.equal(calls, 1)
})

test('supports request methods, explicit status ranges and header/body assertions', async () => {
  const config: HttpMonitorConfig = { ...base(), method: 'POST', headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' }, body: '{"ping":true}', acceptedStatusRanges: [{ min: 200, max: 204 }, { min: 210, max: 211 }], keyword: 'ready', assertions: [
    { type: 'header', name: 'x-ready', op: 'equals', value: 'yes' },
    { type: 'json', path: '$.nested[0].value', op: 'gt', value: 2 },
  ] }
  const env = environment(async (url, init) => {
    assert.equal(url, registered.url)
    assert.equal(init.method, 'POST')
    assert.equal(init.body, '{"ping":true}')
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer test-secret')
    assert.equal(init.redirect, 'manual')
    return new Response(JSON.stringify({ nested: [{ value: 3 }], health: 'ready' }), { status: 201, headers: { 'x-ready': 'yes' } })
  })
  const result = await evaluateHttpMonitor(config, env)
  assert.equal(result.status, 'up')
  assert.equal(result.httpStatus, 201)
  assert.ok(!JSON.stringify(result).includes('test-secret'))
})

test('defaults to exact 200; retries only down outcomes and never degraded ones', async () => {
  let calls = 0
  const env = environment(async () => {
    calls++
    return calls === 1 ? new Response(null, { status: 503 }) : new Response('ok', { status: 200 })
  })
  const result = await evaluateHttpMonitor({ ...base(), attempts: 3 }, env)
  assert.equal(result.status, 'up')
  assert.equal(result.attempts, 2)
  calls = 0
  const degraded = await evaluateHttpMonitor({ ...base(), keyword: 'missing', attempts: 3 }, environment(async () => { calls++; return new Response('ok') }))
  assert.equal(degraded.status, 'degraded')
  assert.deepEqual(degraded.reasons, ['keyword_missing'])
  assert.equal(calls, 1)
})

test('a down assertion overrides degraded and all observed values remain private', async () => {
  const secret = 'private-response-value'
  const result = await evaluateHttpMonitor({ ...base(), keyword: 'absent', assertions: [
    { type: 'header', name: 'set-cookie', op: 'equals', value: 'expected-secret', onFail: 'down' },
    { type: 'json', path: '$.missing', op: 'exists' },
  ] }, environment(async () => new Response(JSON.stringify({ token: secret }), { headers: { 'set-cookie': secret } })))
  assert.equal(result.status, 'down')
  assert.deepEqual(result.reasons, ['keyword_missing', 'header_assertion_failed', 'json_assertion_failed'])
  assert.ok(!JSON.stringify(result).includes(secret))
  assert.ok(!JSON.stringify(result).includes('expected-secret'))
})

test('rejects redirects before they can be followed, including explicitly accepted 3xx', async () => {
  let calls = 0
  const result = await evaluateHttpMonitor({ ...base(), expectedStatus: 302 }, environment(async (_url, init) => {
    calls++
    assert.equal(init.redirect, 'manual')
    return new Response(null, { status: 302, headers: { location: 'https://sensitive.invalid/path' } })
  }))
  assert.equal(result.status, 'down')
  assert.deepEqual(result.reasons, ['redirect_blocked'])
  assert.equal(calls, 1)
  assert.ok(!JSON.stringify(result).includes('sensitive'))
})

test('stream limits bound JSON parsing without retaining response bodies', async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(300_000).fill(65)) },
    cancel() { cancelled = true },
  })
  const result = await evaluateHttpMonitor({ ...base(), assertions: [{ type: 'json', path: '$.ok', op: 'exists' }] }, environment(async () => new Response(body)))
  assert.equal(result.status, 'degraded')
  assert.deepEqual(result.reasons, ['json_body_too_large'])
  assert.equal(cancelled, true)
  assert.ok(JSON.stringify(result).length < 300)
})

test('invalid settings fail closed before fetch', async () => {
  let calls = 0
  const env = environment(async () => { calls++; return new Response('') })
  for (const bad of [
    { ...base(), method: 'PATCH' },
    { ...base(), headers: { host: 'other.example' } },
    { ...base(), headers: { 'X-Test': 'bad\r\nvalue' } },
    { ...base(), body: 'body', method: 'GET' },
    { ...base(), attempts: 11 },
    { ...base(), assertions: [{ type: 'json', path: '$.bad[', op: 'exists' }] },
    { ...base(), acceptedStatusRanges: [{ min: 400, max: 200 }] },
  ]) assert.deepEqual((await evaluateHttpMonitor(bad as HttpMonitorConfig, env)).reasons, ['invalid_configuration'])
  assert.equal(calls, 0)
})

test('timeout and exceptions are redacted and retries are bounded', async () => {
  let calls = 0
  const timeout = await evaluateHttpMonitor({ ...base(), timeoutMs: 1000, attempts: 2 }, environment(async (_url, init) => {
    calls++
    return await new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('private-secret-url'))))
  }))
  assert.equal(calls, 2)
  assert.deepEqual(timeout.reasons, ['request_timeout'])
  assert.equal(timeout.attempts, 2)
  assert.ok(!JSON.stringify(timeout).includes('private-secret-url'))
  const error = await evaluateHttpMonitor(base(), environment(async () => { throw new Error('private-secret-url') }))
  assert.deepEqual(error.reasons, ['request_failed'])
  assert.ok(!JSON.stringify(error).includes('private-secret-url'))
})

test('body read shares the deadline and cancels a stalled stream', async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull() { return new Promise(() => {}) },
    cancel() { cancelled = true },
  })
  const result = await evaluateHttpMonitor({ ...base(), timeoutMs: 1000, keyword: 'ready' }, environment(async () => new Response(body)))
  assert.equal(result.status, 'down')
  assert.deepEqual(result.reasons, ['request_timeout'])
  assert.equal(cancelled, true)
})

test('post responses may be retried but configured credential material never enters errors', async () => {
  const secret = 'Bearer credential-which-must-not-appear'
  const result = await evaluateHttpMonitor({ ...base(), method: 'POST', body: 'private body', headers: { Authorization: secret }, attempts: 2 }, environment(async () => { throw new Error(secret) }))
  assert.equal(result.status, 'down')
  assert.equal(result.attempts, 2)
  assert.ok(!JSON.stringify(result).includes(secret))
  assert.ok(!JSON.stringify(result).includes('private body'))
})

test('evaluates upstream-compatible JSON path and missing-value semantics', async () => {
  const result = await evaluateHttpMonitor({ ...base(), assertions: [
    { type: 'json', path: '$.list', op: 'contains', value: '2' },
    { type: 'json', path: '$.number', op: 'lt', value: 6 },
    { type: 'json', path: "$['escaped-name']", op: 'equals', value: 'works' },
    { type: 'json', path: '$.missing', op: 'not-equals', value: 'anything' },
    { type: 'header', name: 'x-absent', op: 'not-exists' },
  ] }, environment(async () => new Response(JSON.stringify({ list: [2, 3], number: '5', 'escaped-name': 'works' }))))
  assert.equal(result.status, 'up')
  assert.deepEqual(result.reasons, [])
})

test('invalid JSON honors each assertion failure severity', async () => {
  const result = await evaluateHttpMonitor({ ...base(), assertions: [
    { type: 'json', path: '$.ok', op: 'exists' },
    { type: 'json', path: '$.ok', op: 'equals', value: 'yes', onFail: 'down' },
  ] }, environment(async () => new Response('not-json')))
  assert.equal(result.status, 'down')
  assert.deepEqual(result.reasons, ['invalid_json_body', 'invalid_json_body'])
})

test('unsupported TLS and authentication options are rejected rather than silently ignored', async () => {
  let calls = 0
  const env = environment(async () => { calls++; return new Response() })
  // Runtime validation is exercised via untyped inputs, as with a future API payload.
  const config = { ...base(), ignoreTls: true, auth: { type: 'basic' } }
  const result = await evaluateHttpMonitor(config as HttpMonitorConfig, env)
  assert.equal(result.status, 'down')
  assert.deepEqual(result.reasons, ['invalid_configuration'])
  assert.equal(calls, 0)
})

test('declared oversized JSON is not treated as a passing assertion', async () => {
  const result = await evaluateHttpMonitor({ ...base(), assertions: [{ type: 'json', path: '$.ok', op: 'exists' }] }, environment(async () => new Response('{"ok":true}', { headers: { 'content-length': '2000000' } })))
  assert.equal(result.status, 'degraded')
  assert.deepEqual(result.reasons, ['json_body_too_large'])
})

test('accepts case-insensitive upstream method names', async () => {
  const result = await evaluateHttpMonitor({ ...base(), method: 'pOsT', body: 'payload' }, environment(async (_url, init) => {
    assert.equal(init.method, 'POST')
    return new Response(null, { status: 200 })
  }))
  assert.equal(result.status, 'up')
})

test('fingerprint binds a snapshot even if the registry object changes while hashing', async () => {
  const local = parseEndpoints(JSON.stringify([{ id: 'local', name: 'Local', url: 'https://example.test/original' }]))
  const localEndpoint = local.get('local')!
  const originalFingerprint = await endpointFingerprint(localEndpoint)
  let contacted = ''
  const pending = evaluateHttpMonitor({ endpointId: 'local', registryFingerprint: originalFingerprint }, {
    endpoints: local,
    fetch: async (url) => { contacted = url; return new Response() },
  })
  localEndpoint.url = 'https://not-approved.invalid/'
  const result = await pending
  assert.equal(result.status, 'up')
  assert.equal(contacted, 'https://example.test/original')
})

test('persisted scheduled checks cap the total timeout and retry budget', () => {
  const parse = (value: unknown) => parsePersistedHttpConfig(value, 'approved', fingerprint, 200)
  assert.ok(parse({ timeoutMs: 1000, attempts: 10 }))
  assert.ok(parse({ timeoutMs: 5000, attempts: 2 }))
  assert.equal(parse({ timeoutMs: 5001, attempts: 2 }), null)
  assert.equal(parse({ attempts: 2 }), null)
  assert.equal(parse({ timeoutMs: 300000, attempts: 1 }), null)
})
