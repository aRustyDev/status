import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boundedBody, ReceiptError } from '../src/idempotency.ts'

test('body reads reject oversized and stalled streams before unbounded buffering', async () => {
  const request = (body: ReadableStream<Uint8Array>) => new Request('https://example.test/', { method: 'POST', body, duplex: 'half' } as RequestInit)
  const big = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(256_001)); controller.close() } })
  await assert.rejects(boundedBody(request(big), false, 100), (error: unknown) => error instanceof ReceiptError && error.status === 413)
  let cancelled = false
  const slow = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}) }, cancel() { cancelled = true } })
  await assert.rejects(boundedBody(request(slow), false, 20), (error: unknown) => error instanceof ReceiptError && error.status === 408)
  assert.equal(cancelled, true)
  let clonedCancelled = false
  const cloned = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}) }, cancel() { clonedCancelled = true } })
  await assert.rejects(boundedBody(request(cloned), true, 20), (error: unknown) => error instanceof ReceiptError && error.status === 408)
  await Promise.resolve()
  assert.equal(clonedCancelled, true)
})
