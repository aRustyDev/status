import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { emailChannelFingerprint } from '../src/email-channel.ts'
import { enqueueTransition, flushChannelDeliveries, type ChannelEnvironment } from '../src/channels-runtime.ts'

// Execute the same SQL and transaction batches as D1, while keeping each fixture isolated.
class Statement {
  private values: unknown[] = []
  constructor(private sql: string, private database: DatabaseSync) {}
  bind(...values: unknown[]) { this.values = values; return this }
  runSync() { const result = this.database.prepare(this.sql).run(...this.values as never[]); return { success: true, meta: { changes: Number(result.changes) } } }
  async run() { return this.runSync() }
  async first<T>() { return (this.database.prepare(this.sql).get(...this.values as never[]) ?? null) as T | null }
  async all<T>() { return { results: this.database.prepare(this.sql).all(...this.values as never[]) as T[] } }
}
class Database {
  readonly sqlite = new DatabaseSync(':memory:')
  prepare(sql: string) { return new Statement(sql, this.sqlite) }
  async batch(statements: Statement[]) {
    this.sqlite.exec('BEGIN')
    try { const results = statements.map(statement => statement.runSync()); this.sqlite.exec('COMMIT'); return results }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error }
  }
}

const check = '00000000-0000-4000-8000-000000000001'
const destinationConfig = JSON.stringify([{ id: 'ops', name: 'Operations', address: 'ops@example.test' }])

type EmailMessage = { from: string; to: string; subject: string; text: string; html: string }
async function fixture(send?: (message: EmailMessage) => Promise<unknown>) {
  const local = new Database()
  for (const file of ['0001_board.sql', '0002_checks.sql', '0003_endpoint_registry.sql', '0005_gatus_sources.sql', '0006_advanced_http.sql', '0008_vault.sql', '0009_monitor_auth.sql', '0009_actions.sql', '0009_channels.sql', '0010_notification_transition_state.sql', '0010_monitor_alert_links.sql', '0011_email_channels.sql', '0012_notification_delivery_state.sql', '0013_notification_unlink_cancel.sql']) {
    local.sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'))
  }
  local.sqlite.prepare("INSERT INTO components (id,name,updated_at) VALUES ('component','Checkout <API>',0)").run()
  local.sqlite.prepare("INSERT INTO endpoint_registry VALUES ('check','approved')").run()
  local.sqlite.prepare("INSERT INTO http_checks (id,component_id,endpoint_id,enabled,interval_minutes,expected_status,last_status,last_scheduled_at) VALUES (?,'component','check',1,1,200,'up',1)").run(check)
  local.sqlite.prepare("INSERT INTO automation_transition_state (check_id,check_version,status) VALUES (?,1,'up')").run(check)
  const fingerprint = await emailChannelFingerprint('status@example.test', 'ops@example.test')
  local.sqlite.prepare(`INSERT INTO notification_channels (id,name,endpoint_id,endpoint_fingerprint,vault_id,secret_id,enabled,version,created_at,updated_at,channel_type,recipient_id,email_fingerprint)
    VALUES ('email','Operations','','',0,0,1,1,0,0,'email','ops',?)`).run(fingerprint)
  local.sqlite.prepare("INSERT INTO notification_channel_checks (channel_id,check_id) VALUES ('email',?)").run(check)
  const calls: EmailMessage[] = []
  const binding = { send: async (message: EmailMessage) => { calls.push(message); return send ? send(message) : { messageId: 'accepted' } } } as unknown as SendEmail
  const db = local as unknown as D1Database
  const env = { DB: db, CHANNELS_READY: 'true', EMAIL_READY: 'true', EMAIL_FROM: 'status@example.test', EMAIL_DESTINATIONS: destinationConfig, EMAIL: binding } satisfies ChannelEnvironment
  async function transition(scheduled: number, status: 'up' | 'down') {
    await db.batch([
      db.prepare('INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,effective_status,http_status,latency_ms) VALUES (?,1,?,?,?,?,?,1)').bind(check,scheduled,scheduled,status,status,status==='up'?200:500),
      enqueueTransition(db,check,1,'approved',scheduled,status),
      db.prepare('UPDATE http_checks SET last_status=?,last_scheduled_at=?,last_effective_status=?,last_effective_scheduled_at=? WHERE id=?').bind(status,scheduled,status,scheduled,check),
      db.prepare('UPDATE automation_transition_state SET status=?,generation=generation+1 WHERE check_id=?').bind(status,check),
    ])
  }
  return { local, db, env, calls, transition }
}

test('selected email channel receives one down event and one ordered recovery', async () => {
  const x = await fixture()
  await x.transition(100, 'down')
  await flushChannelDeliveries(x.env)
  await x.transition(200, 'up')
  await flushChannelDeliveries(x.env)
  await flushChannelDeliveries(x.env)
  assert.deepEqual(x.calls.map(message => message.subject), ['Monitor down: Checkout <API>', 'Monitor up: Checkout <API>'])
  assert.ok(x.calls.every(message => message.from === 'status@example.test' && message.to === 'ops@example.test'))
  assert.match(x.calls[0]!.html, /Checkout &lt;API&gt;/)
  assert.deepEqual(x.local.sqlite.prepare('SELECT state,attempts FROM notification_outbox ORDER BY scheduled_at').all().map(row => ({ ...row })), [{ state:'sent', attempts:1 }, { state:'sent', attempts:1 }])
})

test('disabled and unlinked email channels do not queue or send notifications', async () => {
  const disabled = await fixture()
  disabled.local.sqlite.prepare("UPDATE notification_channels SET enabled=0 WHERE id='email'").run()
  await disabled.transition(100, 'down')
  await flushChannelDeliveries(disabled.env)
  assert.equal(disabled.calls.length, 0)
  assert.equal((disabled.local.sqlite.prepare('SELECT count(*) AS n FROM notification_outbox').get() as {n:number}).n, 0)
  const unlinked = await fixture()
  unlinked.local.sqlite.prepare("DELETE FROM notification_channel_checks WHERE channel_id='email'").run()
  await unlinked.transition(100, 'down')
  await flushChannelDeliveries(unlinked.env)
  assert.equal(unlinked.calls.length, 0)
  assert.equal((unlinked.local.sqlite.prepare('SELECT count(*) AS n FROM notification_outbox').get() as {n:number}).n, 0)
})

test('changed approved sender or recipient fails closed without an email send', async () => {
  for (const override of [
    { EMAIL_FROM: 'changed@example.test' },
    { EMAIL_DESTINATIONS: JSON.stringify([{ id:'ops', name:'Operations', address:'changed@example.test' }]) },
  ]) {
    const x = await fixture()
    await x.transition(100, 'down')
    await flushChannelDeliveries({ ...x.env, ...override })
    assert.equal(x.calls.length, 0)
    assert.deepEqual({ ...x.local.sqlite.prepare('SELECT state,attempts,error_code FROM notification_outbox').get() }, { state:'failed', attempts:1, error_code:'unavailable' })
  }
})

test('email failure is not retried and an expired claim is never resent', async () => {
  const failed = await fixture(async () => { throw new Error('private provider details') })
  await failed.transition(100, 'down')
  await flushChannelDeliveries(failed.env)
  await flushChannelDeliveries(failed.env)
  assert.equal(failed.calls.length, 1)
  assert.deepEqual({ ...failed.local.sqlite.prepare('SELECT state,attempts,error_code FROM notification_outbox').get() }, { state:'failed', attempts:1, error_code:'delivery_failed' })
  const expired = await fixture()
  await expired.transition(100, 'down')
  expired.local.sqlite.prepare("UPDATE notification_outbox SET state='sending',attempts=1,lease_token='expired',lease_until=?").run(Date.now()-1)
  await flushChannelDeliveries(expired.env)
  assert.equal(expired.calls.length, 0)
  assert.deepEqual({ ...expired.local.sqlite.prepare('SELECT state,attempts,error_code FROM notification_outbox').get() }, { state:'failed', attempts:1, error_code:'delivery_failed' })
})

test('email jobs that expire after selection cannot be claimed', async () => {
  const x = await fixture(); await x.transition(100, 'down')
  const db = { prepare(sql: string) {
    if (sql.includes("WHERE o.id=? AND (o.state='pending' OR (o.state='sending' AND o.lease_until<?)) AND o.created_at<?"))
      x.local.sqlite.prepare('UPDATE notification_outbox SET created_at=?').run(Date.now()-3_600_001)
    return x.db.prepare(sql)
  }, batch: x.db.batch.bind(x.db) } as D1Database
  await flushChannelDeliveries({ ...x.env, DB: db })
  assert.equal(x.calls.length, 0)
  assert.deepEqual({ ...x.local.sqlite.prepare('SELECT state,attempts FROM notification_outbox').get() }, { state:'failed', attempts:0 })
})

test('email final preflight defers on a lost lease, an expired job, a slow read, or maintenance starting during the read', async () => {
  for (const reason of ['lease', 'age', 'slow', 'maintenance'] as const) {
    const x = await fixture(); await x.transition(100, 'down')
    const realNow = Date.now; let now = realNow()
    if (reason === 'maintenance') x.local.sqlite.prepare("INSERT INTO maintenance (id,name,starts_at,ends_at,created_at,updated_at) VALUES ('m','window',?,?,?,?)").run(now+1_000,now+60_000,now,now)
    try {
      Date.now = () => now
      const db = { prepare(sql: string) {
        if (!sql.includes('SELECT o.created_at AS createdAt,o.lease_until AS leaseUntil,')) return x.db.prepare(sql)
        if (reason === 'lease') x.local.sqlite.prepare("UPDATE notification_outbox SET lease_token='another-worker'").run()
        if (reason === 'age') x.local.sqlite.prepare('UPDATE notification_outbox SET created_at=?').run(now-3_600_001)
        const statement = x.db.prepare(sql)
        return { bind(...values: unknown[]) { statement.bind(...values); return this }, async first() {
          const result = await statement.first()
          if (reason === 'slow') now += 11_000
          if (reason === 'maintenance') now += 2_000
          return result
        } } as D1PreparedStatement
      }, batch: x.db.batch.bind(x.db) } as D1Database
      await flushChannelDeliveries({ ...x.env, DB: db })
      assert.equal(x.calls.length, 0, reason)
      const row = x.local.sqlite.prepare('SELECT state,attempts FROM notification_outbox').get()
      assert.deepEqual({ ...row }, reason === 'lease' ? { state:'sending', attempts:1 } : { state:'pending', attempts:0 }, reason)
      if (reason === 'age') {
        await flushChannelDeliveries(x.env)
        assert.equal((x.local.sqlite.prepare('SELECT state FROM notification_outbox').get() as {state:string}).state, 'failed')
      }
    } finally { Date.now = realNow }
  }
})

test('overlapping flushes claim an email delivery only once', async () => {
  let started!: () => void, finish!: () => void
  const sent = new Promise<void>(resolve => { started = resolve })
  const blocked = new Promise<void>(resolve => { finish = resolve })
  const x = await fixture(async () => { started(); await blocked; return { messageId:'accepted' } })
  await x.transition(100, 'down')
  const first = flushChannelDeliveries(x.env)
  await sent
  await flushChannelDeliveries(x.env)
  assert.equal(x.calls.length, 1)
  finish()
  await first
  assert.deepEqual({ ...x.local.sqlite.prepare('SELECT state,attempts,error_code FROM notification_outbox').get() }, { state:'sent', attempts:1, error_code:null })
})

test('Workerd D1 serializes concurrent email claims and persists the result', { skip: !process.env['USE_WORKERS_D1'] }, async () => {
  const { Miniflare, convertV4MiniflareOptions } = await import('miniflare')
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response()}}', d1Databases: ['DB'] }))
  try {
    const db = await runtime.getD1Database('DB') as D1Database
    for (const file of ['0001_board.sql', '0002_checks.sql', '0003_endpoint_registry.sql', '0005_gatus_sources.sql', '0006_advanced_http.sql', '0008_vault.sql', '0009_monitor_auth.sql', '0009_actions.sql', '0009_channels.sql', '0010_notification_transition_state.sql', '0010_monitor_alert_links.sql', '0011_email_channels.sql', '0012_notification_delivery_state.sql', '0013_notification_unlink_cancel.sql']) {
      const sql = readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8').replace(/^\s*--[^\n]*$/gm, '')
      const parts = sql.split(/(?=CREATE TRIGGER |DROP TRIGGER )/)
      const statements = parts.shift()!.split(';').map(value => value.trim()).filter(Boolean)
      statements.push(...parts.map(value => value.trim()).filter(Boolean))
      await db.batch(statements.map(statement => db.prepare(statement)))
    }
    const fingerprint = await emailChannelFingerprint('status@example.test', 'ops@example.test')
    await db.batch([
      db.prepare("INSERT INTO components (id,name,updated_at) VALUES ('component','Checkout',0)"),
      db.prepare("INSERT INTO endpoint_registry VALUES ('check','approved')"),
      db.prepare("INSERT INTO http_checks (id,component_id,endpoint_id,enabled,interval_minutes,expected_status,last_status,last_scheduled_at) VALUES (?,'component','check',1,1,200,'up',1)").bind(check),
      db.prepare("INSERT INTO automation_transition_state (check_id,check_version,status) VALUES (?,1,'up')").bind(check),
      db.prepare("INSERT INTO notification_channels (id,name,endpoint_id,endpoint_fingerprint,vault_id,secret_id,enabled,version,created_at,updated_at,channel_type,recipient_id,email_fingerprint) VALUES ('email','Operations','','',0,0,1,1,0,0,'email','ops',?)").bind(fingerprint),
      db.prepare("INSERT INTO notification_channel_checks (channel_id,check_id) VALUES ('email',?)").bind(check),
      db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,effective_status,http_status,latency_ms) VALUES (?,1,100,100,'down','down',500,1)").bind(check),
      enqueueTransition(db,check,1,'approved',100,'down'),
      db.prepare("UPDATE http_checks SET last_status='down',last_scheduled_at=100,last_effective_status='down',last_effective_scheduled_at=100 WHERE id=?").bind(check),
      db.prepare("UPDATE automation_transition_state SET status='down',generation=generation+1 WHERE check_id=?").bind(check),
    ])
    let calls = 0
    const binding = { send: async () => { calls++; return { messageId: 'accepted' } } } as unknown as SendEmail
    const env = { DB: db, CHANNELS_READY:'true', EMAIL_READY:'true', EMAIL_FROM:'status@example.test', EMAIL_DESTINATIONS:destinationConfig, EMAIL:binding } satisfies ChannelEnvironment
    await Promise.all([flushChannelDeliveries(env), flushChannelDeliveries(env)])
    assert.equal(calls, 1)
    const result = await db.prepare('SELECT state,attempts,error_code FROM notification_outbox').first<{state:string;attempts:number;error_code:string|null}>()
    assert.deepEqual(result, { state:'sent', attempts:1, error_code:null })
  } finally { await runtime.dispose() }
})

test('a failed outage email does not cause a misleading recovery message', async () => {
  const x = await fixture(async () => { throw new Error('provider unavailable') })
  await x.transition(100, 'down')
  await flushChannelDeliveries(x.env)
  await x.transition(200, 'up')
  await flushChannelDeliveries(x.env)
  assert.equal(x.calls.length, 1)
  assert.equal(x.calls[0]!.subject, 'Monitor down: Checkout <API>')
})


test('an outage and recovery before a flush send neither stale outage nor misleading recovery', async () => {
  const x = await fixture()
  await x.transition(100, 'down')
  await x.transition(200, 'up')
  await flushChannelDeliveries(x.env)
  assert.equal(x.calls.length, 0)
  assert.deepEqual(x.local.sqlite.prepare('SELECT state FROM notification_outbox ORDER BY scheduled_at').all().map(row => ({ ...row })), [{ state:'failed' }, { state:'failed' }])
})

test('a down-up-down cycle before a flush sends only the latest outage', async () => {
  const x = await fixture()
  await x.transition(100, 'down')
  await x.transition(200, 'up')
  await x.transition(300, 'down')
  await flushChannelDeliveries(x.env)
  await flushChannelDeliveries(x.env)
  assert.equal(x.calls.length, 1)
  assert.match(x.calls[0]!.text, /00:00:00.300Z/)
  assert.deepEqual(x.local.sqlite.prepare('SELECT state FROM notification_outbox ORDER BY scheduled_at').all().map(row => ({ ...row })), [{ state:'failed' }, { state:'failed' }, { state:'sent' }])
})

test('recovery waits for an in-flight outage delivery rather than being discarded', async () => {
  let started!: () => void, finish!: () => void
  const sent = new Promise<void>(resolve => { started = resolve })
  const blocked = new Promise<void>(resolve => { finish = resolve })
  const x = await fixture(async (message) => {
    if (message.subject.startsWith('Monitor down:')) { started(); await blocked }
    return { messageId:'accepted' }
  })
  await x.transition(100, 'down')
  const outage = flushChannelDeliveries(x.env)
  await sent
  await x.transition(200, 'up')
  await flushChannelDeliveries(x.env)
  finish()
  await outage
  await flushChannelDeliveries(x.env)
  assert.deepEqual(x.calls.map(message => message.subject), ['Monitor down: Checkout <API>', 'Monitor up: Checkout <API>'])
})

test('recovery is suppressed when an in-flight outage ultimately fails', async () => {
  let started!: () => void, finish!: () => void
  const sent = new Promise<void>(resolve => { started = resolve })
  const blocked = new Promise<void>(resolve => { finish = resolve })
  const x = await fixture(async (message) => {
    if (message.subject.startsWith('Monitor down:')) { started(); await blocked; throw new Error('provider unavailable') }
    return { messageId:'accepted' }
  })
  await x.transition(100, 'down')
  const outage = flushChannelDeliveries(x.env)
  await sent
  await x.transition(200, 'up')
  await flushChannelDeliveries(x.env)
  finish()
  await outage
  await flushChannelDeliveries(x.env)
  assert.deepEqual(x.calls.map(message => message.subject), ['Monitor down: Checkout <API>'])
  assert.deepEqual(x.local.sqlite.prepare('SELECT state FROM notification_outbox ORDER BY scheduled_at').all().map(row => ({ ...row })), [{ state:'failed' }, { state:'failed' }])
})


test('an in-flight outage followed by recovery and another outage sends no duplicate', async () => {
  let started!: () => void, finish!: () => void
  const sent = new Promise<void>(resolve => { started = resolve })
  const blocked = new Promise<void>(resolve => { finish = resolve })
  const x = await fixture(async (message) => {
    if (message.subject.startsWith('Monitor down:')) { started(); await blocked }
    return { messageId:'accepted' }
  })
  await x.transition(100, 'down')
  const outage = flushChannelDeliveries(x.env)
  await sent
  await x.transition(200, 'up')
  await x.transition(300, 'down')
  await flushChannelDeliveries(x.env)
  finish()
  await outage
  await flushChannelDeliveries(x.env)
  await flushChannelDeliveries(x.env)
  assert.deepEqual(x.calls.map(message => message.subject), ['Monitor down: Checkout <API>'])
  assert.deepEqual(x.local.sqlite.prepare('SELECT state FROM notification_outbox ORDER BY scheduled_at').all().map(row => ({ ...row })), [{ state:'sent' }, { state:'failed' }, { state:'failed' }])
})

test('unlinking and relinking after a claim cannot revive a stale email', async () => {
  const x = await fixture()
  await x.transition(100, 'down')
  let started!: () => void, resume!: () => void
  const preflightStarted = new Promise<void>(resolve => { started = resolve })
  const blocked = new Promise<void>(resolve => { resume = resolve })
  let intercepted = false
  const guardedDb = {
    prepare(sql: string) {
      const statement = x.db.prepare(sql)
      if (!intercepted && sql.includes('JOIN notification_channels c ON c.id=o.channel_id') && sql.includes("o.lease_token=?")) {
        intercepted = true
        return { bind(...values: unknown[]) {
          const bound = statement.bind(...values)
          return { async first() { started(); await blocked; return bound.first() } }
        } }
      }
      return statement
    },
    batch: x.db.batch.bind(x.db),
  } as unknown as D1Database
  const flush = flushChannelDeliveries({ ...x.env, DB: guardedDb })
  await preflightStarted
  assert.equal((x.local.sqlite.prepare('SELECT state FROM notification_outbox').get() as {state:string}).state, 'sending')
  x.local.sqlite.prepare("DELETE FROM notification_channel_checks WHERE channel_id='email' AND check_id=?").run(check)
  x.local.sqlite.prepare("INSERT INTO notification_channel_checks (channel_id,check_id) VALUES ('email',?)").run(check)
  resume()
  await flush
  await flushChannelDeliveries(x.env)
  assert.equal(x.calls.length, 0)
  assert.deepEqual({ ...x.local.sqlite.prepare('SELECT state,error_code FROM notification_outbox').get() }, { state:'failed', error_code:'unavailable' })
})

test('an email channel changed during final preflight never sends to its old recipient', async () => {
  const x=await fixture()
  await x.transition(100,'down')
  let started!:()=>void, resume!:()=>void
  const reached=new Promise<void>(resolve=>{started=resolve})
  const blocked=new Promise<void>(resolve=>{resume=resolve})
  let intercepted=false
  const guardedDb={
    prepare(sql:string) {
      const statement=x.db.prepare(sql)
      if (!intercepted && sql.includes('JOIN notification_channels c ON c.id=o.channel_id') && sql.includes('o.lease_token=?')) {
        intercepted=true
        return {bind(...values:unknown[]) {
          const bound=statement.bind(...values)
          return {async first() {started();await blocked;return bound.first()}}
        }}
      }
      return statement
    },
    batch:x.db.batch.bind(x.db),
  } as unknown as D1Database
  const flush=flushChannelDeliveries({...x.env,DB:guardedDb})
  await reached
  x.local.sqlite.prepare("UPDATE notification_channels SET version=version+1 WHERE id='email'").run()
  resume()
  await flush
  await flushChannelDeliveries(x.env)
  assert.equal(x.calls.length,0)
  assert.deepEqual({...x.local.sqlite.prepare('SELECT state,error_code FROM notification_outbox').get()},{state:'failed',error_code:'unavailable'})
})

test('a new recipient does not receive recovery for an outage acknowledged by the old recipient', async () => {
  const x = await fixture()
  const destinations = JSON.stringify([
    { id:'ops', name:'Operations', address:'ops@example.test' },
    { id:'other', name:'Other team', address:'other@example.test' },
  ])
  const env = { ...x.env, EMAIL_DESTINATIONS: destinations }
  await x.transition(100, 'down')
  await flushChannelDeliveries(env)
  assert.equal(x.calls.length, 1)
  assert.equal(x.calls[0]!.to, 'ops@example.test')
  const fingerprint = await emailChannelFingerprint('status@example.test', 'other@example.test')
  x.local.sqlite.prepare("UPDATE notification_channels SET recipient_id='other',email_fingerprint=?,version=2 WHERE id='email'").run(fingerprint)
  await x.transition(200, 'up')
  await flushChannelDeliveries(env)
  assert.equal(x.calls.length, 1)
  assert.deepEqual({ ...x.local.sqlite.prepare('SELECT state,channel_version FROM notification_outbox WHERE scheduled_at=200').get() }, { state:'failed', channel_version:2 })
})

test('an old in-flight email cannot acknowledge an outage for a changed channel version', async () => {
  let started!: () => void, finish!: () => void
  const sent = new Promise<void>(resolve => { started = resolve })
  const blocked = new Promise<void>(resolve => { finish = resolve })
  const x = await fixture(async () => { started(); await blocked; return { messageId:'accepted' } })
  const env = { ...x.env, EMAIL_DESTINATIONS: JSON.stringify([
    { id:'ops', name:'Operations', address:'ops@example.test' },
    { id:'other', name:'Other team', address:'other@example.test' },
  ]) }
  await x.transition(100, 'down')
  const sending = flushChannelDeliveries(env)
  await sent
  const fingerprint = await emailChannelFingerprint('status@example.test', 'other@example.test')
  x.local.sqlite.prepare("UPDATE notification_channels SET recipient_id='other',email_fingerprint=?,version=2 WHERE id='email'").run(fingerprint)
  finish()
  await sending
  assert.equal(x.calls.length, 1)
  assert.equal(x.calls[0]!.to, 'ops@example.test')
  assert.equal(x.local.sqlite.prepare('SELECT channel_version FROM notification_delivery_state').get(), undefined)
  await x.transition(200, 'up')
  await flushChannelDeliveries(env)
  assert.equal(x.calls.length, 1)
})
