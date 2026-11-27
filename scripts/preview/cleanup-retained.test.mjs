import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanupRetained } from './cleanup-retained.mjs'

function fixture() {
  let revision = 1
  let record = { ref: 'refs/heads/feat/test', active: { sha: 'a' }, previous: { sha: 'b' }, candidate: null, retained: [{ sha: 'c', retainedAt: 1, resources: { gateway: 'c' } }, { sha: 'd', retainedAt: 3_900_000, resources: { gateway: 'd' } }] }
  const store = { read: async () => ({ revision, record }), compareAndSwap: async (_ref, expected, updated) => { assert.equal(expected, revision); revision++; record = updated; return true } }
  return { store, get record() { return record } }
}
test('retained cleanup preserves active and previous, waits for grace and retries safely', async () => {
  const f = fixture()
  const events = []
  const opts = { ref: f.record.ref, store: f.store, now: () => 4_000_000, removeBindings: async ({ releases }) => events.push(['unbind', releases.map(item => item.sha)]), deleteResources: async () => { throw new Error('timeout') } }
  await assert.rejects(cleanupRetained(opts), /timeout/)
  assert.equal(f.record.retainedCleanup.sha, 'c')
  opts.deleteResources = async ({ release }) => events.push(['delete', release.sha])
  assert.equal((await cleanupRetained(opts)).status, 'deleted')
  assert.equal(f.record.active.sha, 'a')
  assert.equal(f.record.previous.sha, 'b')
  assert.deepEqual(f.record.retained.map(item => item.sha), ['d'])
  assert.deepEqual(events.at(-1), ['delete', 'c'])
})
test('retained cleanup never removes an active or previous SHA', async () => {
  const f = fixture()
  f.record.retained.push({ sha: 'a', retainedAt: 1, resources: {} })
  f.record.retained = f.record.retained.filter(item => item.sha === 'a')
  assert.equal((await cleanupRetained({ ref: f.record.ref, store: f.store, now: () => 4_000_000, removeBindings: async () => assert.fail(), deleteResources: async () => assert.fail() })).status, 'draining')
})
