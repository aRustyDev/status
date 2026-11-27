import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deployRelease } from './release-coordinator.mjs'

const ref = 'refs/heads/feat/check'
const sha = 'a'.repeat(40)
function store() {
  let snapshot = null
  return {
    async read() { return structuredClone(snapshot) },
    async create(record) { if (snapshot) return false; snapshot = { revision: 1, record: structuredClone(record) }; return true },
    async compareAndSwap(_ref, revision, record) { if (snapshot.revision !== revision) return false; snapshot = { revision: revision + 1, record: structuredClone(record) }; return true },
  }
}

test('persists owned resources before activation and promotes the candidate', async () => {
  const inventory = store()
  const result = await deployRelease({ ref, sha, store: inventory, readRemoteHead: async () => sha,
    prepare: async ({ recordResources }) => { await recordResources({ database: { id: 'db', owned: true } }); return { gateway: 'worker' } },
    activate: async ({ resources }) => { assert.equal((await inventory.read()).record.candidate.phase, 'activating'); assert.equal(resources.database.id, 'db') },
  })
  assert.equal(result.active.sha, sha)
  assert.equal(result.active.resources.gateway, 'worker')
  assert.equal(result.candidate, null)
})

test('ambiguous activation remains visible and blocks a retry', async () => {
  const inventory = store()
  const args = { ref, sha, store: inventory, readRemoteHead: async () => sha, prepare: async () => ({ gateway: 'worker' }), activate: async () => { throw new Error('timeout') } }
  await assert.rejects(deployRelease(args), /timeout/)
  assert.equal((await inventory.read()).record.candidate.phase, 'activating')
  await assert.rejects(deployRelease(args), /requires reconciliation/)
})

test('an updated branch head prevents activation and preserves the candidate', async () => {
  const inventory = store()
  let calls = 0
  await assert.rejects(deployRelease({ ref, sha, store: inventory, readRemoteHead: async () => ++calls === 1 ? sha : 'b'.repeat(40), prepare: async () => ({}), activate: async () => assert.fail('must not activate') }), /changed before activation/)
  assert.equal((await inventory.read()).record.candidate.phase, 'ready')
})

test('retirement blocks deployment even when the remote branch is recreated', async () => {
  const inventory = store()
  await deployRelease({ ref, sha, store: inventory, readRemoteHead: async () => sha, prepare: async () => ({}), activate: async () => {} })
  const snapshot = await inventory.read()
  await inventory.compareAndSwap(ref, snapshot.revision, { ...snapshot.record, retirement: { phase: 'draining', disabledAt: 100 } })
  await assert.rejects(deployRelease({ ref, sha, store: inventory, readRemoteHead: async () => sha, prepare: async () => assert.fail('must not prepare'), activate: async () => assert.fail('must not activate') }), /Retirement requires reconciliation/)
})

test('a retry resumes a partially prepared candidate with its recorded resources', async () => {
  const inventory = store()
  await assert.rejects(deployRelease({ ref, sha, store: inventory, readRemoteHead: async () => sha,
    prepare: async ({ recordResources }) => { await recordResources({ databaseIntent: { name: 'db' } }); throw new Error('interrupted') },
    activate: async () => assert.fail(),
  }), /interrupted/)
  const result = await deployRelease({ ref, sha, store: inventory, readRemoteHead: async () => sha,
    prepare: async ({ recordedResources }) => { assert.equal(recordedResources.databaseIntent.name, 'db'); return { gateway: 'worker' } },
    activate: async () => {},
  })
  assert.equal(result.active.resources.databaseIntent.name, 'db')
})

test('duplicate deploy of an active commit leaves its schema resources and inventory untouched', async () => {
  const inventory = store()
  await deployRelease({ ref, sha, store: inventory, readRemoteHead: async () => sha,
    prepare: async () => ({ database: { id: 'schema-id', owned: true }, gateway: 'worker' }), activate: async () => {},
  })
  const before = await inventory.read()
  const result = await deployRelease({ ref, sha, store: inventory, readRemoteHead: async () => sha,
    prepare: async () => assert.fail('must not create the schema database again'), activate: async () => assert.fail('must not reactivate'),
  })
  assert.deepEqual(await inventory.read(), before)
  assert.equal(result.active.resources.database.id, 'schema-id')
})
