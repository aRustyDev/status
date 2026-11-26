import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { prepareDatabase, deleteOwnedDatabase } from './database.mjs'

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'preview-db-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const main = path.join(root, 'main')
  const candidate = path.join(root, 'candidate')
  await mkdir(main); await mkdir(candidate)
  await writeFile(path.join(main, '0001.sql'), 'CREATE TABLE x(id TEXT);')
  await writeFile(path.join(candidate, '0001.sql'), 'CREATE TABLE x(id TEXT);')
  const calls = []
  const adapter = {
    migrationLedger: async () => ['0001.sql'],
    createDatabase: async name => { calls.push(['create', name]); return { id: name, name } },
    recordDatabase: async (db, purpose) => calls.push(['record', db.id, purpose]),
    applyMigrations: async (db, dir) => calls.push(['apply', db.id, dir]),
    seed: async db => calls.push(['seed', db.id]),
    deleteDatabase: async db => calls.push(['delete', db.id]),
  }
  return { main, candidate, adapter, calls, config: { dev: { id: 'dev', name: 'dev' }, stage: { id: 'stage', name: 'stage' }, prod: { id: 'prod' } } }
}

const args = h => ({ ref: 'schema/example', sha: 'a'.repeat(40), config: h.config, mainMigrations: h.main, candidateMigrations: h.candidate, adapter: h.adapter })

test('shared environments require approved bytes and a matching ledger', async t => {
  const h = await setup(t)
  assert.deepEqual(await prepareDatabase({ ...args(h), kind: 'dev' }), { id: 'dev', name: 'dev', owned: false })
  await writeFile(path.join(h.candidate, '0001.sql'), 'SELECT 2;')
  await assert.rejects(prepareDatabase({ ...args(h), kind: 'stage' }), /Unapproved/)
  await writeFile(path.join(h.candidate, '0001.sql'), 'CREATE TABLE x(id TEXT);')
  h.adapter.migrationLedger = async () => []
  await assert.rejects(prepareDatabase({ ...args(h), kind: 'stage' }), /missing migrations/)
})

test('schema upgrade and clean tests use separate recorded databases', async t => {
  const h = await setup(t)
  await writeFile(path.join(h.candidate, '0002.sql'), 'ALTER TABLE x ADD COLUMN v TEXT;')
  const database = await prepareDatabase({ ...args(h), kind: 'schema' })
  assert.equal(database.owned, true)
  assert.deepEqual(h.calls.map(call => call[0]), ['create', 'record', 'apply', 'seed', 'apply', 'create', 'record', 'apply', 'delete'])
  assert.equal(h.calls[0][1], database.name)
  assert.notEqual(h.calls[5][1], database.name)
})

test('schema rejects historical changes and cleanup protects shared resources', async t => {
  const h = await setup(t)
  await writeFile(path.join(h.candidate, '0001.sql'), 'SELECT 2;')
  await assert.rejects(prepareDatabase({ ...args(h), kind: 'schema' }), /changes or reorders/)
  assert.equal(h.calls.length, 0)
  await assert.rejects(deleteOwnedDatabase({ database: { id: 'prod', name: `status-schema-${'a'.repeat(12)}-${'b'.repeat(12)}-upgrade`, owned: true }, config: h.config, adapter: h.adapter }), /shared/)
})
