import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { checkFallback, FallbackConflictError, getFallback, publishFallback, saveFallback } from '../src/static-fallback.ts'

test('fallback publication preserves the last successful snapshot across failures and disable races', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response() } }', compatibilityDate: '2026-11-23', r2Buckets: ['FALLBACK'] }))
  try {
    const bucket = await mf.getR2Bucket('FALLBACK') as unknown as R2Bucket
    assert.deepEqual(await checkFallback(bucket), { ok: true, error: null })
    assert.equal((await getFallback(bucket)).health, 'disabled')
    await saveFallback(bucket, { enabled: true, intervalSeconds: 60 })
    const first = await publishFallback(bucket, async () => ({ value: 1 }))
    assert.equal(first.health, 'ok')
    const failed = await publishFallback(bucket, async () => { throw new Error('private provider details') })
    assert.equal(failed.health, 'error')
    assert.equal(failed.status.lastError, 'Snapshot publication failed')
    const saved = await bucket.get('fallback/current.json')
    assert.deepEqual((await saved!.json() as {snapshot:unknown}).snapshot, { value: 1 })
    const recovered = await publishFallback(bucket, async () => ({ value: 2 }))
    assert.equal(recovered.health, 'ok')
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    let started!: () => void
    const startedPromise = new Promise<void>(resolve => { started = resolve })
    const publication = publishFallback(bucket, async () => { started(); await waiting; return { value: 3 } })
    await startedPromise
    await saveFallback(bucket, { enabled: false, intervalSeconds: 60 })
    await saveFallback(bucket, { enabled: true, intervalSeconds: 60 })
    release()
    await assert.rejects(publication, FallbackConflictError)
    const final = await bucket.get('fallback/current.json')
    const state = await final!.json() as { enabled: boolean; snapshot: unknown }
    assert.equal(state.enabled, true)
    assert.deepEqual(state.snapshot, { value: 2 })
  } finally { await mf.dispose() }
})
