import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./manage.mjs', import.meta.url))
const sha = 'a'.repeat(40)
const oldSha = 'b'.repeat(40)
const oldSelector = `1.${'c'.repeat(32)}`

function harness(t, current = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'preview-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  for (const name of ['node_modules/.bin', 'apps/worker/migrations', 'feature/apps/worker/migrations', 'configs']) mkdirSync(path.join(directory, name), { recursive: true })
  for (const name of ['apps/worker/migrations/0001.sql', 'feature/apps/worker/migrations/0001.sql']) writeFileSync(path.join(directory, name), 'SELECT 1;')
  writeFileSync(path.join(directory, 'feature/.preview-commit'), sha)
  writeFileSync(path.join(directory, 'state.json'), JSON.stringify({ enabled: true, default_variation: 'current', rules: [], variations: { current } }))
  writeFileSync(path.join(directory, 'fetch.mjs'), `globalThis.fetch = async () => ({ ok: true, json: async () => ({ success: true, result: [{ results: JSON.parse(process.env.TEST_MIGRATIONS || '["0001.sql"]').map(name => ({ name })) }] }) })`)
  writeFileSync(path.join(directory, 'node_modules/.bin/wrangler'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.TEST_STATE));
if (args[0] === 'flagship' && args[2] === 'get') console.log(JSON.stringify(state));
else if (args[0] === 'flagship' && args[2] === 'update') {
  const arg = args[args.indexOf('--set-variation') + 1];
  state.variations.current = JSON.parse(arg.slice('current='.length));
  fs.writeFileSync(process.env.TEST_STATE, JSON.stringify(state));
} else if (args[0] === 'deploy') {
  const config = JSON.parse(fs.readFileSync(args[args.indexOf('--config') + 1]));
  if (!args.includes('--dry-run') && process.env.TEST_FAIL_WORKER === config.name) process.exit(1);
  fs.writeFileSync(process.env.TEST_CONFIGS + '/' + config.name + '.json', JSON.stringify(config));
} else process.exit(1);
`, { mode: 0o755 })
  const settings = {
    d1DatabaseId: 'staging-db-id', d1DatabaseName: 'staging-db', accessTeamDomain: 'example.cloudflareaccess.com', accessAud: 'aud', endpoints: '[]',
    resourceBindings: { api: { r2_buckets: [{ binding: 'BACKUPS', bucket_name: 'staging-backups' }], kv_namespaces: [{ binding: 'CACHE', id: 'staging-kv' }] } },
  }
  function run(action, options = {}) {
    return spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: `--import=${path.join(directory, 'fetch.mjs')}`, PREVIEW_ACTION: action, PREVIEW_SLOT: '1', PREVIEW_BRANCH: 'feature-one', FLAGSHIP_APP_ID: 'app', CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token', PREVIEW_STAGING_CONFIG: JSON.stringify(settings), TEST_STATE: path.join(directory, 'state.json'), TEST_CONFIGS: path.join(directory, 'configs'), ...options } })
  }
  function state() { return JSON.parse(readFileSync(path.join(directory, 'state.json'), 'utf8')).variations.current }
  function config(name) { return JSON.parse(readFileSync(path.join(directory, 'configs', `${name}.json`), 'utf8')) }
  return { directory, run, state, config, settings }
}

test('deploy, rollback and release preserve slot ownership and resource configuration', t => {
  const old = { selector: oldSelector, target: 'a', release: oldSha, expiresAt: Date.now() + 100000, branch: 'feature-one' }
  const h = harness(t, old)
  const result = h.run('deploy')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(h.state().target, 'b')
  assert.equal(h.state().release, sha)
  assert.equal(h.state().previous.release, oldSha)
  const api = h.config('status-preview-1-b-operations')
  assert.equal(api.d1_databases[0].database_id, 'staging-db-id')
  assert.equal(api.r2_buckets[0].bucket_name, 'staging-backups')
  assert.equal(api.kv_namespaces[0].id, 'staging-kv')
  assert.deepEqual(h.config('status-preview-1-b-probe').triggers.crons, [])
  assert.equal(h.config('status-preview-1-b-gateway').vars.PREVIEW_RELEASE, sha)
  assert.equal(h.run('release', { PREVIEW_BRANCH: 'other-feature' }).status, 1)
  assert.equal(h.run('rollback').status, 0)
  assert.equal(h.state().release, oldSha)
  assert.equal(h.run('release').status, 0)
  assert.deepEqual(h.state(), {})
})

test('failed upload invalidates overwritten rollback target and keeps active build', t => {
  const previous = { selector: oldSelector, target: 'b', release: 'd'.repeat(40), expiresAt: Date.now() + 100000, branch: 'feature-one' }
  const active = { selector: oldSelector, target: 'a', release: oldSha, expiresAt: Date.now() + 100000, branch: 'feature-one', previous }
  const h = harness(t, active)
  const result = h.run('deploy', { TEST_FAIL_WORKER: 'status-preview-1-b-operations' })
  assert.equal(result.status, 1)
  assert.equal(h.state().release, oldSha)
  assert.equal(h.state().previous, undefined)
  assert.equal(h.run('rollback').status, 1)
})

test('unapproved migrations and unsupported binding types stop before upload', t => {
  const h = harness(t)
  writeFileSync(path.join(h.directory, 'feature/apps/worker/migrations/0001.sql'), 'SELECT 2;')
  const migration = h.run('deploy')
  assert.equal(migration.status, 1)
  assert.match(migration.stderr, /differs from main/)
  writeFileSync(path.join(h.directory, 'feature/apps/worker/migrations/0001.sql'), 'SELECT 1;')
  h.settings.resourceBindings.api.d1_databases = [{ binding: 'DB', database_id: 'other' }]
  const binding = h.run('deploy')
  assert.equal(binding.status, 1)
  assert.match(binding.stderr, /Unsupported resource binding type/)
  delete h.settings.resourceBindings.api.d1_databases
  h.settings.resourceBindings.api.queues = { consumers: [{ queue: 'shared' }] }
  const consumer = h.run('deploy')
  assert.equal(consumer.status, 1)
  assert.match(consumer.stderr, /only configure producers/)
  assert.deepEqual(h.state(), {})
})

test('reviewed feature migrations require matching filename, hash, and staging ledger', t => {
  const h = harness(t)
  const migration = 'CREATE TABLE feature (id INTEGER);'
  const migrationPath = path.join(h.directory, 'feature/apps/worker/migrations/0002_feature.sql')
  writeFileSync(migrationPath, migration)
  const hash = createHash('sha256').update(migration).digest('hex')

  assert.match(h.run('deploy').stderr, /lacks an approved matching hash/)
  h.settings.approvedMigrationHashes = { '0002_other.sql': hash }
  assert.match(h.run('deploy').stderr, /lacks an approved matching hash/)
  h.settings.approvedMigrationHashes = { '0002_feature.sql': '0'.repeat(64) }
  assert.match(h.run('deploy').stderr, /lacks an approved matching hash/)
  h.settings.approvedMigrationHashes = { '0002_feature.sql': hash }
  assert.match(h.run('deploy').stderr, /Staging is missing migrations: 0002_feature.sql/)
  const applied = JSON.stringify(['0001.sql', '0002_feature.sql'])
  assert.equal(h.run('deploy', { TEST_MIGRATIONS: applied }).status, 0)

  writeFileSync(migrationPath, `${migration}\n`)
  assert.match(h.run('deploy', { TEST_MIGRATIONS: applied }).stderr, /lacks an approved matching hash/)
  writeFileSync(path.join(h.directory, 'feature/apps/worker/migrations/0001.sql'), 'SELECT 2;')
  h.settings.approvedMigrationHashes['0001.sql'] = createHash('sha256').update('SELECT 2;').digest('hex')
  assert.match(h.run('deploy', { TEST_MIGRATIONS: applied }).stderr, /differs from main/)
})

test('invalid approved migration mappings stop deployment', t => {
  const h = harness(t)
  h.settings.approvedMigrationHashes = { '../0002.sql': '0'.repeat(64) }
  assert.match(h.run('deploy').stderr, /Invalid approved migration hash/)
  h.settings.approvedMigrationHashes = { '0002.sql': 'bad' }
  assert.match(h.run('deploy').stderr, /Invalid approved migration hash/)
  assert.deepEqual(h.state(), {})
})
