import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { subscriberApi, SubscriberError, subscriberEmailReady, type SubscriberEnv } from '../src/subscribers.ts'

class Statement {
  private values: unknown[] = []
  constructor(private sql: string, private db: DatabaseSync) {}
  bind(...values: unknown[]) { this.values = values; return this }
  runSync() { const result = this.db.prepare(this.sql).run(...this.values as never[]); return { success: true, meta: { changes: Number(result.changes) } } }
  async run() { return this.runSync() }
  async first<T>() { return (this.db.prepare(this.sql).get(...this.values as never[]) ?? null) as T | null }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...this.values as never[]) as T[] } }
}
class DB {
  readonly db = new DatabaseSync(':memory:')
  prepare(sql: string) { return new Statement(sql, this.db) }
  async batch(statements: Statement[]) {
    this.db.exec('BEGIN')
    try { const result = statements.map(item => item.runSync()); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
}
const owner = { id:'a', email:'a@example.test', role:'viewer' }
const other = { id:'b', email:'b@example.test', role:'viewer' }
const operator = { id:'o', email:'o@example.test', role:'operator' }
const request = (method: string, data?: unknown) => new Request('https://status.example.test', { method, headers: { 'Content-Type':'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) })
function fixture() {
  const local = new DB()
  for (const file of ['0001_board.sql', '0004_aliases.sql', '0018_subscribers.sql', '0020_preview_subscribers.sql', '0021_preview_audit_scope.sql']) local.db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'))
  local.db.exec("INSERT INTO users (id,issuer,subject,email,role) VALUES ('a','issuer','a','a@example.test','viewer'),('b','issuer','b','b@example.test','viewer'),('o','issuer','o','o@example.test','operator')")
  local.db.exec("UPDATE subscription_settings SET enabled=1,allow_email=1 WHERE id=1")
  const messages: Array<{text:string}> = []
  const env = { DB:local as unknown as D1Database, SUBSCRIBER_EMAIL_READY:'true', SUBSCRIBER_EMAIL_FROM:'sender@example.test', SUBSCRIBER_EMAIL_DESTINATIONS: JSON.stringify([{ id:'a', name:'A', address:owner.email }]), SUBSCRIBER_PUBLIC_URL:'https://status.example.test', SUBSCRIBER_EMAIL:{ send:async (message: {text:string}) => { messages.push(message); return {messageId:'ok'} } } as unknown as SendEmail } satisfies SubscriberEnv
  return { local, env, messages }
}
const enrollment = { type:'email', email:owner.email, events:['incident.created'], monitorIds:[], tags:[] }

test('approved identity enrolls, confirms once, manages and unsubscribes even when sending is unavailable', async () => {
  const { env, messages, local } = fixture()
  assert.equal((await subscriberApi(request('POST',enrollment),env,owner,'/public/subscriptions')).status,202)
  const token = /token=([0-9a-f]+)/.exec(messages[0]!.text)![1]!
  assert.notEqual((local.db.prepare('SELECT confirmation_hash FROM subscribers').get() as {confirmation_hash:string}).confirmation_hash, token)
  await assert.rejects(() => subscriberApi(request('POST',{token}),env,other,'/public/subscriptions/confirm'), (error:unknown) => error instanceof SubscriberError && error.status === 404)
  assert.equal((await subscriberApi(request('POST',{token}),env,owner,'/public/subscriptions/confirm')).status,200)
  await assert.rejects(() => subscriberApi(request('POST',{token}),env,owner,'/public/subscriptions/confirm'), (error:unknown) => error instanceof SubscriberError && error.status === 404)
  await assert.rejects(() => subscriberApi(request('POST',{}),env,other,'/public/subscriptions/preferences'), (error:unknown) => error instanceof SubscriberError && error.status === 404)
  const unavailable = {...env, SUBSCRIBER_EMAIL_READY:'false'}
  assert.equal((await subscriberApi(request('POST',{}),unavailable,owner,'/public/subscriptions/unsubscribe')).status,200)
  assert.equal((local.db.prepare('SELECT status FROM subscribers').get() as {status:string}).status,'unsubscribed')
})

test('rejects unapproved or mismatched addresses, unavailable configuration and unauthorized management', async () => {
  const { env, messages } = fixture()
  assert.equal(subscriberEmailReady({...env,SUBSCRIBER_PUBLIC_URL:'https://evil.test/path'}),false)
  await assert.rejects(() => subscriberApi(request('POST',{...enrollment,email:other.email}),env,owner,'/public/subscriptions'), SubscriberError)
  await assert.rejects(() => subscriberApi(request('POST',{...enrollment,email:other.email}),env,other,'/public/subscriptions'), SubscriberError)
  await assert.rejects(() => subscriberApi(request('POST',enrollment),{...env,SUBSCRIBER_EMAIL_READY:'false'},owner,'/public/subscriptions'), SubscriberError)
  await assert.rejects(() => subscriberApi(request('POST',{}),env,owner,'/admin/subscribers/search'), (error:unknown) => error instanceof SubscriberError && error.status === 403)
  assert.equal(messages.length,0)
  assert.equal((await subscriberApi(request('POST',{}),env,operator,'/admin/subscribers/search')).status,200)
})

test('expired and disallowed confirmation links cannot activate an account', async () => {
  const { env, local, messages } = fixture()
  await subscriberApi(request('POST',enrollment),env,owner,'/public/subscriptions')
  const token = /token=([0-9a-f]+)/.exec(messages[0]!.text)![1]!
  const removed = {...env, SUBSCRIBER_EMAIL_DESTINATIONS:'[]'}
  await assert.rejects(() => subscriberApi(request('POST',{token}),removed,owner,'/public/subscriptions/confirm'), SubscriberError)
  local.db.exec('UPDATE subscribers SET confirmation_expires_at=0')
  await assert.rejects(() => subscriberApi(request('POST',{token}),env,owner,'/public/subscriptions/confirm'), SubscriberError)
  assert.equal((local.db.prepare('SELECT status FROM subscribers').get() as {status:string}).status,'pending')
})

test('admin search, CSV export and deletion are filtered and audited', async () => {
  const { env, local } = fixture()
  await subscriberApi(request('POST',enrollment),env,owner,'/public/subscriptions')
  const search = await (await subscriberApi(request('POST',{search:'a@example',status:'pending'}),env,operator,'/admin/subscribers/search')).json() as {total:number;subscribers:Array<{id:number}>}
  assert.equal(search.total,1)
  const empty = await (await subscriberApi(request('POST',{search:'no-match'}),env,operator,'/admin/subscribers/search')).json() as {total:number}
  assert.equal(empty.total,0)
  const csv = await subscriberApi(request('POST',{ids:[search.subscribers[0]!.id]}),env,operator,'/admin/subscribers/export')
  assert.match(await csv.text(), /a@example\.test/)
  await subscriberApi(request('DELETE'),env,operator,`/admin/subscribers/${search.subscribers[0]!.id}`)
  assert.equal((local.db.prepare('SELECT COUNT(*) AS n FROM subscribers').get() as {n:number}).n,0)
  assert.equal((local.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE entity_type='subscriber'").get() as {n:number}).n,1)
})

test('resubscription sends a fresh single-use confirmation after the cooldown', async () => {
  const { env, local, messages } = fixture()
  await subscriberApi(request('POST',enrollment),env,owner,'/public/subscriptions')
  const first = /token=([0-9a-f]+)/.exec(messages[0]!.text)![1]!
  await subscriberApi(request('POST',{token:first}),env,owner,'/public/subscriptions/confirm')
  await subscriberApi(request('POST',{}),env,owner,'/public/subscriptions/unsubscribe')
  await assert.rejects(() => subscriberApi(request('POST',enrollment),env,owner,'/public/subscriptions'), (error:unknown) => error instanceof SubscriberError && error.status === 429)
  local.db.exec('UPDATE subscribers SET confirmation_sent_at=0')
  await subscriberApi(request('POST',enrollment),env,owner,'/public/subscriptions')
  const second = /token=([0-9a-f]+)/.exec(messages[1]!.text)![1]!
  assert.notEqual(first,second)
  assert.equal((local.db.prepare('SELECT status FROM subscribers').get() as {status:string}).status,'pending')
  await subscriberApi(request('POST',{token:second}),env,owner,'/public/subscriptions/confirm')
  assert.equal((local.db.prepare('SELECT status FROM subscribers').get() as {status:string}).status,'active')
})

test('preview leases isolate settings, enrollments, confirmations and admin operations', async () => {
  const {env, local, messages} = fixture()
  const first = {...env, PREVIEW_SUBSCRIBER_REQUIRED:'true', PREVIEW_SUBSCRIBER_SCOPE:'a'.repeat(64)}
  const second = {...env, PREVIEW_SUBSCRIBER_REQUIRED:'true', PREVIEW_SUBSCRIBER_SCOPE:'b'.repeat(64)}
  const update = { enabled:true, allowEmail:true, allowComponentScope:true, allowedEvents:['incident.created'] }
  await subscriberApi(request('PUT',update),first,operator,'/admin/subscribers/settings')
  assert.equal((local.db.prepare("SELECT preview_scope FROM audit_events WHERE entity_type='subscription_settings' ORDER BY rowid DESC").get() as {preview_scope:string}).preview_scope,first.PREVIEW_SUBSCRIBER_SCOPE)
  assert.equal(((await (await subscriberApi(request('GET'),second,operator,'/admin/subscribers/settings')).json()) as {enabled:boolean}).enabled,false)
  await subscriberApi(request('PUT',update),second,operator,'/admin/subscribers/settings')
  await subscriberApi(request('POST',enrollment),first,owner,'/public/subscriptions')
  const firstToken = /token=([0-9a-f]+)/.exec(messages[0]!.text)![1]!
  await subscriberApi(request('POST',enrollment),second,owner,'/public/subscriptions')
  const secondToken = /token=([0-9a-f]+)/.exec(messages[1]!.text)![1]!
  await assert.rejects(() => subscriberApi(request('POST',{token:firstToken}),second,owner,'/public/subscriptions/confirm'), SubscriberError)
  await subscriberApi(request('POST',{token:firstToken}),first,owner,'/public/subscriptions/confirm')
  await subscriberApi(request('POST',{token:secondToken}),second,owner,'/public/subscriptions/confirm')
  const firstSearch = await (await subscriberApi(request('POST',{}),first,operator,'/admin/subscribers/search')).json() as {total:number; subscribers:Array<{id:number}>}
  const secondSearch = await (await subscriberApi(request('POST',{}),second,operator,'/admin/subscribers/search')).json() as {total:number; subscribers:Array<{id:number}>}
  assert.equal(firstSearch.total,1)
  assert.equal(secondSearch.total,1)
  await assert.rejects(() => subscriberApi(request('DELETE'),second,operator,`/admin/subscribers/${firstSearch.subscribers[0]!.id}`), SubscriberError)
  await subscriberApi(request('POST',{}),first,owner,'/public/subscriptions/unsubscribe')
  const secondRecord = local.db.prepare('SELECT status FROM preview_subscribers WHERE scope=?').get(second.PREVIEW_SUBSCRIBER_SCOPE) as {status:string}
  assert.equal(secondRecord.status,'active')
  await subscriberApi(request('DELETE'),first,operator,`/admin/subscribers/${firstSearch.subscribers[0]!.id}`)
  assert.equal((local.db.prepare("SELECT preview_scope FROM audit_events WHERE entity_type='subscriber' ORDER BY rowid DESC").get() as {preview_scope:string}).preview_scope,first.PREVIEW_SUBSCRIBER_SCOPE)
  assert.equal((local.db.prepare('SELECT count(*) AS n FROM subscribers').get() as {n:number}).n,0)
  await assert.rejects(() => subscriberApi(request('GET'),{...env,PREVIEW_SUBSCRIBER_REQUIRED:'true'},operator,'/admin/subscribers/settings'), /Missing preview subscriber scope/)
  await assert.rejects(() => subscriberApi(request('GET'),{...first,PREVIEW_SUBSCRIBER_SCOPE:'bad'},operator,'/admin/subscribers/settings'), /Invalid preview subscriber scope/)
})
