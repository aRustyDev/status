import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcilePreviews } from './reconcile.mjs'

test('reconciliation retires deleted branches and schedules only tested, current heads', async () => {
  const sha = 'a'.repeat(40)
  const calls = []
  const current = { ref: 'refs/heads/feat/one', sha }
  const stale = { ref: 'refs/heads/fix/stale', sha }
  const pending = { ref: 'refs/heads/stage/pending', sha }
  const result = await reconcilePreviews({
    branches: { list: async () => [current, stale, pending], head: async ref => ref.includes('stale') ? 'b'.repeat(40) : ref.includes('deleted') ? null : sha },
    store: { list: async () => [{ record: { ref: 'refs/heads/feat/deleted' } }, { record: { ref: pending.ref, candidate: {} } }] },
    retire: async ref => { calls.push(['retire', ref]); return { status: 'draining' } },
    ciStatus: async () => 'success', dispatchCi: async ref => calls.push(['ci', ref]), dispatchPreview: async (ref, commit) => calls.push(['preview', ref, commit]),
  })
  assert.deepEqual(calls, [['retire', 'refs/heads/feat/deleted'], ['preview', current.ref, sha]])
  assert.equal(result.retired[0].status, 'draining')
  assert.equal(result.pending[0].ref, pending.ref)
})

test('missing CI is dispatched once and failed CI is not retried by reconciliation', async () => {
  const sha = 'a'.repeat(40)
  const calls = []
  const rows = ['one', 'two'].map(name => ({ ref: `refs/heads/feat/${name}`, sha }))
  const result = await reconcilePreviews({
    branches: { list: async () => rows, head: async () => sha }, store: { list: async () => [] }, retire: async () => {},
    ciStatus: async ref => ref.endsWith('one') ? 'missing' : 'failure', dispatchCi: async ref => calls.push(ref), dispatchPreview: async () => assert.fail(),
  })
  assert.deepEqual(calls, [rows[0].ref])
  assert.equal(result.pending[0].reason, 'CI failure')
})
