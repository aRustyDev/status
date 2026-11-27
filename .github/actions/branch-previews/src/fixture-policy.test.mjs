import test from 'node:test'
import assert from 'node:assert/strict'
import { fixturePolicy, fixtureVaultKey, fixtureScheduleKey } from './fixture-policy.mjs'

const sha = 'a'.repeat(40)

test('fixture approval is explicit, exact-commit, and uses isolated schema resources', () => {
  const ref = 'refs/heads/feat/example'
  const approval = { sha, cas: true, subscriber: false, probe: true }
  assert.deepEqual(fixturePolicy(undefined, ref, sha), { enabled: false, environment: 'dev' })
  assert.deepEqual(fixturePolicy({ branches: { [ref]: approval } }, ref, sha), { enabled: true, environment: 'schema', cas: true, subscriber: false, probe: true })
  assert.throws(() => fixturePolicy({ branches: { [ref]: approval } }, ref, 'b'.repeat(40)), /does not match/)
  assert.deepEqual(fixturePolicy({ branches: { [ref]: approval } }, 'refs/heads/stage/other', sha), { enabled: false, environment: 'stage' })
})

test('invalid approvals fail closed', () => {
  assert.throws(() => fixturePolicy({ branches: { 'refs/heads/main': sha } }, 'refs/heads/feat/test', sha), /Invalid fixture approval/)
  assert.throws(() => fixturePolicy({ branches: { 'refs/heads/feat/test': '*' } }, 'refs/heads/feat/test', sha), /Invalid fixture approval/)
  assert.throws(() => fixturePolicy({ branches: [] }, 'refs/heads/feat/test', sha), /Invalid isolated/)
})

test('fixture Vault keys are stable for a release and distinct between releases and branches', () => {
  const root = 'ab'.repeat(32), selector = 'branch-' + 'a'.repeat(24)
  const key = fixtureVaultKey(root, selector, sha)
  assert.match(key, /^[a-f0-9]{64}$/)
  assert.equal(key, fixtureVaultKey(root, selector, sha))
  assert.notEqual(key, fixtureVaultKey(root, selector, 'b'.repeat(40)))
  assert.notEqual(key, fixtureVaultKey(root, 'branch-' + 'b'.repeat(24), sha))
  assert.notEqual(key, fixtureScheduleKey(root, selector, sha))
  assert.throws(() => fixtureVaultKey('too-short', selector, sha), /Invalid/)
})
