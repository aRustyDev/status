import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { ProbeTestTimeout, requestProbeTest } from '../src/probe-test'

test('a stalled probe binding times out and receives an abort signal', async () => {
  let forwarded: Request | undefined
  const service = { fetch(request: Request) { forwarded = request; return new Promise<Response>(() => {}) } }
  await assert.rejects(requestProbeTest(service, { endpointId: 'approved' }, new AbortController().signal, 10), ProbeTestTimeout)
  assert.equal(forwarded?.signal.aborted, true)
})

test('caller cancellation aborts the probe binding without waiting for the deadline', async () => {
  let forwarded: Request | undefined
  const service = { fetch(request: Request) { forwarded = request; return new Promise<Response>(() => {}) } }
  const caller = new AbortController()
  const result = requestProbeTest(service, {}, caller.signal)
  await Promise.resolve()
  caller.abort()
  await assert.rejects(result, ProbeTestTimeout)
  assert.equal(forwarded?.signal.aborted, true)
})

test('an already-cancelled request never reaches the probe binding', async () => {
  let calls = 0
  const caller = new AbortController()
  caller.abort()
  await assert.rejects(requestProbeTest({ async fetch() { calls++; return new Response() } }, {}, caller.signal), ProbeTestTimeout)
  assert.equal(calls, 0)
})

test('a normal probe response is returned unchanged', async () => {
  const response = Response.json({ overall: 'ok' })
  assert.equal(await requestProbeTest({ async fetch() { return response } }, {}, new AbortController().signal), response)
})
