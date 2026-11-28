import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanupAbandoned } from './cleanup-abandoned.mjs'

function fixture(resources = { workers: {} }) {
  let record = { ref: 'refs/heads/feat/test', abandoned: [{ sha: 'a'.repeat(40), generation: 1, abandonedAt: 1, resources }], active: null, previous: null, candidate: null }
  let revision = 1
  const store = { read: async () => ({ revision, record }), compareAndSwap: async (_ref, expected, updated) => { assert.equal(expected, revision); revision++; record = updated; return true } }
  return { store, get record() { return record } }
}
test('abandoned cleanup waits for grace and retries deletion using a durable marker', async () => {
  const f = fixture()
  assert.equal((await cleanupAbandoned({ ref: f.record.ref, store: f.store, now: () => 2, deleteResources: async () => assert.fail() })).status, 'draining')
  await assert.rejects(cleanupAbandoned({ ref: f.record.ref, store: f.store, now: () => 4_000_000, deleteResources: async () => { throw new Error('timeout') } }), /timeout/)
  assert.equal(f.record.abandonedCleanup.sha, 'a'.repeat(40))
  assert.equal((await cleanupAbandoned({ ref: f.record.ref, store: f.store, now: () => 4_000_001, deleteResources: async () => ({}) })).status, 'deleted')
  assert.equal(f.record.abandoned.length, 0)
  assert.equal(f.record.abandonedCleanup, null)
})
test('unconfirmed database intent stays recorded for later inspection', async () => {
  const f = fixture({ databaseIntent: { name: 'db' } })
  const result = await cleanupAbandoned({ ref: f.record.ref, store: f.store, now: () => 4_000_000, deleteResources: async () => ({ unresolved: true }) })
  assert.equal(result.status, 'unresolved')
  assert.equal(f.record.abandoned[0].resources.databaseIntent.name, 'db')
  assert.equal(f.record.abandonedCleanup, null)
})

test('zero grace cleans a known abandoned candidate without an hour delay', async () => {
  const f = fixture()
  const result = await cleanupAbandoned({ ref: f.record.ref, store: f.store, graceMs: 0, now: () => 2, deleteResources: async () => ({}) })
  assert.equal(result.status, 'deleted')
  assert.deepEqual(f.record.abandoned, [])
})
