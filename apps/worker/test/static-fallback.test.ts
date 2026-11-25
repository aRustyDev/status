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
    await saveFallback(bucket, { enabled: true, intervalSeconds: 60 }, (await getFallback(bucket)).settingsRevision)
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
    await saveFallback(bucket, { enabled: false, intervalSeconds: 60 }, (await getFallback(bucket)).settingsRevision)
    await saveFallback(bucket, { enabled: true, intervalSeconds: 60 }, (await getFallback(bucket)).settingsRevision)
    release()
    await assert.rejects(publication, FallbackConflictError)
    await assert.rejects(saveFallback(bucket, { enabled: false, intervalSeconds: 60 }, 'initial'), FallbackConflictError)
    const final = await bucket.get('fallback/current.json')
    const state = await final!.json() as { enabled: boolean; snapshot: unknown }
    assert.equal(state.enabled, true)
    assert.deepEqual(state.snapshot, { value: 2 })
  } finally { await mf.dispose() }
})

test('settings revisions reject stale edits while publication preserves the revision', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response() } }', r2Buckets: ['FALLBACK'] }))
  try {
    const bucket = await mf.getR2Bucket('FALLBACK') as unknown as R2Bucket
    // Objects written before settings revisions were introduced remain editable.
    await bucket.put('fallback/current.json', JSON.stringify({
      revision: 'old', enabled: false, settings: { enabled: false, intervalSeconds: 60 }, snapshot: null,
      status: { lastRunAt: null, lastSuccessAt: null, lastError: null }, runs: [],
    }))
    const stale = await getFallback(bucket)
    assert.equal(stale.settingsRevision, 'initial')
    const enabled = await saveFallback(bucket, { enabled: true, intervalSeconds: 60 }, stale.settingsRevision)
    const published = await publishFallback(bucket, async () => ({ value: 1 }))
    assert.equal(published.settingsRevision, enabled.settingsRevision)
    await assert.rejects(saveFallback(bucket, { enabled: false, intervalSeconds: 300 }, stale.settingsRevision), FallbackConflictError)
    const current = await getFallback(bucket)
    assert.equal(current.settings.enabled, true)
    assert.equal(current.settings.intervalSeconds, 60)
    const disabled = await saveFallback(bucket, { enabled: false, intervalSeconds: 300 }, current.settingsRevision)
    assert.notEqual(disabled.settingsRevision, current.settingsRevision)
  } finally { await mf.dispose() }
})
