import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { cloudflareDatabaseAdapter } from './database-cloudflare.mjs'

test('Cloudflare adapter uses the selected database and Wrangler migration directory', async () => {
  const requests = []
  let wranglerConfig
  const adapter = cloudflareDatabaseAdapter({
    accountId: 'account', token: 'secret', wrangler: '/test/wrangler', recordDatabase: async () => {},
    fetcher: async (url, init) => {
      requests.push({ url, init })
      const result = init.method === 'POST' && url.endsWith('/database') ? { uuid: 'schema-id', name: 'schema-name' } : [{ success: true, results: [{ name: '0001.sql' }] }]
      return { ok: true, status: 200, json: async () => ({ success: true, result }) }
    },
    run: (_command, args) => { wranglerConfig = JSON.parse(readFileSync(args[args.indexOf('--config') + 1], 'utf8')) },
  })
  const db = await adapter.createDatabase('schema-name')
  assert.deepEqual(db, { id: 'schema-id', name: 'schema-name' })
  assert.deepEqual(await adapter.migrationLedger(db), ['0001.sql'])
  await adapter.applyMigrations(db, '/migrations')
  assert.equal(wranglerConfig.d1_databases[0].database_id, 'schema-id')
  assert.equal(wranglerConfig.d1_databases[0].migrations_dir, '/migrations')
  await adapter.seed(db)
  await adapter.deleteDatabase(db)
  assert.ok(requests[1].url.endsWith('/database/schema-id/query'))
  assert.equal(requests[3].init.method, 'DELETE')
})

test('deleting a previously removed schema validation database is idempotent', async () => {
  const adapter = cloudflareDatabaseAdapter({ accountId: 'account', token: 'secret', wrangler: '/test/wrangler', recordDatabase: async () => {}, fetcher: async () => ({ ok: false, status: 404 }) })
  await adapter.deleteDatabase({ id: 'already-deleted' })
})
