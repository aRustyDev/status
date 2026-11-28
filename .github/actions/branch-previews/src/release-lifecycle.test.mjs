import assert from 'node:assert/strict'
import test from 'node:test'
import { retireDeletedBranch } from './release-lifecycle.mjs'

function fixture() {
  let revision = 1
  let record = { ref: 'refs/heads/feat/test', selector: 'branch-key', environment: 'dev', candidate: null, active: { sha: 'one', resources: {} }, previous: null, retained: [] }
  const events = []
  const store = {
    read: async () => ({ revision, record }),
    compareAndSwap: async (_ref, expected, next) => {
      if (expected !== revision) return false
      record = next
      revision++
      return true
    },
  }
  return { events, get record() { return record }, options: {
    ref: record.ref, store, readRemoteHead: async () => null, now: () => 100,
    disableFlag: async () => events.push('disable'),
    removeBindings: async () => events.push('unbind'),
    deleteOwnedResources: async () => events.push('delete'),
    propagationElapsed: async () => false,
  } }
}

test('retirement waits for propagation before removing resources', async () => {
  const f = fixture()
  assert.deepEqual(await retireDeletedBranch(f.options), { status: 'draining' })
  assert.deepEqual(f.events, ['disable'])
  f.options.propagationElapsed = async () => true
  assert.deepEqual(await retireDeletedBranch(f.options), { status: 'deleted' })
  assert.deepEqual(f.events, ['disable', 'unbind', 'delete'])
  assert.equal(f.record.active, null)
})

test('zero delay retires a deleted branch in a single reconciliation', async () => {
  const f = fixture()
  f.options.propagationElapsed = async () => true
  assert.deepEqual(await retireDeletedBranch(f.options), { status: 'deleted' })
  assert.deepEqual(f.events, ['disable', 'unbind', 'delete'])
  assert.equal(f.record.active, null)
})

test('retirement blocks ambiguous candidates and recreated branches', async () => {
  const f = fixture()
  f.record.candidate = { sha: 'pending' }
  await assert.rejects(retireDeletedBranch(f.options), /reconciliation/)
  f.record.candidate = null
  let calls = 0
  f.options.readRemoteHead = async () => ++calls === 1 ? null : 'sha'
  f.options.propagationElapsed = async () => true
  await assert.rejects(retireDeletedBranch(f.options), /recreated/)
  assert.deepEqual(f.events, ['disable'])
})

test('duplicate retained releases are deleted only once', async () => {
  const f = fixture()
  f.record.previous = { ...f.record.active }
  f.record.retained = [{ ...f.record.active }]
  f.options.propagationElapsed = async () => true
  await retireDeletedBranch(f.options)
  assert.deepEqual(f.events, ['disable', 'unbind', 'delete'])
})
