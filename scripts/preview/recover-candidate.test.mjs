import test from 'node:test'
import assert from 'node:assert/strict'
import { newRelease } from './release-contract.mjs'
import { recoverCandidate } from './recover-candidate.mjs'

test('retries interrupted activation and promotes only after verification', async () => {
  const ref = 'refs/heads/feat/test'
  const sha = 'a'.repeat(40)
  let record = { ...newRelease({ ref, sha }), candidate: { sha, generation: 1, phase: 'activating', resources: { gateway: 'worker' } } }
  let revision = 1
  const store = { read: async () => ({ revision, record }), compareAndSwap: async (_ref, expected, next) => { assert.equal(expected, revision); revision++; record = next; return true } }
  await assert.rejects(recoverCandidate({ ref, sha, store, readRemoteHead: async () => sha, activate: async () => { throw new Error('still unavailable') } }), /unavailable/)
  assert.equal(record.candidate.phase, 'activating')
  await recoverCandidate({ ref, sha, store, readRemoteHead: async () => sha, activate: async input => assert.equal(input.resources.gateway, 'worker') })
  assert.equal(record.active.sha, sha)
  assert.equal(record.candidate, null)
})
