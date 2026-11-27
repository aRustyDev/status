import assert from 'node:assert/strict'
import test from 'node:test'
import { endpointFingerprint } from '../../../../apps/worker/src/endpoint-config.ts'
import { fixtureCatalog, fixtureRegistryStatements } from './fixture-catalog.mjs'

test('trusted registry statements match the application and reviewed CAS fingerprint vectors', async () => {
  const name = 'status-p-' + 'a'.repeat(24) + '-fixture'
  const sha = 'b'.repeat(40)
  const catalog = fixtureCatalog(name, sha, true)
  const statements = fixtureRegistryStatements(name, sha, true)
  assert.equal(statements[0].params[1], await endpointFingerprint(catalog.endpoints[0]))
  assert.equal(statements[0].params[1], 'bdf47d80f40e6c21738d2b3cf1fba72f281442ed86461d5ec999d9c29f3ec9e1')
  // Obtained from PR #90's endpointFingerprint with the same catalog.
  assert.equal(statements[1].params[1], 'd26dc346acd1cd1d2a4f5a6cebfe1c1ea9f4f94001cd00da52350013b12fa89c')
  assert.ok(statements.every(item => item.sql.includes('VALUES (?, ?)') && item.params.length === 2))
  assert.deepEqual(fixtureRegistryStatements(name, sha).map(item => item.params[0]), ['preview-monitor'])
  assert.throws(() => fixtureCatalog('shared/fixture', sha, true), /identity/)
})
