import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { parseArgs, validateTarget, type Options } from './provision.mts'

const account = '0123456789abcdef0123456789abcdef'
const database = '11111111-1111-4111-8111-111111111111'
const protectedIds = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']
const options: Options = { target: 'staging', mode: 'local', targetConfig: '/tmp/unused', catalog: '/tmp/unused', expectedAccount: account, expectedDatabase: database, allowProduction: false }
const target = { environment: 'staging', accountId: account, databaseId: database, databaseName: 'status-gatus-validation-test', protectedDatabaseIds: protectedIds }
const catalog = [{ kind: 'endpoint', key: 'fixture_key', name: 'Private fixture label', group: 'Test', staleAfterSeconds: 180, advisory: false }]

test('target checks require an isolated, explicit and independently matching account/database', () => {
  assert.equal(validateTarget(target, options).databaseId, database)
  assert.throws(() => validateTarget({ ...target, environment: 'production' }, options), /Invalid/)
  assert.throws(() => validateTarget({ ...target, databaseName: 'status-board-staging' }, options), /isolated/)
  assert.throws(() => validateTarget({ ...target, databaseId: protectedIds[0] }, { ...options, expectedDatabase: protectedIds[0]! }), /Protected/)
  assert.throws(() => validateTarget(target, { ...options, expectedAccount: '0'.repeat(32) }), /mismatch/)
  assert.throws(() => validateTarget({ ...target, protectedDatabaseIds: [protectedIds[0], protectedIds[0]] }, options), /protected/)
  const args = ['--target', 'production', '--mode', 'remote', '--target-config', '/tmp/a', '--catalog', '/tmp/b', '--expected-account', account, '--expected-database', database]
  assert.throws(() => parseArgs(args), /explicit/)
  assert.equal(parseArgs([...args, '--allow-production']).target, 'production')
  assert.throws(() => parseArgs([...args, '--unknown', 'secret']), /Invalid/)
  const productionOptions: Options = { ...options, target: 'production', mode: 'remote', allowProduction: true }
  const productionTarget = { ...target, environment: 'production', databaseName: 'status-board-production' }
  assert.equal(validateTarget(productionTarget, productionOptions).databaseName, 'status-board-production')
  assert.throws(() => validateTarget(productionTarget, { ...productionOptions, allowProduction: false }), /Invalid target options/)
  assert.throws(() => validateTarget(productionTarget, { ...productionOptions, mode: 'local' }), /Invalid target options/)
  assert.throws(() => validateTarget({ ...productionTarget, databaseName: 'other-production' }, productionOptions), /Unexpected production/)
})

test('local worker applies only an authenticated, bounded, sanitized, one-shot catalog', async () => {
  const token = 'a'.repeat(64)
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./local-worker.ts', import.meta.url))], bundle: true,
    format: 'esm', platform: 'browser', conditions: ['workerd', 'worker', 'browser'], write: false })
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, d1Databases: ['DB'], bindings: { PROVISION_TOKEN: token } }))
  try {
    const db = await mf.getD1Database('DB')
    for (const file of ['0001_board.sql', '0002_checks.sql', '0003_endpoint_registry.sql', '0004_aliases.sql', '0005_gatus_sources.sql', '0006_advanced_http.sql']) {
      const sql = readFileSync(new URL(`../../apps/worker/migrations/${file}`, import.meta.url), 'utf8').replace(/^\s*--[^\n]*$/gm, '')
      const parts = sql.split(/(?=CREATE TRIGGER |DROP TRIGGER )/)
      const statements = parts.shift()!.split(';').map(value => value.trim()).filter(Boolean)
      statements.push(...parts.map(value => value.trim()).filter(Boolean))
      await db.batch(statements.map(statement => db.prepare(statement)))
    }
    const call = (body: string, auth = token, url = 'http://127.0.0.1/apply') => mf.dispatchFetch(url, {
      method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body,
    })
    assert.equal((await call(JSON.stringify(catalog), 'b'.repeat(64))).status, 401)
    assert.equal((await call(JSON.stringify(catalog), token, 'http://example.com/apply')).status, 404)
    assert.equal((await call(JSON.stringify([{ ...catalog[0], url: 'https://secret.example' }]))).status, 400)
    assert.equal((await call('x'.repeat(262_145))).status, 400)
    const before = await db.prepare('SELECT COUNT(*) AS n FROM gatus_sources').first<{n:number}>()
    assert.equal(before?.n, 0)
    const applied = await call(JSON.stringify(catalog))
    assert.equal(applied.status, 200)
    assert.deepEqual(await applied.json(), { applied: 1 })
    assert.equal((await call(JSON.stringify(catalog))).status, 409)
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM gatus_sources').first<{n:number}>())?.n, 1)
  } finally { await mf.dispose() }
})

test('CLI locally applies a catalog without printing private data and cleans temporary files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gatus-cli-test-'))
  const targetPath = join(dir, 'target.json'), catalogPath = join(dir, 'catalog.json')
  try {
    writeFileSync(targetPath, JSON.stringify(target), { mode: 0o600 })
    writeFileSync(catalogPath, JSON.stringify(catalog), { mode: 0o600 })
    chmodSync(targetPath, 0o600); chmodSync(catalogPath, 0o600)
    const script = fileURLToPath(new URL('./provision.mts', import.meta.url))
    const result = spawnSync(process.execPath, ['--import', 'tsx', script, '--target', 'staging', '--mode', 'local', '--target-config', targetPath, '--catalog', catalogPath, '--expected-account', account, '--expected-database', database], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)), env: { ...process.env, TMPDIR: dir, TSX_DISABLE_CACHE: '1' }, encoding: 'utf8', timeout: 60_000,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), { result: 'applied', count: 1, target: 'staging', mode: 'local' })
    assert.doesNotMatch(result.stdout + result.stderr, /Private fixture label|fixture_key|secret/i)
    assert.deepEqual(readdirSync(dir).sort(), ['catalog.json', 'target.json'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


test('interruption stops the local worker and removes its temporary token and state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gatus-cli-interrupt-'))
  const targetPath = join(dir, 'target.json'), catalogPath = join(dir, 'catalog.json')
  let child: ReturnType<typeof spawn> | undefined
  try {
    writeFileSync(targetPath, JSON.stringify(target), { mode: 0o600 })
    writeFileSync(catalogPath, JSON.stringify(catalog), { mode: 0o600 })
    const script = fileURLToPath(new URL('./provision.mts', import.meta.url))
    child = spawn(process.execPath, ['--import', 'tsx', script, '--target', 'staging', '--mode', 'local', '--target-config', targetPath, '--catalog', catalogPath, '--expected-account', account, '--expected-database', database], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)), env: { ...process.env, TMPDIR: dir, TSX_DISABLE_CACHE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout!.resume(); child.stderr!.resume()
    const exit = new Promise<number | null>(resolveExit => child!.once('exit', resolveExit))
    let tokenWritten = false
    for (let attempt = 0; attempt < 200; attempt++) {
      const temp = readdirSync(dir).find(name => name.startsWith('gatus-catalog-'))
      if (temp && existsSync(join(dir, temp, '.dev.vars'))) { tokenWritten = true; break }
      await delay(20)
    }
    assert.equal(tokenWritten, true)
    child.kill('SIGTERM')
    assert.notEqual(await exit, 0)
    assert.deepEqual(readdirSync(dir).sort(), ['catalog.json', 'target.json'])
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})
