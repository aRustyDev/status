import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { enqueueSubscriberDeliveries, flushSubscriberDeliveries } from '../src/subscriber-delivery.ts'

class Statement {
  private values: unknown[] = []
  constructor(private sql: string, private db: DatabaseSync) {}
  bind(...values: unknown[]) { this.values = values; return this }
  runSync() { const result = this.db.prepare(this.sql).run(...this.values as never[]); return { success: true, meta: { changes: Number(result.changes) } } }
  async run() { return this.runSync() }
  async first<T>() { return (this.db.prepare(this.sql).get(...this.values as never[]) ?? null) as T | null }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...this.values as never[]) as T[] } }
}
class Database {
  readonly sqlite = new DatabaseSync(':memory:')
  prepare(sql: string) { return new Statement(sql, this.sqlite) }
  async batch(statements: Statement[]) { this.sqlite.exec('BEGIN'); try { const result = statements.map(s => s.runSync()); this.sqlite.exec('COMMIT'); return result } catch (error) { this.sqlite.exec('ROLLBACK'); throw error } }
}
function fixture(send?: () => Promise<unknown>) {
  const local = new Database()
  local.sqlite.exec(`CREATE TABLE users (id TEXT PRIMARY KEY,email TEXT);
    INSERT INTO users VALUES ('owner','test@example.test');
    CREATE TABLE subscribers (id INTEGER PRIMARY KEY,email TEXT,status TEXT,events TEXT,monitor_ids TEXT,last_notified_at INTEGER,last_error TEXT,updated_at INTEGER,user_id TEXT);
    CREATE TABLE subscription_settings(id INTEGER PRIMARY KEY,enabled INTEGER,allow_email INTEGER,allowed_events TEXT,updated_at INTEGER);
    INSERT INTO subscription_settings VALUES (1,1,1,'["incident.created"]',0);
    INSERT INTO subscribers VALUES (1,'test@example.test','active','["incident.created"]','["component-a"]',NULL,NULL,0,'owner');`)
  local.sqlite.exec(readFileSync(new URL('../migrations/0019_subscriber_deliveries.sql',import.meta.url),'utf8'))
  let calls = 0
  const env = { DB: local as unknown as D1Database, SUBSCRIBER_EMAIL_READY: 'true', SUBSCRIBER_EMAIL_FROM: 'status@example.test', SUBSCRIBER_EMAIL_DESTINATIONS: JSON.stringify([{id:'test',name:'Test',address:'test@example.test'}]), SUBSCRIBER_PUBLIC_URL: 'https://status.example.test', SUBSCRIBER_EMAIL: {send: async () => { calls++; return send ? send() : {messageId:'accepted'} }} as unknown as SendEmail }
  return {local,env,get calls() { return calls }}
}
test('queues scoped publications once and delivers through the approved binding', async () => {
  const x = fixture()
  await enqueueSubscriberDeliveries(x.env.DB,'event-1','incident.created',['component-a'],1).run()
  await enqueueSubscriberDeliveries(x.env.DB,'event-1','incident.created',['component-a'],1).run()
  await enqueueSubscriberDeliveries(x.env.DB,'event-2','incident.created',['other'],1).run()
  await flushSubscriberDeliveries(x.env)
  await flushSubscriberDeliveries(x.env)
  assert.equal(x.calls,1)
  assert.equal((x.local.sqlite.prepare('SELECT state FROM subscriber_deliveries').get() as {state:string}).state,'delivered')
})
test('unsubscribe before dispatch cancels and ambiguous failure never retries', async () => {
  const cancelled = fixture()
  await enqueueSubscriberDeliveries(cancelled.env.DB,'event-1','incident.created',[],1).run()
  cancelled.local.sqlite.exec("UPDATE subscribers SET status='unsubscribed'")
  await flushSubscriberDeliveries(cancelled.env)
  assert.equal(cancelled.calls,0)
  assert.equal((cancelled.local.sqlite.prepare('SELECT state FROM subscriber_deliveries').get() as {state:string}).state,'cancelled')
  const failed = fixture(async () => { throw new Error('private provider response') })
  await enqueueSubscriberDeliveries(failed.env.DB,'event-2','incident.created',[],1).run()
  await flushSubscriberDeliveries(failed.env)
  await flushSubscriberDeliveries(failed.env)
  assert.equal(failed.calls,1)
  assert.deepEqual({ ...failed.local.sqlite.prepare('SELECT state,error_code FROM subscriber_deliveries').get() },{state:'failed',error_code:'delivery_failed'})
})


test('expired claims fail closed and old terminal records are pruned', async () => {
  const x = fixture()
  await enqueueSubscriberDeliveries(x.env.DB,'expired','incident.created',[],Date.now()).run()
  x.local.sqlite.prepare("UPDATE subscriber_deliveries SET state='sending',lease_token='old',lease_until=?,attempts=1").run(Date.now()-1)
  await flushSubscriberDeliveries(x.env)
  assert.equal(x.calls,0)
  assert.equal((x.local.sqlite.prepare('SELECT state FROM subscriber_deliveries').get() as {state:string}).state,'failed')
  x.local.sqlite.prepare('UPDATE subscriber_deliveries SET updated_at=?').run(Date.now()-91*86_400_000)
  await flushSubscriberDeliveries(x.env)
  assert.equal((x.local.sqlite.prepare('SELECT count(*) AS count FROM subscriber_deliveries').get() as {count:number}).count,0)
})

test('concurrent dispatchers send only once and respect changed preferences', async () => {
  const x = fixture()
  await enqueueSubscriberDeliveries(x.env.DB,'event','incident.created',['component-a'],Date.now()).run()
  await Promise.all([flushSubscriberDeliveries(x.env), flushSubscriberDeliveries(x.env)])
  assert.equal(x.calls,1)
  const changed = fixture()
  await enqueueSubscriberDeliveries(changed.env.DB,'event','incident.created',['component-a'],10).run()
  changed.local.sqlite.exec("UPDATE subscribers SET monitor_ids='[\"other\"]',updated_at=11")
  await flushSubscriberDeliveries(changed.env)
  assert.equal(changed.calls,0)
  assert.equal((changed.local.sqlite.prepare('SELECT state FROM subscriber_deliveries').get() as {state:string}).state,'cancelled')
})

test('publication guard rejects stale or draft mutations within the transaction', async () => {
  const x = fixture()
  x.local.sqlite.exec("CREATE TABLE incidents(id TEXT PRIMARY KEY,mutation_key TEXT,draft INTEGER); INSERT INTO incidents VALUES ('incident','current',1)")
  await enqueueSubscriberDeliveries(x.env.DB,'draft','incident.created',[],1,{table:'incidents',id:'incident',mutationKey:'current'}).run()
  x.local.sqlite.exec("UPDATE incidents SET draft=0")
  await enqueueSubscriberDeliveries(x.env.DB,'stale','incident.created',[],1,{table:'incidents',id:'incident',mutationKey:'stale'}).run()
  assert.equal((x.local.sqlite.prepare('SELECT count(*) AS count FROM subscriber_deliveries').get() as {count:number}).count,0)
  await enqueueSubscriberDeliveries(x.env.DB,'published','incident.created',[],1,{table:'incidents',id:'incident',mutationKey:'current'}).run()
  assert.equal((x.local.sqlite.prepare('SELECT count(*) AS count FROM subscriber_deliveries').get() as {count:number}).count,1)
})


test('an Access identity email change cancels a queued delivery to the old address', async () => {
  const x = fixture()
  await enqueueSubscriberDeliveries(x.env.DB,'event','incident.created',[],Date.now()).run()
  x.local.sqlite.exec("UPDATE users SET email='new@example.test' WHERE id='owner'")
  await flushSubscriberDeliveries(x.env)
  assert.equal(x.calls,0)
  assert.equal((x.local.sqlite.prepare('SELECT state FROM subscriber_deliveries').get() as {state:string}).state,'cancelled')
})
