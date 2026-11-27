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

test('authentication migration accepts metadata and rejects embedded credentials on insert and update', () => {
  const db = new DatabaseSync(':memory:')
  const migrations = new URL('../../worker/migrations/', import.meta.url)
  for (const filename of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(filename, migrations), 'utf8'))
  db.exec('PRAGMA foreign_keys=OFF')
  const insert = db.prepare('INSERT INTO http_checks(id,component_id,endpoint_id,interval_minutes,expected_status,advanced_config) VALUES (?, ?, ?, 1, 200, ?)')
  const update = db.prepare('UPDATE http_checks SET advanced_config=? WHERE id=?')
  for (const mode of ['oauth2', 'cas'] as const) {
    const config = { auth: { type: mode, [mode]: { providerId: 'provider', vault: { vaultId: 1, secretId: 2 } } } }
    assert.doesNotThrow(() => insert.run(mode, mode, 'target', JSON.stringify(config)))
    assert.throws(() => update.run(JSON.stringify({ auth: { type: mode, [mode]: { providerId: 'provider', vault: { vaultId: 1, secretId: 2 }, password: 'secret' } } }), mode))
    assert.throws(() => update.run(JSON.stringify({ auth: { type: mode, [mode]: { providerId: 'provider', vault: { vaultId: 1, secretId: 2, password: 'secret' } } } }), mode))
  }
  db.close()
})

test('provider configuration is part of the approved destination identity', async () => {
  const { parseEndpoints, endpointFingerprint } = await import('../../worker/src/endpoint-config.ts')
  const provider = { id: 'oauth', name: 'OAuth', url: 'https://auth.test/token' }
  const endpoint = (authProviders: unknown) => parseEndpoints(JSON.stringify([{ id: 'a', name: 'A', url: 'https://example.test/', authProviders }])).get('a')!
  const original = endpoint({ oauth2: provider })
  assert.notEqual(await endpointFingerprint(original), await endpointFingerprint(endpoint({ oauth2: { ...provider, url: 'https://other.test/token' } })))
  assert.equal(await endpointFingerprint(original), await endpointFingerprint(endpoint({ oauth2: { ...provider, name: 'Renamed' } })))
  assert.throws(() => endpoint({ oauth2: { ...provider, url: 'https://auth.test/token?secret=x' } }))
  assert.throws(() => endpoint({ cas: { ...provider, url: 'http://auth.test/' } }))
})

test('authentication parser and request policy enforce provider scope and CAS restrictions', async () => {
  const { parsePersistedHttpConfig, requestAllowedForEndpoint } = await import('../src/http-monitor.ts')
  const { parseEndpoints } = await import('../../worker/src/endpoint-config.ts')
  const endpoint = parseEndpoints(JSON.stringify([{ id: 'a', name: 'A', url: 'https://example.test/', authProviders: {
    oauth2: { id: 'oauth', name: 'OAuth', url: 'https://auth.test/token' },
    cas: { id: 'cas', name: 'CAS', url: 'https://cas.test/v1/tickets' },
  } }])).get('a')!
  const vault = { vaultId: 1, secretId: 2 }
  const parse = (auth: unknown) => parsePersistedHttpConfig({ auth }, 'a', 'fingerprint', 200)
  const oauth = parse({ type: 'oauth2', oauth2: { providerId: 'oauth', vault, scope: 'read' } })
  assert.ok(oauth)
  assert.equal(requestAllowedForEndpoint(oauth, endpoint), true)
  assert.equal(parse({ type: 'oauth2', oauth2: { providerId: 'oauth', vault, clientSecret: 'secret' } }), null)
  const wrong = parse({ type: 'oauth2', oauth2: { providerId: 'other', vault } })!
  assert.equal(requestAllowedForEndpoint(wrong, endpoint), false)
  const cas = parse({ type: 'cas', cas: { providerId: 'cas', vault } })!
  assert.equal(requestAllowedForEndpoint(cas, endpoint), true)
  assert.equal(requestAllowedForEndpoint({ ...cas, method: 'HEAD' }, endpoint), false)
  assert.equal(requestAllowedForEndpoint({ ...cas, headers: { 'x-test': 'value' } }, endpoint), false)
})

test('endpoint sync checks CAS Worker database, providers, and private bindings', async () => {
  const endpoint = { id: 'a', name: 'A', url: 'https://service.test/', binding: 'TARGET', serviceId: 'service', authProviders: { cas: { id: 'cas', name: 'CAS', url: 'https://cas.test/v1/tickets', binding: 'CAS_TARGET', serviceId: 'cas-service' } } }
  const config = (db: string, endpoints: unknown[], bindings: { binding: string; service_id: string }[]) => ({ env: { staging: { vars: { ENDPOINTS: JSON.stringify(endpoints) }, d1_databases: [{ binding: 'DB', database_id: db }], vpc_services: bindings } } })
  const bindings = [{ binding: 'TARGET', service_id: 'service' }, { binding: 'CAS_TARGET', service_id: 'cas-service' }]
  const good = config('staging-db', [endpoint], bindings)
  await assert.rejects(buildSyncSql(good, good, 'staging'), /CAS Worker database/)
  await assert.rejects(buildSyncSql(good, good, 'staging', config('wrong-db', [endpoint], bindings)), /CAS Worker database/)
  await assert.rejects(buildSyncSql(good, good, 'staging', config('staging-db', [endpoint], [])), /CAS target service/)
  await assert.rejects(buildSyncSql(good, good, 'staging', config('staging-db', [{ ...endpoint, url: 'https://other.test/' }], bindings)), /CAS Worker endpoint list differs/)
  assert.match(await buildSyncSql(good, good, 'staging', good), /INSERT INTO endpoint_registry/)
})
