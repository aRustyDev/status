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
  writeFileSync(path.join(directory, 'fetch.mjs'), `import { appendFileSync } from 'node:fs'; globalThis.fetch = async (_url, opts) => { const q = JSON.parse(opts.body); if (q.sql !== 'SELECT name FROM d1_migrations') { appendFileSync(process.env.TEST_FENCE, JSON.stringify(q) + '\\n'); if (process.env.TEST_FENCE_FAIL) return {ok:false,json:async()=>({success:false})}; } return {ok:true,json:async()=>({success:true,result:[{success:true,results:JSON.parse(process.env.TEST_MIGRATIONS || '["0001.sql"]').map(name=>({name}))}]})} }`)
  writeFileSync(path.join(directory, 'node_modules/.bin/wrangler'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.TEST_STATE));
if (args[0] === 'flagship' && args[2] === 'get') console.log(JSON.stringify(state));
else if (args[0] === 'flagship' && args[2] === 'update') {
  if (process.env.TEST_FLAG_FAIL) process.exit(1);
  const arg = args[args.indexOf('--set-variation') + 1];
  state.variations.current = JSON.parse(arg.slice('current='.length));
  fs.writeFileSync(process.env.TEST_STATE, JSON.stringify(state));
  if (process.env.TEST_FLAG_AMBIGUOUS) process.exit(1);
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
    return spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: `--import=${path.join(directory, 'fetch.mjs')}`, PREVIEW_ACTION: action, PREVIEW_SLOT: '1', PREVIEW_BRANCH: 'feature-one', FLAGSHIP_APP_ID: 'app', CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token', PREVIEW_STAGING_CONFIG: JSON.stringify(settings), TEST_STATE: path.join(directory, 'state.json'), TEST_CONFIGS: path.join(directory, 'configs'), TEST_FENCE: path.join(directory, 'fence.jsonl'), ...options } })
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
  assert.equal(api.vars.SUBSCRIBERS_READY, 'false')
  assert.equal(api.vars.PREVIEW_SUBSCRIBER_REQUIRED, 'true')
  assert.match(api.vars.PREVIEW_SUBSCRIBER_SCOPE, /^[a-f0-9]{64}$/)
  assert.equal(h.config('status-preview-1-b-gateway').vars.PREVIEW_RELEASE, sha)
  assert.equal(h.run('release', { PREVIEW_BRANCH: 'other-feature' }).status, 1)
  assert.equal(h.run('rollback').status, 0)
  assert.equal(h.state().release, oldSha)
  assert.equal(h.run('release').status, 0)
  assert.deepEqual(h.state(), {})
})

test('changed scheduler module disables scheduling until newly reviewed', t => {
  const h = harness(t)
  const dir = path.join(h.directory, 'feature/apps/worker/src')
  mkdirSync(dir, { recursive: true })
  h.settings.subscriberSchedulingEnabled = true
  h.settings.approvedSubscriberSchedulers = { [sha]: {}, ['e'.repeat(40)]: { 'index.ts': '0'.repeat(64) } }
  for (const name of ['preview-subscriber-scheduler.ts', 'subscriber-delivery.ts', 'subscribers.ts', 'email-channel.ts', 'idempotency.ts', 'index.ts']) {
    writeFileSync(path.join(dir, name), name)
    h.settings.approvedSubscriberSchedulers[sha][name] = createHash('sha256').update(name).digest('hex')
  }
  writeFileSync(path.join(dir, 'subscriber-delivery.ts'), 'changed since approval')
  h.settings.apiVars = { SUBSCRIBERS_READY: 'true', SUBSCRIBER_EMAIL_READY: 'true' }
  const result = h.run('deploy')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(h.state().subscriberScheduler, false)
  assert.equal(h.config('status-preview-1-a-operations').vars.SUBSCRIBERS_READY, 'false')
  assert.equal(h.config('status-preview-1-a-operations').vars.SUBSCRIBER_EMAIL_READY, 'false')
  assert.equal(requireExists(path.join(h.directory, 'configs/status-preview-1-a-subscriber.json')), false)
})

function requireExists(file) { try { readFileSync(file); return true } catch { return false } }

test('reviewed scheduler uses slot fence and restricted email; release revokes fence', t => {
  const old = { selector: oldSelector, target: 'a', release: oldSha, expiresAt: Date.now() + 100000, branch: 'feature-one' }
  const h = harness(t, old)
  const files = ['preview-subscriber-scheduler.ts', 'subscriber-delivery.ts', 'subscribers.ts', 'email-channel.ts', 'idempotency.ts', 'index.ts']
  const dir = path.join(h.directory, 'feature/apps/worker/src')
  mkdirSync(dir, { recursive: true })
  h.settings.subscriberSchedulingEnabled = true
  h.settings.approvedSubscriberSchedulers = { [sha]: {} }
  for (const name of files) {
    const content = `// reviewed ${name}`
    writeFileSync(path.join(dir, name), content)
    h.settings.approvedSubscriberSchedulers[sha][name] = createHash('sha256').update(content).digest('hex')
  }
  h.settings.resourceBindings.api.send_email = [{ name: 'SUBSCRIBER_EMAIL', allowed_sender_addresses: ['sender@example.com'], allowed_destination_addresses: ['recipient@example.com'] }]
  h.settings.apiVars = { SUBSCRIBERS_READY: 'true', SUBSCRIBER_EMAIL_READY: 'true' }
  const deployed = h.run('deploy')
  assert.equal(deployed.status, 0, deployed.stderr)
  assert.equal(h.state().subscriberScheduler, true)
  const scheduler = h.config('status-preview-1-b-subscriber')
  assert.deepEqual(scheduler.triggers.crons, ['* * * * *'])
  assert.deepEqual(scheduler.flagship, [{ binding: 'FLAGS', app_id: 'app' }])
  assert.equal(scheduler.send_email.length, 1)
  assert.equal(scheduler.vars.PREVIEW_SUBSCRIBER_SCOPE, createHash('sha256').update(oldSelector).digest('hex'))
  assert.equal(h.config('status-preview-1-b-operations').vars.SUBSCRIBERS_READY, 'true')
  let fence = readFileSync(path.join(h.directory, 'fence.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.match(fence[0].sql, /^INSERT INTO preview_subscriber_leases/)
  assert.deepEqual(fence[0].params.slice(0, 4), [scheduler.vars.PREVIEW_SUBSCRIBER_SCOPE, 1, 'b', sha])
  assert.equal(h.run('release').status, 0)
  fence = readFileSync(path.join(h.directory, 'fence.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.match(fence.at(-1).sql, /^DELETE FROM preview_subscriber_leases/)
})

test('unreviewed scheduler cannot run and fence failure prevents route publication', t => {
  const old = { selector: oldSelector, target: 'a', release: oldSha, expiresAt: Date.now() + 100000, branch: 'feature-one', subscriberScheduler: true }
  const h = harness(t, old)
  h.settings.subscriberSchedulingEnabled = true
  const failed = h.run('deploy', { TEST_FENCE_FAIL: '1' })
  assert.equal(failed.status, 1)
  assert.match(failed.stderr, /Unable to update subscriber scheduler fence/)
  assert.equal(h.state().release, oldSha)
  const api = h.config('status-preview-1-b-operations')
  assert.equal(api.vars.SUBSCRIBERS_READY, 'false')
  assert.equal(h.run('release', { TEST_FENCE_FAIL: '1' }).status, 1)
  assert.equal(h.state().release, oldSha)
})

for (const action of ['deploy', 'rollback', 'release']) {
  for (const ambiguous of [false, true]) {
    test(`${action} reconciles its fence after ${ambiguous ? 'ambiguous' : 'failed'} Flagship update`, t => {
      const previous = { selector: oldSelector, target: 'b', release: 'd'.repeat(40), expiresAt: Date.now() + 100000, branch: 'feature-one', subscriberScheduler: true }
      const old = { selector: oldSelector, target: 'a', release: oldSha, expiresAt: Date.now() + 100000, branch: 'feature-one', subscriberScheduler: true, ...(action === 'rollback' ? { previous } : {}) }
      const h = harness(t, old)
      h.settings.subscriberSchedulingEnabled = true
      const result = h.run(action, { [ambiguous ? 'TEST_FLAG_AMBIGUOUS' : 'TEST_FLAG_FAIL']: '1' })
      assert.equal(result.status, 1)
      assert.match(result.stderr, /fence reconciled to the observed Flagship route/)
      const fence = readFileSync(path.join(h.directory, 'fence.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).at(-1)
      const observed = h.state()
      if (observed.subscriberScheduler === true) {
        assert.match(fence.sql, /^INSERT INTO preview_subscriber_leases/)
        assert.deepEqual(fence.params.slice(0, 4), [createHash('sha256').update(observed.selector).digest('hex'), 1, observed.target, observed.release])
      } else {
        assert.match(fence.sql, /^DELETE FROM preview_subscriber_leases/)
      }
      assert.equal(observed.release, ambiguous && action === 'rollback' ? previous.release : ambiguous && action === 'deploy' ? sha : action === 'release' && ambiguous ? undefined : old.release)
    })
  }
}

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
