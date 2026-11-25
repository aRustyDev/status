import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { vaultApi } from '../src/vault.ts'
import { resolveActionCredential, resolveChannelCredential, resolveMonitorCredential } from '../src/vault-resolver.ts'

class Statement {
  private values: unknown[] = []
  constructor(private sql: string, private db: DatabaseSync) {}
  bind(...values: unknown[]) { this.values = values; return this }
  async first<T>() { return (this.db.prepare(this.sql).get(...this.values as never[]) ?? null) as T | null }
  runSync() { const result = this.db.prepare(this.sql).run(...this.values as never[]); return { meta: { changes: Number(result.changes) } } }
  async run() { return this.runSync() }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...this.values as never[]) as T[] } }
}
class Database {
  readonly sqlite = new DatabaseSync(':memory:')
  prepare(sql: string) { return new Statement(sql, this.sqlite) }
  async batch(statements: Statement[]) {
    this.sqlite.exec('BEGIN')
    try { const result = statements.map(stmt => stmt.runSync()); this.sqlite.exec('COMMIT'); return result }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error }
  }
}

test('runtime lookup is scoped to persisted integration and version, handles rotation, deletion and failures', async () => {
  const db = new Database(), key = 'a1'.repeat(32), actor = { id: 'admin', email: 'admin@example.test', version: 1 }
  db.sqlite.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, version INTEGER);
    INSERT INTO users VALUES ('admin','admin',1);
    CREATE TABLE audit_events (id TEXT PRIMARY KEY, actor_email TEXT, action TEXT, entity_type TEXT, entity_id TEXT, created_at INTEGER, details TEXT NOT NULL);
    CREATE TABLE http_checks (id TEXT PRIMARY KEY, config_version INTEGER, advanced_config TEXT);
    CREATE TABLE notification_channels (id TEXT PRIMARY KEY, version INTEGER, vault_id INTEGER, secret_id INTEGER);
    CREATE TABLE worker_actions (id TEXT PRIMARY KEY, version INTEGER, vault_id INTEGER, secret_id INTEGER);`)
  db.sqlite.exec(readFileSync(new URL('../migrations/0008_vault.sql', import.meta.url), 'utf8'))
  const call = async (method: string, path: string, body?: object) => vaultApi(new Request(`https://example.test${path}`, {
    method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
  }), db as unknown as D1Database, key, actor, path)
  const vault = await (await call('POST', '/admin/vaults', { name: 'Fixture' })).json() as { id: number }
  const prefix = `/admin/vaults/${vault.id}/secrets`
  const monitor = await (await call('POST', prefix, { name: 'Monitor', type: 'userpass', userpass: { username: 'fixture-user', password: 'fixture-first' } })).json() as { id: number; version: number }
  const channel = await (await call('POST', prefix, { name: 'Channel', type: 'value', value: 'fixture-token' })).json() as { id: number; version: number }
  const ref = { vaultId: vault.id, secretId: monitor.id }
  const auth = JSON.stringify({ auth: { type: 'basic', basic: { vault: ref } } })
  await db.prepare('INSERT INTO http_checks VALUES (?,?,?)').bind('check-a', 4, auth).run()
  await db.prepare('INSERT INTO notification_channels VALUES (?,?,?,?)').bind('channel-a', 2, vault.id, channel.id).run()
  await db.prepare('INSERT INTO worker_actions VALUES (?,?,?,?)').bind('action-a', 5, vault.id, channel.id).run()
  const typedDb = db as unknown as D1Database
  assert.deepEqual(await resolveMonitorCredential(typedDb, key, 'check-a', 4), { username: 'fixture-user', password: 'fixture-first' })
  assert.equal(await resolveChannelCredential(typedDb, key, 'channel-a', 2), 'fixture-token')
  assert.equal(await resolveActionCredential(typedDb, key, 'action-a', 5), 'fixture-token')
  assert.equal(await resolveActionCredential(typedDb, key, 'action-a', 4), null)
  assert.equal(await resolveActionCredential(typedDb, key, 'other', 5), null)
  await db.prepare('UPDATE worker_actions SET secret_id=? WHERE id=?').bind(monitor.id, 'action-a').run()
  assert.equal(await resolveActionCredential(typedDb, key, 'action-a', 5), null)
  assert.equal(await resolveMonitorCredential(typedDb, key, 'check-a', 3), null)
  assert.equal(await resolveMonitorCredential(typedDb, key, 'other', 4), null)
  assert.equal(await resolveChannelCredential(typedDb, key, 'channel-a', 1), null)
  assert.equal(await resolveChannelCredential(typedDb, 'ff'.repeat(32), 'channel-a', 2), null)
  await db.prepare('UPDATE notification_channels SET secret_id=? WHERE id=?').bind(monitor.id, 'channel-a').run()
  assert.equal(await resolveChannelCredential(typedDb, key, 'channel-a', 2), null)
  await db.prepare('UPDATE notification_channels SET secret_id=?, vault_id=? WHERE id=?').bind(channel.id, vault.id + 1, 'channel-a').run()
  assert.equal(await resolveChannelCredential(typedDb, key, 'channel-a', 2), null)
  const rotated = await call('PATCH', `${prefix}/${monitor.id}`, { version: monitor.version, userpass: { username: 'fixture-user', password: 'fixture-next' } })
  assert.equal(rotated.status, 200)
  assert.equal((await resolveMonitorCredential(typedDb, key, 'check-a', 4))?.password, 'fixture-next')
  await db.prepare('UPDATE vault_secrets SET ciphertext=? WHERE id=?').bind('not-authentic-ciphertext', monitor.id).run()
  assert.equal(await resolveMonitorCredential(typedDb, key, 'check-a', 4), null)
  assert.equal((await call('DELETE', `${prefix}/${monitor.id}`, { version: 2 })).status, 200)
  assert.equal(await resolveMonitorCredential(typedDb, key, 'check-a', 4), null)
  db.sqlite.close()
})

test('monitor header resolution uses only the saved version and fails closed for missing or wrongly typed secrets', async () => {
  const { resolveMonitorHeaderSnapshots } = await import('../src/vault-resolver.ts')
  const db = new Database(), key = 'b2'.repeat(32), actor = { id: 'admin', email: 'admin@example.test', version: 1 }
  db.sqlite.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, version INTEGER);
    INSERT INTO users VALUES ('admin','admin',1);
    CREATE TABLE audit_events (id TEXT PRIMARY KEY, actor_email TEXT, action TEXT, entity_type TEXT, entity_id TEXT, created_at INTEGER, details TEXT NOT NULL);
    CREATE TABLE http_checks (id TEXT PRIMARY KEY, config_version INTEGER, advanced_config TEXT);`)
  db.sqlite.exec(readFileSync(new URL('../migrations/0008_vault.sql', import.meta.url), 'utf8'))
  const call = async (method: string, path: string, body?: object) => vaultApi(new Request(`https://example.test${path}`, {
    method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
  }), db as unknown as D1Database, key, actor, path)
  const vault = await (await call('POST', '/admin/vaults', { name: 'Fixture' })).json() as { id: number }
  const prefix = `/admin/vaults/${vault.id}/secrets`
  const token = await (await call('POST', prefix, { name: 'Token', type: 'value', value: 'synthetic-token' })).json() as { id: number; version: number }
  const userpass = await (await call('POST', prefix, { name: 'Login', type: 'userpass', userpass: { username: 'u', password: 'p' } })).json() as { id: number }
  const ref = { vaultId: vault.id, secretId: token.id }
  await db.prepare('INSERT INTO http_checks VALUES (?,?,?)').bind('check', 2, JSON.stringify({ vaultHeaders: { 'X-Token': ref } })).run()
  const typedDb = db as unknown as D1Database
  assert.equal((await resolveMonitorHeaderSnapshots(typedDb, key, 'check', 2))?.['X-Token']?.value, 'synthetic-token')
  assert.equal(await resolveMonitorHeaderSnapshots(typedDb, key, 'check', 1), null)
  assert.equal(await resolveMonitorHeaderSnapshots(typedDb, key, 'other', 2), null)
  assert.equal(await resolveMonitorHeaderSnapshots(typedDb, 'ff'.repeat(32), 'check', 2), null)
  await db.prepare('UPDATE http_checks SET advanced_config=? WHERE id=?').bind(JSON.stringify({vaultHeaders:{'X-Token':{vaultId:vault.id,secretId:userpass.id}}}), 'check').run()
  assert.equal(await resolveMonitorHeaderSnapshots(typedDb, key, 'check', 2), null)
  await db.prepare('UPDATE http_checks SET advanced_config=? WHERE id=?').bind(JSON.stringify({vaultHeaders:{'X-Token':ref}}), 'check').run()
  assert.equal((await call('PATCH', `${prefix}/${token.id}`, { version: token.version, value: 'rotated-token' })).status, 200)
  assert.equal((await resolveMonitorHeaderSnapshots(typedDb, key, 'check', 2))?.['X-Token']?.value, 'rotated-token')
  assert.equal((await call('DELETE', `${prefix}/${token.id}`, { version: 2 })).status, 200)
  assert.equal(await resolveMonitorHeaderSnapshots(typedDb, key, 'check', 2), null)
  db.sqlite.close()
})
