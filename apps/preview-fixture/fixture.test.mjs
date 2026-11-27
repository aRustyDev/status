import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import worker from './index.mjs'

function database() {
  const sql = new DatabaseSync(':memory:')
  sql.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'))
  return { sql, db: { prepare(query) { let args = []; return { bind(...values) { args = values; return this }, async first() { return sql.prepare(query).get(...args) }, async run() { return sql.prepare(query).run(...args) } } } } }
}
const base = 'https://preview-fixture.invalid'
const req = (path, options) => new Request(`${base}${path}`, options)
const post = (values) => ({ method: 'POST', body: new URLSearchParams(values) })

test('fixture monitor uses only its isolated control row', async () => {
  const { db, sql } = database()
  assert.equal((await worker.fetch(req('/monitor'), { DB: db })).status, 200)
  sql.exec("UPDATE preview_fixture_control SET monitor_status='down' WHERE id=1")
  assert.equal((await worker.fetch(req('/monitor'), { DB: db })).status, 503)
  assert.equal((await worker.fetch(req('/monitor', { method: 'POST' }), { DB: db })).status, 404)
  assert.equal((await worker.fetch(new Request('https://example.com/monitor'), { DB: db })).status, 404)
})

test('Actions receipt stores only hashed idempotency metadata and deduplicates', async () => {
  const { db, sql } = database()
  const payload = { status: 'down', scheduledAt: 1234, secret: 'never-store-this' }
  const send = (auth = 'Bearer synthetic', key = 'synthetic-idempotency') => worker.fetch(req('/actions/success', { method: 'POST', headers: { authorization: auth, 'idempotency-key': key }, body: JSON.stringify(payload) }), { DB: db })
  assert.equal((await send()).status, 204)
  assert.equal((await send()).status, 204)
  assert.equal((await send('invalid')).status, 401)
  const rows = sql.prepare('SELECT * FROM preview_fixture_receipts').all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].attempts, 2)
  assert.match(rows[0].key_hash, /^[0-9a-f]{64}$/)
  assert.doesNotMatch(JSON.stringify(rows), /synthetic-idempotency|synthetic|never-store-this/)
  assert.equal((await worker.fetch(req('/actions/success', { method: 'POST', headers: { authorization: 'Bearer x', 'idempotency-key': 'a' }, body: 'x'.repeat(8193) }), { DB: db })).status, 400)
})

test('CAS and OAuth use deterministic synthetic credentials and reject failures', async () => {
  const env = { DB: database().db }
  const credentials = { username: 'preview-fixture-user', password: 'preview-fixture-password' }
  assert.equal((await worker.fetch(req('/cas/v1/tickets', post({ ...credentials, password: 'bad' })), env)).status, 401)
  const tgt = await worker.fetch(req('/cas/v1/tickets', post(credentials)), env)
  assert.equal(tgt.status, 201)
  assert.equal(tgt.headers.get('location'), `${base}/cas/v1/tickets/TGT-preview-fixture`)
  assert.equal((await worker.fetch(req('/cas/v1/tickets/TGT-preview-fixture', post({ service: 'https://example.com' })), env)).status, 400)
  const st = await worker.fetch(req('/cas/v1/tickets/TGT-preview-fixture', post({ service: `${base}/cas-health` })), env)
  assert.equal(await st.text(), 'ST-preview-fixture')
  const callback = await worker.fetch(req('/cas-health?ticket=ST-preview-fixture'), env)
  assert.equal(callback.status, 302)
  assert.equal((await worker.fetch(req('/cas-health', { headers: { cookie: callback.headers.get('set-cookie').split(';')[0] } }), env)).status, 200)
  assert.equal((await worker.fetch(req('/cas-health'), env)).status, 401)
  const oauth = await worker.fetch(req('/oauth/token', post({ grant_type: 'client_credentials', client_id: credentials.username, client_secret: credentials.password })), env)
  assert.equal(oauth.status, 200)
  assert.equal((await worker.fetch(req('/oauth-health', { headers: { authorization: `Bearer ${(await oauth.json()).access_token}` } }), env)).status, 200)
})
