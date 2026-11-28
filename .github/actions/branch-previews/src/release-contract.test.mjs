import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { branchKey, branchPolicy, newRelease, nextGeneration, selectorForBranch, validateInventory } from './release-contract.mjs'
import { createInventoryStore } from './release-inventory.mjs'

const ref = 'refs/heads/feat/monitor'
const sha = 'a'.repeat(40)

test('branch policy and selectors are stable and distinct across complete refs', () => {
  assert.equal(branchPolicy(ref).environment, 'dev')
  assert.equal(branchPolicy('refs/heads/fix/monitor').environment, 'dev')
  assert.equal(branchPolicy('refs/heads/stage/monitor').environment, 'stage')
  assert.equal(branchPolicy('refs/heads/schema/monitor').environment, 'schema')
  for (const bad of ['feat/monitor', 'refs/heads/codex/monitor', 'refs/heads/feat/', 'refs/heads/feat/a..b', 'refs/heads/feat/x.lock']) assert.equal(branchPolicy(bad), null)
  assert.match(selectorForBranch(ref), /^branch-[a-f0-9]{24}$/)
  assert.notEqual(branchKey(ref), branchKey('refs/heads/fix/monitor'))
})

test('new pushes advance the generation and reject malformed records', () => {
  const first = newRelease({ ref, sha })
  assert.equal(nextGeneration(first, sha), first)
  const next = nextGeneration({ ...first, candidate: { sha, generation: 1, resources: {} } }, 'b'.repeat(40))
  assert.equal(next.generation, 2)
  assert.equal(next.candidate, null)
  assert.throws(() => validateInventory({ ...first, selector: 'bad' }))
  assert.throws(() => newRelease({ ref, sha: 'bad' }))
})

test('D1 inventory compare-and-swap rejects a stale writer', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync(new URL('./release-inventory.sql', import.meta.url), 'utf8'))
  const fetchImpl = async (_url, request) => {
    const { sql, params } = JSON.parse(request.body)
    const results = db.prepare(sql).all(...params)
    return { ok: true, json: async () => ({ success: true, result: [{ success: true, results }] }) }
  }
  const store = createInventoryStore({ accountId: 'account', databaseId: 'control', token: 'test', fetchImpl })
  const first = newRelease({ ref, sha })
  assert.equal(await store.create(first), true)
  assert.equal(await store.create(first), false)
  const snapshot = await store.read(ref)
  assert.equal((await store.list()).length, 1)
  assert.equal(snapshot.revision, 1)
  const newer = nextGeneration(snapshot.record, 'b'.repeat(40))
  assert.equal(await store.compareAndSwap(ref, snapshot.revision, newer), true)
  assert.equal(await store.compareAndSwap(ref, snapshot.revision, first), false)
  assert.equal((await store.read(ref)).record.desiredSha, 'b'.repeat(40))
  db.close()
})
