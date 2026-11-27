import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { enqueueSubscriberDeliveries, flushSubscriberDeliveries } from '../src/subscriber-delivery.ts'
import { flushPreviewSubscriberDeliveries, PREVIEW_BRANCH_DELIVERY_CONTEXT_CONTRACT, PREVIEW_SUBSCRIBER_SCHEDULER_CONTRACT } from '../src/preview-subscriber-scheduler.ts'

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
  local.sqlite.exec(`CREATE TABLE audit_events (id TEXT PRIMARY KEY);
    CREATE TABLE users (id TEXT PRIMARY KEY,email TEXT);
    INSERT INTO users VALUES ('owner','test@example.test');
    CREATE TABLE subscribers (id INTEGER PRIMARY KEY,email TEXT,status TEXT,events TEXT,monitor_ids TEXT,last_notified_at INTEGER,last_error TEXT,updated_at INTEGER,user_id TEXT);
    CREATE TABLE subscription_settings(id INTEGER PRIMARY KEY,enabled INTEGER,allow_email INTEGER,allowed_events TEXT,updated_at INTEGER);
    INSERT INTO subscription_settings VALUES (1,1,1,'["incident.created"]',0);
    INSERT INTO subscribers VALUES (1,'test@example.test','active','["incident.created"]','["component-a"]',NULL,NULL,0,'owner');`)
  local.sqlite.exec(readFileSync(new URL('../migrations/0019_subscriber_deliveries.sql',import.meta.url),'utf8'))
  local.sqlite.exec(readFileSync(new URL('../migrations/0020_preview_subscribers.sql',import.meta.url),'utf8'))
  local.sqlite.exec(readFileSync(new URL('../migrations/0021_preview_audit_scope.sql',import.meta.url),'utf8'))
  local.sqlite.exec(readFileSync(new URL('../migrations/0022_preview_audit_events.sql',import.meta.url),'utf8'))
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

test('preview dispatch and maintenance isolate leases and baseline deliveries', async () => {
  const x = fixture()
  const a = 'a'.repeat(64), b = 'b'.repeat(64), release = 'c'.repeat(40)
  const preview = (scope:string, slot:string) => ({...x.env, PREVIEW_SUBSCRIBER_REQUIRED:'true', PREVIEW_SUBSCRIBER_SCOPE:scope, PREVIEW_SLOT:slot, PREVIEW_TARGET:'a', PREVIEW_RELEASE:release, SUBSCRIBERS_READY:'true'})
  const first = preview(a,'1'), second = preview(b,'2')
  const now = Date.now()
  const settings = x.local.sqlite.prepare("INSERT INTO preview_subscription_settings(scope,enabled,allow_email,allowed_events,updated_at) VALUES (?,1,1,'[\"incident.created\"]',0)")
  const subscriber = x.local.sqlite.prepare("INSERT INTO preview_subscribers(scope,user_id,email,status,events,monitor_ids,created_at,updated_at) VALUES (?,'owner','test@example.test','active','[\"incident.created\"]','[]',0,0)")
  const lease = x.local.sqlite.prepare('INSERT INTO preview_subscriber_leases(scope,slot,target,release,expires_at) VALUES (?,?,\'a\',?,?)')
  for (const [scope,slot] of [[a,1],[b,2]] as const) { settings.run(scope); subscriber.run(scope); lease.run(scope,slot,release,now+60_000) }
  await enqueueSubscriberDeliveries(x.env.DB,'baseline','incident.created',[],now).run()
  await enqueueSubscriberDeliveries(x.env.DB,'first','incident.created',[],now,undefined,first).run()
  await enqueueSubscriberDeliveries(x.env.DB,'second','incident.created',[],now,undefined,second).run()
  const old = now-91*86_400_000
  x.local.sqlite.prepare("INSERT INTO preview_subscriber_deliveries(id,scope,subscriber_id,event_id,event_type,component_ids,state,created_at,updated_at) SELECT 'old-b',scope,id,'old-b','incident.created','[]','delivered',?,? FROM preview_subscribers WHERE scope=?").run(old,old,b)
  await flushPreviewSubscriberDeliveries(first,async () => true)
  assert.equal(x.calls,1)
  assert.equal((x.local.sqlite.prepare("SELECT state FROM preview_subscriber_deliveries WHERE event_id='first'").get() as {state:string}).state,'delivered')
  assert.equal((x.local.sqlite.prepare("SELECT state FROM preview_subscriber_deliveries WHERE event_id='second'").get() as {state:string}).state,'pending')
  assert.equal((x.local.sqlite.prepare("SELECT count(*) AS n FROM preview_subscriber_deliveries WHERE id='old-b'").get() as {n:number}).n,1)
  assert.equal((x.local.sqlite.prepare('SELECT state FROM subscriber_deliveries').get() as {state:string}).state,'pending')
  x.local.sqlite.prepare('UPDATE preview_subscriber_leases SET target=\'b\' WHERE scope=?').run(b)
  await flushPreviewSubscriberDeliveries(second,async () => true)
  assert.equal(x.calls,1)
  assert.equal((x.local.sqlite.prepare("SELECT state FROM preview_subscriber_deliveries WHERE event_id='second'").get() as {state:string}).state,'pending')
  assert.equal((x.local.sqlite.prepare("SELECT count(*) AS n FROM preview_subscriber_deliveries WHERE id='old-b'").get() as {n:number}).n,1)
  await assert.rejects(() => flushPreviewSubscriberDeliveries({...first, PREVIEW_SUBSCRIBER_SCOPE:undefined},async () => true), /Missing preview subscriber scope/)
  await assert.rejects(() => flushPreviewSubscriberDeliveries(first), /Missing preview send authorization/)
  await assert.rejects(() => flushSubscriberDeliveries(first), /fenced preview scheduler/)
})

test('preview send carries the exact live claim only when context is enabled', async () => {
  assert.equal(PREVIEW_SUBSCRIBER_SCHEDULER_CONTRACT,2)
  assert.equal(PREVIEW_BRANCH_DELIVERY_CONTEXT_CONTRACT,1)
  for (const flag of ['true', 'false', undefined]) {
    const x=fixture(), scope='a'.repeat(64), release='b'.repeat(40), now=Date.now()
    x.local.sqlite.prepare("INSERT INTO preview_subscription_settings(scope,enabled,allow_email,allowed_events,updated_at) VALUES (?,1,1,'[\"incident.created\"]',0)").run(scope)
    x.local.sqlite.prepare("INSERT INTO preview_subscribers(scope,user_id,email,status,events,monitor_ids,created_at,updated_at) VALUES (?,'owner','test@example.test','active','[\"incident.created\"]','[]',0,0)").run(scope)
    x.local.sqlite.prepare("INSERT INTO preview_subscriber_leases(scope,slot,target,release,expires_at) VALUES (?,1,'a',?,?)").run(scope,release,now+60_000)
    const messages:Array<Record<string,unknown>>=[]
    const preview={...x.env,PREVIEW_SUBSCRIBER_REQUIRED:'true',PREVIEW_SUBSCRIBER_SCOPE:scope,PREVIEW_SLOT:'1',PREVIEW_TARGET:'a',PREVIEW_RELEASE:release,SUBSCRIBERS_READY:'true',PREVIEW_BRANCH_DELIVERY_CONTEXT:flag,
      SUBSCRIBER_EMAIL:{send:async (message:Record<string,unknown>) => {
        messages.push(message)
        const claimed=x.local.sqlite.prepare("SELECT id,scope,lease_token FROM preview_subscriber_deliveries WHERE state='sending'").get() as {id:string;scope:string;lease_token:string}
        if(flag==='true') assert.deepEqual(message.previewDelivery,{id:claimed.id,scope:claimed.scope,leaseToken:claimed.lease_token})
        else assert.equal(Object.hasOwn(message,'previewDelivery'),false)
        return {messageId:'ok'}
      }} as unknown as SendEmail}
    await enqueueSubscriberDeliveries(preview.DB,'event','incident.created',[],now,undefined,preview).run()
    await flushPreviewSubscriberDeliveries(preview,async () => true)
    assert.equal(messages.length,1)
    assert.equal((x.local.sqlite.prepare('SELECT state FROM preview_subscriber_deliveries').get() as {state:string}).state,'delivered')
    x.local.sqlite.close()
  }
})

test('branch schema dispatch uses an isolated release fence and stops after revocation', async () => {
  const selector = 'branch-1234567890abcdef12345678'
  const scope = createHash('sha256').update(selector).digest('hex')
  const now = Date.now()
  const setup = async (release: string) => {
    const x = fixture()
    x.local.sqlite.prepare("INSERT INTO preview_subscription_settings(scope,enabled,allow_email,allowed_events,updated_at) VALUES (?,1,1,'[\"incident.created\"]',0)").run(scope)
    x.local.sqlite.prepare("INSERT INTO preview_subscribers(scope,user_id,email,status,events,monitor_ids,created_at,updated_at) VALUES (?,'owner','test@example.test','active','[\"incident.created\"]','[]',0,0)").run(scope)
    // Each release has its own database, so the slot and target are local
    // sentinels; the trusted branch wrapper authorizes the actual route.
    x.local.sqlite.prepare("INSERT INTO preview_subscriber_leases(scope,slot,target,release,expires_at) VALUES (?,1,'a',?,?)").run(scope,release,now+60_000)
    const env = {...x.env,PREVIEW_SUBSCRIBER_REQUIRED:'true',PREVIEW_SUBSCRIBER_SCOPE:scope,PREVIEW_SLOT:'1',PREVIEW_TARGET:'a',PREVIEW_RELEASE:release,SUBSCRIBERS_READY:'true'}
    await enqueueSubscriberDeliveries(env.DB,'branch-event','incident.created',[],now,undefined,env).run()
    return {x,env}
  }
  const previous = await setup('b'.repeat(40))
  const active = await setup('c'.repeat(40))
  // Switching releases must revoke the previous release's own database fence;
  // creating the new release's fence does not affect that separate database.
  previous.x.local.sqlite.prepare('DELETE FROM preview_subscriber_leases WHERE scope=?').run(scope)
  await flushPreviewSubscriberDeliveries(previous.env,async () => true)
  await flushPreviewSubscriberDeliveries(active.env,async () => true)
  assert.equal(previous.x.calls,0)
  assert.equal((previous.x.local.sqlite.prepare('SELECT state FROM preview_subscriber_deliveries').get() as {state:string}).state,'pending')
  assert.equal(active.x.calls,1)
  assert.equal((active.x.local.sqlite.prepare('SELECT state FROM preview_subscriber_deliveries').get() as {state:string}).state,'delivered')
})

test('a lease revoked after claim is fenced before the provider call', async () => {
  const x = fixture(), scope = 'a'.repeat(64), release = 'b'.repeat(40), now = Date.now()
  x.local.sqlite.prepare("INSERT INTO preview_subscription_settings(scope,enabled,allow_email,allowed_events,updated_at) VALUES (?,1,1,'[\"incident.created\"]',0)").run(scope)
  x.local.sqlite.prepare("INSERT INTO preview_subscribers(scope,user_id,email,status,events,monitor_ids,created_at,updated_at) VALUES (?,'owner','test@example.test','active','[\"incident.created\"]','[]',0,0)").run(scope)
  x.local.sqlite.prepare('INSERT INTO preview_subscriber_leases(scope,slot,target,release,expires_at) VALUES (?,1,\'a\',?,?)').run(scope,release,now+60_000)
  const config = {...x.env,PREVIEW_SUBSCRIBER_REQUIRED:'true',PREVIEW_SUBSCRIBER_SCOPE:scope,PREVIEW_SLOT:'1',PREVIEW_TARGET:'a',PREVIEW_RELEASE:release,SUBSCRIBERS_READY:'true'}
  await enqueueSubscriberDeliveries(x.env.DB,'race','incident.created',[],now,undefined,config).run()
  const db = { prepare(sql:string) {
    const statement = x.local.prepare(sql)
    if (sql.startsWith('SELECT s.id AS subscriber_id')) {
      const first = statement.first.bind(statement)
      statement.first = async <T>() => { x.local.sqlite.prepare("UPDATE preview_subscriber_leases SET target='b' WHERE scope=?").run(scope); return first<T>() }
    }
    return statement
  }, batch: x.local.batch.bind(x.local) } as unknown as D1Database
  await flushPreviewSubscriberDeliveries({...config,DB:db},async () => true)
  assert.equal(x.calls,0)
  assert.equal((x.local.sqlite.prepare("SELECT state FROM preview_subscriber_deliveries WHERE event_id='race'").get() as {state:string}).state,'sending')
})

test('the preview switch is checked for every send and failures leave unsent jobs pending', async () => {
  const x = fixture(), scope = 'a'.repeat(64), release = 'b'.repeat(40), now = Date.now()
  x.local.sqlite.prepare("INSERT INTO preview_subscription_settings(scope,enabled,allow_email,allowed_events,updated_at) VALUES (?,1,1,'[\"incident.created\"]',0)").run(scope)
  x.local.sqlite.prepare("INSERT INTO preview_subscribers(scope,user_id,email,status,events,monitor_ids,created_at,updated_at) VALUES (?,'owner','test@example.test','active','[\"incident.created\"]','[]',0,0)").run(scope)
  x.local.sqlite.prepare('INSERT INTO preview_subscriber_leases(scope,slot,target,release,expires_at) VALUES (?,1,\'a\',?,?)').run(scope,release,now+60_000)
  const config = {...x.env,PREVIEW_SUBSCRIBER_REQUIRED:'true',PREVIEW_SUBSCRIBER_SCOPE:scope,PREVIEW_SLOT:'1',PREVIEW_TARGET:'a',PREVIEW_RELEASE:release,SUBSCRIBERS_READY:'true'}
  await enqueueSubscriberDeliveries(x.env.DB,'first','incident.created',[],now,undefined,config).run()
  await enqueueSubscriberDeliveries(x.env.DB,'second','incident.created',[],now+1,undefined,config).run()
  let checks = 0
  await flushPreviewSubscriberDeliveries(config,async () => ++checks === 1)
  assert.equal(checks,2)
  assert.equal(x.calls,1)
  assert.deepEqual({...x.local.sqlite.prepare("SELECT state,attempts FROM preview_subscriber_deliveries WHERE event_id='second'").get()},{state:'pending',attempts:0})
  await flushPreviewSubscriberDeliveries(config,async () => { throw new Error('Flagship unavailable') })
  assert.equal(x.calls,1)
  assert.deepEqual({...x.local.sqlite.prepare("SELECT state,attempts FROM preview_subscriber_deliveries WHERE event_id='second'").get()},{state:'pending',attempts:0})
})

test('an expired claim during authorization fails without sending or retrying', async () => {
  const x = fixture(), scope = 'a'.repeat(64), release = 'b'.repeat(40), now = Date.now()
  x.local.sqlite.prepare("INSERT INTO preview_subscription_settings(scope,enabled,allow_email,allowed_events,updated_at) VALUES (?,1,1,'[\"incident.created\"]',0)").run(scope)
  x.local.sqlite.prepare("INSERT INTO preview_subscribers(scope,user_id,email,status,events,monitor_ids,created_at,updated_at) VALUES (?,'owner','test@example.test','active','[\"incident.created\"]','[]',0,0)").run(scope)
  x.local.sqlite.prepare('INSERT INTO preview_subscriber_leases(scope,slot,target,release,expires_at) VALUES (?,1,\'a\',?,?)').run(scope,release,now+120_000)
  const config = {...x.env,PREVIEW_SUBSCRIBER_REQUIRED:'true',PREVIEW_SUBSCRIBER_SCOPE:scope,PREVIEW_SLOT:'1',PREVIEW_TARGET:'a',PREVIEW_RELEASE:release,SUBSCRIBERS_READY:'true'}
  await enqueueSubscriberDeliveries(x.env.DB,'expired-during-auth','incident.created',[],now,undefined,config).run()
  await flushPreviewSubscriberDeliveries(config,async () => { x.local.sqlite.prepare('UPDATE preview_subscriber_deliveries SET lease_until=?').run(Date.now()-1); return true })
  assert.equal(x.calls,0)
  await flushPreviewSubscriberDeliveries(config,async () => true)
  assert.equal(x.calls,0)
  assert.equal((x.local.sqlite.prepare('SELECT state FROM preview_subscriber_deliveries').get() as {state:string}).state,'failed')
})

test('unsubscribe, preference, settings, and identity changes during authorization cancel before send', async () => {
  for (const mutation of ["UPDATE preview_subscribers SET status='unsubscribed'", "UPDATE preview_subscribers SET events='[]'", "UPDATE preview_subscribers SET monitor_ids='[\"other\"]'", "UPDATE preview_subscription_settings SET enabled=0", "UPDATE preview_subscription_settings SET allowed_events='[]'", "UPDATE users SET email='changed@example.test'"]) {
    const x = fixture(), scope = 'a'.repeat(64), release = 'b'.repeat(40), now = Date.now()
    x.local.sqlite.prepare("INSERT INTO preview_subscription_settings(scope,enabled,allow_email,allowed_events,updated_at) VALUES (?,1,1,'[\"incident.created\"]',0)").run(scope)
    x.local.sqlite.prepare("INSERT INTO preview_subscribers(scope,user_id,email,status,events,monitor_ids,created_at,updated_at) VALUES (?,'owner','test@example.test','active','[\"incident.created\"]','[]',0,0)").run(scope)
    x.local.sqlite.prepare('INSERT INTO preview_subscriber_leases(scope,slot,target,release,expires_at) VALUES (?,1,\'a\',?,?)').run(scope,release,now+120_000)
    const config = {...x.env,PREVIEW_SUBSCRIBER_REQUIRED:'true',PREVIEW_SUBSCRIBER_SCOPE:scope,PREVIEW_SLOT:'1',PREVIEW_TARGET:'a',PREVIEW_RELEASE:release,SUBSCRIBERS_READY:'true'}
    await enqueueSubscriberDeliveries(x.env.DB,'changed','incident.created',['component-a'],now,undefined,config).run()
    await flushPreviewSubscriberDeliveries(config,async () => { x.local.sqlite.exec(mutation); return true })
    assert.equal(x.calls,0)
    assert.equal((x.local.sqlite.prepare('SELECT state FROM preview_subscriber_deliveries').get() as {state:string}).state,'cancelled')
  }
})

test('deleting a shared identity cascades only its preview subscriptions and deliveries', async () => {
  const x = fixture(), a = 'a'.repeat(64), b = 'b'.repeat(64), now = Date.now()
  x.local.sqlite.exec("PRAGMA foreign_keys=ON; INSERT INTO users VALUES ('other','other@example.test')")
  const settings = x.local.sqlite.prepare("INSERT INTO preview_subscription_settings(scope,enabled,allow_email,allowed_events) VALUES (?,1,1,'[\"incident.created\"]')")
  const subscriber = x.local.sqlite.prepare("INSERT INTO preview_subscribers(scope,user_id,email,status,events,monitor_ids,created_at,updated_at) VALUES (?,?,?,'active','[\"incident.created\"]','[]',0,0)")
  for (const scope of [a,b]) { settings.run(scope); subscriber.run(scope,'owner','test@example.test') }
  subscriber.run(b,'other','other@example.test')
  for (const scope of [a,b]) await enqueueSubscriberDeliveries(x.env.DB,`event-${scope[0]}`,'incident.created',[],now,undefined,{PREVIEW_SUBSCRIBER_SCOPE:scope}).run()
  x.local.sqlite.prepare('DELETE FROM users WHERE id=?').run('owner')
  const left = x.local.sqlite.prepare('SELECT scope,user_id FROM preview_subscribers').all().map(row => ({...row}))
  assert.deepEqual(left,[{scope:b,user_id:'other'}])
  const deliveries = x.local.sqlite.prepare('SELECT d.scope,s.user_id FROM preview_subscriber_deliveries d JOIN preview_subscribers s ON s.id=d.subscriber_id').all().map(row => ({...row}))
  assert.deepEqual(deliveries,[{scope:b,user_id:'other'}])
})
