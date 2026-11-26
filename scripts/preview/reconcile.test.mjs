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

test('a stale preparation is abandoned without publishing and retains its resource record', async () => {
  const sha = 'b'.repeat(40)
  const ref = 'refs/heads/feat/one'
  const old = { sha: 'a'.repeat(40), generation: 1, phase: 'preparing', resources: { database: { id: 'owned' } } }
  let updated
  const result = await reconcilePreviews({
    branches: { list: async () => [{ ref, sha }], head: async () => sha },
    store: { list: async () => [{ revision: 3, record: { ref, candidate: old, active: null } }], compareAndSwap: async (_ref, revision, record) => { assert.equal(revision, 3); updated = record; return true } },
    retire: async () => {}, ciStatus: async () => 'success', dispatchCi: async () => assert.fail(), dispatchPreview: async () => {},
  })
  assert.equal(updated.candidate, null)
  assert.equal(updated.abandoned[0].resources.database.id, 'owned')
  assert.equal(result.scheduled[0].sha, sha)
})

test('deleted branch with a preparing candidate preserves resources and retires', async () => {
  const ref = 'refs/heads/feat/deleted'
  const candidate = { sha: 'a'.repeat(40), generation: 1, phase: 'preparing', resources: { database: { id: 'db', owned: true } } }
  let record = { ref, candidate, active: { sha: 'b'.repeat(40) } }
  let retired = false
  const result = await reconcilePreviews({
    branches: { list: async () => [], head: async () => null },
    store: { list: async () => [{ revision: 1, record }], compareAndSwap: async (_ref, revision, updated) => { assert.equal(revision, 1); record = updated; return true } },
    retire: async () => { retired = true; assert.equal(record.candidate, null); assert.equal(record.abandoned[0].resources.database.id, 'db'); return { status: 'draining' } },
    ciStatus: async () => assert.fail(), dispatchCi: async () => assert.fail(), dispatchPreview: async () => assert.fail(),
  })
  assert.equal(retired, true)
  assert.equal(result.errors.length, 0)
})

test('deleted branch leaves an ambiguous activation and active route untouched', async () => {
  const ref = 'refs/heads/feat/deleted'
  const record = { ref, candidate: { sha: 'a'.repeat(40), phase: 'activating' }, active: { sha: 'b'.repeat(40) } }
  const result = await reconcilePreviews({
    branches: { list: async () => [], head: async () => null }, store: { list: async () => [{ revision: 1, record }] },
    recoverCandidate: async () => assert.fail('ambiguous activation must be resolved by an operator'),
    retire: async () => assert.fail('must not disable routing while activation is ambiguous'), ciStatus: async () => assert.fail(), dispatchCi: async () => assert.fail(), dispatchPreview: async () => assert.fail(),
  })
  assert.match(result.errors[0].message, /operator reconciliation/)
  assert.equal(record.active.sha, 'b'.repeat(40))
})
