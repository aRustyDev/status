import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { buildSyncSql } from '../scripts/sync-endpoints.ts'

test('request migration permits only structured Vault references', () => {
  const db = new DatabaseSync(':memory:')
  const migrations = new URL('../../worker/migrations/', import.meta.url)
  for (const filename of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(filename, migrations), 'utf8'))
  }
  db.exec('PRAGMA foreign_keys=OFF')
  const insert = db.prepare('INSERT INTO http_checks(id,component_id,endpoint_id,interval_minutes,expected_status,advanced_config) VALUES (?, ?, ?, 1, 200, ?)')
  const save = (config: unknown) => insert.run(crypto.randomUUID(), crypto.randomUUID(), 'target', JSON.stringify(config))
  assert.doesNotThrow(() => save({ method: 'POST', body: '{"ok":true}', headers: { 'x-test': 'ok' }, vaultHeaders: { authorization: { vaultId: 1, secretId: 2 } } }))
  assert.throws(() => save({ headers: { authorization: 'secret' } }))
  assert.throws(() => save({ vaultHeaders: { authorization: { vaultId: 1, secretId: 2, value: 'secret' } } }))
  assert.throws(() => save({ method: 'GET', body: '{}' }))
  db.close()
})

test('endpoint sync rejects policy disagreements', async () => {
  const config = (requestPolicy: unknown) => ({ env: { staging: {
    vars: { ENDPOINTS: JSON.stringify([{ id: 'a', name: 'A', url: 'https://example.test/', requestPolicy }]) },
    d1_databases: [{ binding: 'DB', database_id: 'staging-db' }],
  } } })
  await assert.rejects(buildSyncSql(config({ allowPost: true }), config({ allowPost: false }), 'staging'), /endpoint lists differ/)
  assert.match(await buildSyncSql(config({ allowPost: true }), config({ allowPost: true }), 'staging'), /INSERT INTO endpoint_registry/)
})
