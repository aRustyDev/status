import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { defineInstallation } from '../src/installation.mjs'
import { relativePath, validateManifest } from '../src/manifest.mjs'
import manifest from './fixtures/status.json' with { type: 'json' }

test('manifest accepts nonnegative retirement delay seconds', () => {
  for (const delay of [undefined, 0, 60, 3600]) {
    assert.doesNotThrow(() => validateManifest({ ...manifest, retirementDelaySeconds: delay }))
  }
  for (const delay of [-1, 0.5, '60', null, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => validateManifest({ ...manifest, retirementDelaySeconds: delay }), /Invalid preview retirement delay/)
  }
})

test('isolates identical branch names and commits and preserves the original Status namespace', () => {
  const ref = 'refs/heads/feat/login', sha = 'a'.repeat(40)
  const a = defineInstallation('1468279539', {}), b = defineInstallation('1474000552', {})
  const key = createHash('sha256').update(ref).digest('hex').slice(0, 24)
  assert.equal(a.branchKey(ref), key)
  assert.notEqual(a.branchKey(ref), b.branchKey(ref))
  assert.notEqual(a.workerStem('branch-' + key, sha), b.workerStem('branch-' + key, sha))
  assert.notEqual(a.schemaStem(ref, sha), b.schemaStem(ref, sha))
  assert.notEqual(a.flagPrefix, b.flagPrefix)
  assert.throws(() => defineInstallation('status', {}))
  for (const file of ['../entry.js', '/dev/null', './test.js', 'lib//main.js']) assert.throws(() => relativePath(file))
})
