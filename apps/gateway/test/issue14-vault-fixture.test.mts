import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { ensureIssue14VaultFixture } from '../issue14-vault-fixture.ts'
import { vaultKeyReady } from '../../worker/src/vault.ts'

class Statement {
  private values: unknown[] = []
  constructor(private db: DatabaseSync, private sql: string) {}
  bind(...values: unknown[]) { this.values = values; return this }
  runSync() { const result = this.db.prepare(this.sql).run(...this.values as never[]); return { success: true, meta: { changes: Number(result.changes) } } }
  async run() { return this.runSync() }
  async first<T>() { return (this.db.prepare(this.sql).get(...this.values as never[]) ?? null) as T | null }
}
class DB {
  raw = new DatabaseSync(':memory:')
  prepare(sql: string) { return new Statement(this.raw, sql) }
  async batch(statements: Statement[]) {
    this.raw.exec('BEGIN')
    try { const result = statements.map(s => s.runSync()); this.raw.exec('COMMIT'); return result }
    catch (error) { this.raw.exec('ROLLBACK'); throw error }
  }
}
const actor = { id: 'test-admin', role: 'admin', version: 1 }
const key = 'ab'.repeat(32)
const scope = '737597c9ba1d3cc17826ea2f2b48a9d259e03dbf1acd241dc62d886da5c20511'
function fixture() {
  const db = new DB()
  for (const name of ['0001_board.sql', '0008_vault.sql']) db.raw.exec(readFileSync(new URL(`../../worker/migrations/${name}`, import.meta.url), 'utf8'))
  db.raw.prepare("INSERT INTO users (id,issuer,subject,email,role) VALUES (?,?,?,?,?)").run(actor.id, 'issuer', 'subject', 'admin@example.test', 'admin')
  const env = { DB: db as unknown as D1Database, API_SCOPE: 'operations', PREVIEW_SUBSCRIBER_REQUIRED: 'true', PREVIEW_SUBSCRIBER_SCOPE: scope, PREVIEW_RELEASE: 'a'.repeat(40), VAULT_ENCRYPTION_KEY: key }
  return { db, env }
}
function count(db: DB, table: string) { return Number((db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n) }

test('initializes one encrypted synthetic fixture, even with concurrent requests', async () => {
  const { db, env } = fixture()
  assert.deepEqual(await Promise.all([ensureIssue14VaultFixture(env, actor), ensureIssue14VaultFixture(env, actor)]), [true, true])
  assert.equal(count(db, 'vaults'), 1)
  assert.equal(count(db, 'vault_secrets'), 1)
  assert.equal(count(db, 'audit_events'), 1)
  const row = db.raw.prepare('SELECT vault_id,id,type,ciphertext,nonce FROM vault_secrets').get() as { vault_id: number; id: number; type: string; ciphertext: string; nonce: string }
  const cipherKey = await crypto.subtle.importKey('raw', Uint8Array.from(key.match(/../g)!, value => parseInt(value, 16)), 'AES-GCM', false, ['decrypt'])
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(row.nonce, 'base64'), additionalData: new TextEncoder().encode(`status-vault-v1:${row.vault_id}:${row.id}:${row.type}`) }, cipherKey, Buffer.from(row.ciphertext, 'base64'))
  assert.deepEqual(JSON.parse(new TextDecoder().decode(plaintext)), { value: 'isolated-preview-dummy-value' })
  db.raw.exec('DELETE FROM vault_secrets; DELETE FROM vaults')
  assert.equal(await ensureIssue14VaultFixture(env, actor), true)
  assert.equal(count(db, 'vaults'), 0, 'deleted test data is not silently recreated')
})

test('does not initialize outside the exact scope or for an unauthorized actor', async () => {
  for (const changes of [{ API_SCOPE: 'monitoring' }, { PREVIEW_SUBSCRIBER_REQUIRED: 'false' }, { PREVIEW_SUBSCRIBER_SCOPE: 'wrong' }, { PREVIEW_RELEASE: 'wrong' }, { VAULT_ENCRYPTION_KEY: undefined }]) {
    const { db, env } = fixture()
    assert.equal(await ensureIssue14VaultFixture({ ...env, ...changes }, actor), false)
    assert.equal(count(db, 'vaults'), 0)
    assert.equal(count(db, 'vault_key_verifier'), 0)
  }
  const { db, env } = fixture()
  assert.equal(await ensureIssue14VaultFixture(env, { ...actor, role: 'viewer' }), false)
  db.raw.exec("UPDATE users SET role='viewer', version=version+1")
  assert.equal(await ensureIssue14VaultFixture(env, actor), false)
  assert.equal(count(db, 'vaults'), 0)
  assert.equal(count(db, 'vault_key_verifier'), 0)
})

test('does not overwrite existing vault data or a database bound to a different key', async () => {
  const occupied = fixture()
  occupied.db.raw.exec("INSERT INTO vaults (id,name,created_at,updated_at) VALUES (7,'existing',0,0)")
  assert.equal(await ensureIssue14VaultFixture(occupied.env, actor), false)
  assert.equal(count(occupied.db, 'vaults'), 1)
  assert.equal(count(occupied.db, 'vault_key_verifier'), 0)
  const wrongKey = fixture()
  assert.equal(await vaultKeyReady(wrongKey.env.DB, 'cd'.repeat(32)), true)
  assert.equal(await ensureIssue14VaultFixture(wrongKey.env, actor), false)
  assert.equal(count(wrongKey.db, 'vaults'), 0)
})
