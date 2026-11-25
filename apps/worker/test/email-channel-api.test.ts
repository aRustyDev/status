import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { channelApi, ChannelError } from '../src/channels.ts'
import type { ChannelEnvironment } from '../src/channels-runtime.ts'

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
    try { const results = statements.map(item => item.runSync()); this.db.exec('COMMIT'); return results }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
}
const actor = { id:'admin', email:'admin@example.test', version:1 }
const request = (method: string, input?: unknown) => new Request('https://status.example.test', { method, headers: { 'content-type':'application/json' }, ...(input === undefined ? {} : { body:JSON.stringify(input) }) })
const checkA = '00000000-0000-4000-8000-000000000001'
const checkB = '00000000-0000-4000-8000-000000000002'
function setup(applyLimit = true) {
  const local = new DB()
  for (const file of ['0001_board.sql','0002_checks.sql','0003_endpoint_registry.sql','0005_gatus_sources.sql','0006_advanced_http.sql','0008_vault.sql','0009_monitor_auth.sql','0009_channels.sql','0010_monitor_alert_links.sql','0011_email_channels.sql','0012_notification_delivery_state.sql','0013_notification_unlink_cancel.sql']) local.db.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'))
  if (applyLimit) local.db.exec(readFileSync(new URL('../migrations/0014_monitor_alert_channel_limit.sql',import.meta.url),'utf8'))
  local.db.exec("INSERT INTO users (id,issuer,subject,email,role) VALUES ('admin','issuer','subject','admin@example.test','admin')")
  local.db.exec("INSERT INTO components (id,name,updated_at) VALUES ('component-a','A',0),('component-b','B',0),('manual','Manual',0)")
  local.db.prepare("INSERT INTO http_checks (id,component_id,endpoint_id,enabled,interval_minutes,expected_status) VALUES (?,'component-a','check',1,1,200)").run(checkA)
  local.db.prepare("INSERT INTO http_checks (id,component_id,endpoint_id,enabled,interval_minutes,expected_status) VALUES (?,'component-b','check',1,1,200)").run(checkB)
  const env = { DB:local as unknown as D1Database, CHANNELS_READY:'true', EMAIL_READY:'true', EMAIL_FROM:'alerts@example.test', EMAIL_DESTINATIONS:JSON.stringify([{id:'ops',name:'Operations',address:'ops@example.test'}]), EMAIL:{ send:async () => ({messageId:'test'}) } } as unknown as ChannelEnvironment
  return {local, env}
}

test('migration preserves oversized channels and lets admins rename and reduce them', async () => {
  const {local,env}=setup(false)
  const payload={name:'Oversized',type:'email',recipientId:'ops',enabled:true,checkIds:[],expectedChecks:[]}
  const created=await (await channelApi(request('POST',payload),env,actor,'/admin/notifications/channels')).json() as {id:string;version:number}
  const checks=Array.from({length:21},()=>({id:crypto.randomUUID(),componentId:crypto.randomUUID(),version:1}))
  for (const [index,check] of checks.entries()) {
    local.db.prepare('INSERT INTO components (id,name,updated_at) VALUES (?,?,0)').run(check.componentId,`Oversized ${index}`)
    local.db.prepare("INSERT INTO http_checks (id,component_id,endpoint_id,enabled,interval_minutes,expected_status) VALUES (?,?,'check',0,1,200)").run(check.id,check.componentId)
    local.db.prepare('INSERT INTO monitor_notification_channels (component_id,channel_id) VALUES (?,?)').run(check.componentId,created.id)
  }
  local.db.exec(readFileSync(new URL('../migrations/0014_monitor_alert_channel_limit.sql',import.meta.url),'utf8'))
  const ids=checks.map(check=>check.id)
  const renamed=await channelApi(request('PATCH',{...payload,name:'Renamed oversized',checkIds:ids,expectedChecks:checks,version:1,expectedCheckIds:ids,expectedAssociationVersion:21}),env,actor,`/admin/notifications/channels/${created.id}`)
  assert.equal(renamed.status,200)
  const state=await renamed.json() as {version:number;associationVersion:number}
  assert.equal(state.version,2)
  const reduced=await channelApi(request('PATCH',{...payload,name:'Renamed oversized',checkIds:ids.slice(0,20),expectedChecks:checks.slice(0,20),version:state.version,expectedCheckIds:ids,expectedAssociationVersion:state.associationVersion}),env,actor,`/admin/notifications/channels/${created.id}`)
  assert.equal(reduced.status,200)
  assert.equal((local.db.prepare('SELECT COUNT(*) AS n FROM monitor_notification_channels WHERE channel_id=?').get(created.id) as {n:number}).n,20)
})

test('email channel tests reject a changed or deleted channel before sending', async () => {
  for (const change of ['retarget', 'delete'] as const) {
    const {local, env} = setup()
    const payload = {name:'Test email', type:'email', recipientId:'ops', enabled:true, checkIds:[], expectedChecks:[]}
    const created = await (await channelApi(request('POST',payload),env,actor,'/admin/notifications/channels')).json() as {id:string;version:number}
    let sends = 0, changed = false
    const db = {
      prepare(sql:string) {
        const statement = local.prepare(sql)
        if (sql !== 'SELECT 1 FROM notification_channels WHERE id=? AND version=?') return statement
        return {
          bind(...values:unknown[]) { statement.bind(...values); return this },
          async first<T>() {
            const result = await statement.first<T>()
            if (!changed) {
              changed = true
              if (change === 'delete') local.db.prepare('DELETE FROM notification_channels WHERE id=?').run(created.id)
              else local.db.prepare("UPDATE notification_channels SET recipient_id='new',version=version+1 WHERE id=?").run(created.id)
            }
            return result
          },
        }
      },
      batch: local.batch.bind(local),
    } as unknown as D1Database
    const testEnv = {...env, DB:db, EMAIL:{send:async () => { sends++; return {messageId:'accepted'} }} as SendEmail}
    await assert.rejects(channelApi(request('POST',{version:created.version}),testEnv,actor,`/admin/notifications/channels/${created.id}/test`), (error:unknown) => error instanceof ChannelError && error.status === 409)
    assert.equal(changed,true)
    assert.equal(sends,0,change)
  }
})

test('an unchanged disabled email channel can still send a manual test', async () => {
  const {env} = setup()
  let sends = 0
  const testEnv = {...env, EMAIL:{send:async () => { sends++; return {messageId:'accepted'} }} as SendEmail}
  const created = await (await channelApi(request('POST',{name:'Disabled',type:'email',recipientId:'ops',enabled:false,checkIds:[],expectedChecks:[]}),testEnv,actor,'/admin/notifications/channels')).json() as {id:string;version:number}
  const response = await channelApi(request('POST',{version:created.version}),testEnv,actor,`/admin/notifications/channels/${created.id}/test`)
  assert.equal(response.status,200)
  assert.equal(sends,1)
})

test('email channels accept only approved recipients and preserve check links on stale writes', async () => {
  const {local, env} = setup()
  const destinations = await (await channelApi(request('GET'),env,actor,'/admin/notifications/email-destinations')).json()
  assert.deepEqual(destinations,[{id:'ops',name:'Operations'}])
  const payload = { name:'Operations email',type:'email',recipientId:'ops',enabled:true,checkIds:[checkA],expectedChecks:[{id:checkA,componentId:'component-a',version:1}] }
  await assert.rejects(channelApi(request('POST',{...payload,recipientId:'arbitrary@example.test'}),env,actor,'/admin/notifications/channels'),(error:unknown)=>error instanceof ChannelError && error.status===400)
  await assert.rejects(channelApi(request('POST',{...payload,secretId:1}),env,actor,'/admin/notifications/channels'),(error:unknown)=>error instanceof ChannelError && error.status===400)
  const result = await channelApi(request('POST',payload),env,actor,'/admin/notifications/channels')
  assert.equal(result.status,201)
  const created = await result.json() as {id:string;type:string;recipientId:string;version:number;associationVersion:number;checkIds:string[]}
  assert.equal(created.type,'email'); assert.equal(created.recipientId,'ops'); assert.deepEqual(created.checkIds,[checkA])
  assert.doesNotMatch(JSON.stringify(created),/ops@example|vaultId|secretId|endpointId/)
  // A monitor editor attaches a second check and a manual monitor after the editor loads.
  local.db.prepare('INSERT INTO monitor_notification_channels (component_id,channel_id) VALUES (?,?)').run('component-b',created.id)
  local.db.prepare('INSERT INTO monitor_notification_channels (component_id,channel_id) VALUES (?,?)').run('manual',created.id)
  await assert.rejects(channelApi(request('PATCH',{...payload,version:created.version,expectedCheckIds:[checkA],expectedAssociationVersion:created.associationVersion}),env,actor,`/admin/notifications/channels/${created.id}`),(error:unknown)=>error instanceof ChannelError && error.status===409)
  assert.equal((local.db.prepare('SELECT COUNT(*) AS n FROM notification_channel_checks WHERE channel_id=?').get(created.id) as {n:number}).n,2)
  const saved = await channelApi(request('PATCH',{...payload,checkIds:[checkA,checkB],expectedChecks:[{id:checkA,componentId:'component-a',version:1},{id:checkB,componentId:'component-b',version:1}],version:created.version,expectedCheckIds:[checkA,checkB],expectedAssociationVersion:created.associationVersion+2}),env,actor,`/admin/notifications/channels/${created.id}`)
  assert.equal(saved.status,200)
  assert.ok(local.db.prepare('SELECT 1 FROM monitor_notification_channels WHERE component_id=? AND channel_id=?').get('manual',created.id))
  await assert.rejects(channelApi(request('POST',payload),{...env,EMAIL_READY:'false'},actor,'/admin/notifications/channels'),(error:unknown)=>error instanceof ChannelError && error.status===503)
})


test('moving a check preserves both monitors’ own channel selections', async () => {
  const {local,env}=setup()
  const a=await (await channelApi(request('POST',{name:'Email A',type:'email',recipientId:'ops',enabled:true,checkIds:[checkA],expectedChecks:[{id:checkA,componentId:'component-a',version:1}]}),env,actor,'/admin/notifications/channels')).json() as {id:string}
  const b=await (await channelApi(request('POST',{name:'Email B',type:'email',recipientId:'ops',enabled:true,checkIds:[],expectedChecks:[]}),env,actor,'/admin/notifications/channels')).json() as {id:string}
  local.db.prepare('INSERT INTO monitor_notification_channels (component_id,channel_id) VALUES (?,?)').run('manual',b.id)
  local.db.prepare('UPDATE http_checks SET component_id=? WHERE id=?').run('manual',checkA)
  assert.ok(local.db.prepare('SELECT 1 FROM monitor_notification_channels WHERE component_id=? AND channel_id=?').get('component-a',a.id))
  assert.ok(local.db.prepare('SELECT 1 FROM monitor_notification_channels WHERE component_id=? AND channel_id=?').get('manual',b.id))
  assert.equal(local.db.prepare('SELECT 1 FROM notification_channel_checks WHERE check_id=? AND channel_id=?').get(checkA,a.id),undefined)
  assert.ok(local.db.prepare('SELECT 1 FROM notification_channel_checks WHERE check_id=? AND channel_id=?').get(checkA,b.id))
  assert.equal((local.db.prepare('SELECT COUNT(*) AS n FROM monitor_alert_check_moves').get() as {n:number}).n,0)
})

test('existing check links backfill to monitor links and Gatus remains protected', () => {
  const local = new DB()
  for (const file of ['0001_board.sql','0002_checks.sql','0003_endpoint_registry.sql','0005_gatus_sources.sql','0006_advanced_http.sql','0008_vault.sql','0009_monitor_auth.sql','0009_channels.sql']) local.db.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'))
  local.db.exec("INSERT INTO components (id,name,updated_at) VALUES ('native','Native',0),('gatus','Gatus',0)")
  local.db.prepare("INSERT INTO http_checks (id,component_id,endpoint_id,enabled,interval_minutes,expected_status) VALUES (?,'native','check',1,1,200)").run(checkA)
  local.db.exec("INSERT INTO notification_channels (id,name,endpoint_id,endpoint_fingerprint,vault_id,secret_id,created_at,updated_at) VALUES ('channel','Channel','sink','hash',1,1,0,0)")
  local.db.prepare('INSERT INTO notification_channel_checks (channel_id,check_id) VALUES (?,?)').run('channel',checkA)
  local.db.exec(readFileSync(new URL('../migrations/0010_monitor_alert_links.sql',import.meta.url),'utf8'))
  assert.ok(local.db.prepare('SELECT 1 FROM monitor_notification_channels WHERE component_id=? AND channel_id=?').get('native','channel'))
  local.db.exec("INSERT INTO gatus_sources (source_id,component_id,kind,source_key,source_name,stale_after_seconds) VALUES ('source','gatus','endpoint','gatus','Gatus',60)")
  assert.throws(()=>local.db.prepare('INSERT INTO monitor_notification_channels (component_id,channel_id) VALUES (?,?)').run('gatus','channel'),/read-only/i)
})


test('unchanged channel links preserve queued jobs; unlinking permanently cancels them', async () => {
  const {local,env}=setup()
  const payload={name:'Queued email',type:'email',recipientId:'ops',enabled:true,checkIds:[checkA],expectedChecks:[{id:checkA,componentId:'component-a',version:1}]}
  const channel=await (await channelApi(request('POST',payload),env,actor,'/admin/notifications/channels')).json() as {id:string;version:number;associationVersion:number}
  const insert=local.db.prepare(`INSERT INTO notification_outbox (id,channel_id,channel_version,check_id,check_version,scheduled_at,status,state,lease_token,lease_until,created_at,updated_at) VALUES (?,?,?,?,?,?,?, ?,?,?,?,?)`)
  insert.run('pending',channel.id,channel.version,checkA,1,100,'down','pending',null,null,100,100)
  insert.run('sending',channel.id,channel.version,checkA,1,101,'up','sending','lease',9999999999999,101,101)
  local.db.prepare("INSERT INTO notification_delivery_state (channel_id,check_id,check_version,channel_version,status) VALUES (?,?,1,?,'down')").run(channel.id,checkA,channel.version)
  const unchanged=await channelApi(request('PATCH',{...payload,version:channel.version,expectedCheckIds:[checkA],expectedAssociationVersion:channel.associationVersion}),env,actor,`/admin/notifications/channels/${channel.id}`)
  assert.equal((await unchanged.json() as {version:number}).version,channel.version)
  assert.deepEqual(local.db.prepare('SELECT state,lease_token FROM notification_outbox ORDER BY id').all().map(row=>({...row})),[{state:'pending',lease_token:null},{state:'sending',lease_token:'lease'}])
  local.db.prepare('DELETE FROM monitor_notification_channels WHERE component_id=? AND channel_id=?').run('component-a',channel.id)
  local.db.prepare('INSERT INTO monitor_notification_channels (component_id,channel_id) VALUES (?,?)').run('component-a',channel.id)
  assert.equal(local.db.prepare('SELECT 1 FROM notification_delivery_state WHERE channel_id=? AND check_id=?').get(channel.id,checkA),undefined)
  assert.deepEqual(local.db.prepare('SELECT state,error_code,lease_token,lease_until FROM notification_outbox ORDER BY id').all().map(row=>({...row})),[
    {state:'failed',error_code:'unavailable',lease_token:null,lease_until:null},
    {state:'failed',error_code:'unavailable',lease_token:null,lease_until:null},
  ])
})


test('channel deletion rejects stale monitor association snapshots, including manual monitors', async () => {
  const {local,env}=setup()
  const channel=await (await channelApi(request('POST',{name:'Manual guard',type:'email',recipientId:'ops',enabled:true,checkIds:[],expectedChecks:[]}),env,actor,'/admin/notifications/channels')).json() as {id:string;version:number;associationVersion:number}
  local.db.prepare('INSERT INTO monitor_notification_channels (component_id,channel_id) VALUES (?,?)').run('manual',channel.id)
  await assert.rejects(channelApi(request('DELETE',{version:channel.version,expectedAssociationVersion:channel.associationVersion}),env,actor,`/admin/notifications/channels/${channel.id}`),(error:unknown)=>error instanceof ChannelError && error.status===409)
  assert.ok(local.db.prepare('SELECT 1 FROM notification_channels WHERE id=?').get(channel.id))
  const removed=await channelApi(request('DELETE',{version:channel.version,expectedAssociationVersion:channel.associationVersion+1}),env,actor,`/admin/notifications/channels/${channel.id}`)
  assert.equal(removed.status,200)
})


test('channel saves reject a check moved after its catalog snapshot', async () => {
  const {local,env}=setup()
  const initial={name:'Stale snapshot',type:'email',recipientId:'ops',enabled:true,checkIds:[],expectedChecks:[]}
  const channel=await (await channelApi(request('POST',initial),env,actor,'/admin/notifications/channels')).json() as {id:string;version:number;associationVersion:number}
  const stale={...initial,checkIds:[checkA],expectedChecks:[{id:checkA,componentId:'component-a',version:1}]}
  local.db.prepare('UPDATE http_checks SET component_id=?,config_version=config_version+1 WHERE id=?').run('manual',checkA)
  await assert.rejects(channelApi(request('POST',stale),env,actor,'/admin/notifications/channels'),(error:unknown)=>error instanceof ChannelError && error.status===409)
  await assert.rejects(channelApi(request('PATCH',{...stale,version:channel.version,expectedCheckIds:[],expectedAssociationVersion:channel.associationVersion}),env,actor,`/admin/notifications/channels/${channel.id}`),(error:unknown)=>error instanceof ChannelError && error.status===409)
  assert.equal((local.db.prepare('SELECT COUNT(*) AS n FROM monitor_notification_channels WHERE channel_id=?').get(channel.id) as {n:number}).n,0)
})

test('a name-only channel edit preserves only still-linked current queued jobs', async () => {
  const {local,env}=setup()
  const snapshots=[{id:checkA,componentId:'component-a',version:1},{id:checkB,componentId:'component-b',version:1}]
  const payload={name:'Original name',type:'email',recipientId:'ops',enabled:true,checkIds:[checkA,checkB],expectedChecks:snapshots}
  const channel=await (await channelApi(request('POST',payload),env,actor,'/admin/notifications/channels')).json() as {id:string;version:number;associationVersion:number}
  const insert=local.db.prepare(`INSERT INTO notification_outbox (id,channel_id,channel_version,check_id,check_version,scheduled_at,status,state,lease_token,lease_until,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
  insert.run('keep-pending',channel.id,channel.version,checkA,1,100,'down','pending',null,null,100,100)
  insert.run('keep-sending',channel.id,channel.version,checkA,1,101,'down','sending','active',9999999999999,101,101)
  insert.run('removed',channel.id,channel.version,checkB,1,100,'down','pending',null,null,100,100)
  insert.run('older',channel.id,0,checkA,1,102,'down','pending',null,null,102,102)
  insert.run('sent',channel.id,channel.version,checkA,1,103,'down','sent',null,null,103,103)
  const delivery=local.db.prepare("INSERT INTO notification_delivery_state (channel_id,check_id,check_version,channel_version,status) VALUES (?,?,1,?,'down')")
  delivery.run(channel.id,checkA,channel.version)
  delivery.run(channel.id,checkB,channel.version)
  const edited=await channelApi(request('PATCH',{...payload,name:'Renamed',checkIds:[checkA],expectedChecks:[snapshots[0]],version:channel.version,expectedCheckIds:[checkA,checkB],expectedAssociationVersion:channel.associationVersion}),env,actor,`/admin/notifications/channels/${channel.id}`)
  const after=await edited.json() as {version:number;associationVersion:number}
  assert.equal(after.version,channel.version+1)
  assert.deepEqual(local.db.prepare('SELECT check_id,channel_version FROM notification_delivery_state WHERE channel_id=?').all(channel.id).map(row=>({...row})),[{check_id:checkA,channel_version:after.version}])
  const jobs=local.db.prepare('SELECT id,state,channel_version,lease_token FROM notification_outbox ORDER BY id').all().map(row=>({...row}))
  assert.deepEqual(jobs,[
    {id:'keep-pending',state:'pending',channel_version:after.version,lease_token:null},
    {id:'keep-sending',state:'sending',channel_version:after.version,lease_token:'active'},
    {id:'older',state:'pending',channel_version:0,lease_token:null},
    {id:'removed',state:'failed',channel_version:after.version,lease_token:null},
    {id:'sent',state:'sent',channel_version:channel.version,lease_token:null},
  ])
  const changedEnv={...env,EMAIL_DESTINATIONS:JSON.stringify([{id:'ops',name:'Operations',address:'ops@example.test'},{id:'backup',name:'Backup',address:'backup@example.test'}])}
  const changed=await channelApi(request('PATCH',{...payload,name:'Renamed',recipientId:'backup',checkIds:[checkA],expectedChecks:[snapshots[0]],version:after.version,expectedCheckIds:[checkA],expectedAssociationVersion:after.associationVersion}),changedEnv,actor,`/admin/notifications/channels/${channel.id}`)
  assert.equal((await changed.json() as {version:number}).version,after.version+1)
  assert.equal((local.db.prepare('SELECT channel_version FROM notification_outbox WHERE id=?').get('keep-pending') as {channel_version:number}).channel_version,after.version)
  assert.equal((local.db.prepare('SELECT channel_version FROM notification_delivery_state WHERE channel_id=? AND check_id=?').get(channel.id,checkA) as {channel_version:number}).channel_version,after.version)
})
