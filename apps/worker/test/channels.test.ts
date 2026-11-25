import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { vaultApi } from '../src/vault.ts'
import { channelApi, ChannelError } from '../src/channels.ts'
import { enqueueTransition, flushChannelDeliveries, sendChannel, type ChannelEnvironment } from '../src/channels-runtime.ts'

class Statement {
  private values:unknown[]=[]
  constructor(private sql:string, private db:DatabaseSync) {}
  bind(...values:unknown[]) { this.values=values; return this }
  runSync() { const result=this.db.prepare(this.sql).run(...this.values as never[]); return {success:true,meta:{changes:Number(result.changes)}} }
  async run() { return this.runSync() }
  async first<T>() { return (this.db.prepare(this.sql).get(...this.values as never[]) ?? null) as T | null }
  async all<T>() { return {results:this.db.prepare(this.sql).all(...this.values as never[]) as T[]} }
}
class DB {
  db=new DatabaseSync(':memory:')
  prepare(sql:string) { return new Statement(sql,this.db) }
  async batch(statements:Statement[]) { this.db.exec('BEGIN'); try {const result=statements.map(s=>s.runSync()); this.db.exec('COMMIT'); return result} catch(e) {this.db.exec('ROLLBACK'); throw e} }
}
const actor={id:'admin',email:'admin@example.test',version:1}
const key='aa'.repeat(32)
const checkId='00000000-0000-4000-8000-000000000001'
const endpointId='outbound'
const destinations=JSON.stringify([{id:endpointId,name:'Approved webhook',url:'https://webhook.example.test/hook',binding:'OUTBOUND',serviceId:'test'}])
const request=(method:string,body?:unknown)=>new Request('https://status.example.test', {method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})})

async function setup() {
  const local=new DB()
  for (const file of ['0001_board.sql','0002_checks.sql','0003_endpoint_registry.sql','0005_gatus_sources.sql','0006_advanced_http.sql','0008_vault.sql','0009_monitor_auth.sql','0009_channels.sql','0009_actions.sql','0010_monitor_alert_links.sql','0010_notification_transition_state.sql','0011_email_channels.sql','0012_notification_delivery_state.sql','0013_notification_unlink_cancel.sql']) local.db.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'))
  local.db.prepare("INSERT INTO users (id,issuer,subject,email,role) VALUES ('admin','issuer','subject','admin@example.test','admin')").run()
  local.db.prepare("INSERT INTO components (id,name,updated_at) VALUES ('component','Test monitor',0)").run()
  local.db.prepare("INSERT INTO endpoint_registry VALUES ('check','approved')").run()
  local.db.prepare("INSERT INTO http_checks (id,component_id,endpoint_id,enabled,interval_minutes,expected_status,last_status,last_scheduled_at) VALUES (?,'component','check',1,1,200,'up',1)").run(checkId)
  local.db.prepare("INSERT INTO automation_transition_state (check_id,check_version,status) VALUES (?,1,'up')").run(checkId)
  const db=local as unknown as D1Database
  const calls:{url:string;init:RequestInit}[]=[]
  let status=200
  const env={ DB:db, CHANNEL_ENDPOINTS:destinations, CHANNELS_READY:'true', VAULT_ENCRYPTION_KEY:key, OUTBOUND:{fetch:async (url:string,init:RequestInit)=>{calls.push({url,init});return new Response('private response body',{status})}} } satisfies ChannelEnvironment
  const vault=await (await vaultApi(request('POST',{name:'fixtures'}),db,key,actor,'/admin/vaults')).json() as {id:number}
  const secret=await (await vaultApi(request('POST',{name:'token',type:'value',value:'fixture-token-one'}),db,key,actor,`/admin/vaults/${vault.id}/secrets`)).json() as {id:number;version:number}
  const channelBody={name:'Fixture',endpointId,vaultId:vault.id,secretId:secret.id,enabled:true,checkIds:[checkId],expectedChecks:[{id:checkId,componentId:'component',version:1}]}
  const created=await channelApi(request('POST',channelBody),env,actor,'/admin/notifications/channels')
  assert.equal(created.status,201)
  const channel=await created.json() as {id:string;version:number}
  return {local,db,env,calls,vault,secret,channel,channelBody,setStatus:(value:number)=>{status=value}}
}

test('channel configuration and test use only persisted credentials and approved HTTPS destinations',async()=>{
  const x=await setup()
  const all=await (await channelApi(request('GET'),x.env,actor,'/admin/notifications/channels')).json()
  assert.doesNotMatch(JSON.stringify(all),/fixture-token-one|private response body/)
  const test=await channelApi(request('POST',{version:1}),x.env,actor,`/admin/notifications/channels/${x.channel.id}/test`)
  assert.deepEqual(await test.json(),{ok:true})
  assert.equal(x.calls.length,1)
  assert.equal((x.calls[0]!.init.headers as Record<string,string>).Authorization,'Bearer fixture-token-one')
  assert.equal(x.calls[0]!.init.redirect,'manual')
  assert.doesNotMatch(String(x.calls[0]!.init.body),/fixture-token/)
  await assert.rejects(channelApi(request('POST',{...x.channelBody,name:'invalid',endpointId:'other'}),x.env,actor,'/admin/notifications/channels'),(e:unknown)=>e instanceof ChannelError && e.status===400)
  await assert.rejects(channelApi(request('POST',{version:2}),x.env,actor,`/admin/notifications/channels/${x.channel.id}/test`),(e:unknown)=>e instanceof ChannelError && e.status===409)
  assert.equal(await sendChannel({...x.env,CHANNEL_ENDPOINTS:destinations.replace('/hook','/changed')},x.channel.id,1,{},false),'unavailable')
  assert.equal(await sendChannel({...x.env,CHANNEL_ENDPOINTS:destinations.replace('https:','http:')},x.channel.id,1,{},false),'unavailable')
  const audit=x.local.db.prepare("SELECT details FROM audit_events WHERE entity_type='notification_channel'").all()
  assert.doesNotMatch(JSON.stringify(audit),/fixture-token|private response body/)
})

test('status transition outbox is atomic and concurrent flushes claim only one delivery',async()=>{
  const x=await setup()
  const result=x.db.prepare(`INSERT OR IGNORE INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,http_status,latency_ms) VALUES (?,1,100,100,'down',500,4)`).bind(checkId)
  await x.db.batch([result,enqueueTransition(x.db,checkId,1,'approved',100,'down'),x.db.prepare("UPDATE http_checks SET last_status='down',last_scheduled_at=100 WHERE id=?").bind(checkId)])
  await x.db.batch([result,enqueueTransition(x.db,checkId,1,'approved',100,'down')])
  x.local.db.prepare("UPDATE automation_transition_state SET status='down',generation=1 WHERE check_id=?").run(checkId)
  assert.equal((x.local.db.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get() as {n:number}).n,1)
  await Promise.all([flushChannelDeliveries(x.env),flushChannelDeliveries(x.env)])
  assert.equal(x.calls.length,1)
  const row=x.local.db.prepare('SELECT state,attempts,error_code FROM notification_outbox').get() as {state:string;attempts:number;error_code:string|null}
  assert.deepEqual({...row},{state:'sent',attempts:1,error_code:null})
  assert.doesNotMatch(JSON.stringify(x.local.db.prepare('SELECT * FROM notification_outbox').all()),/fixture-token/)
})

test('unavailable email jobs do not starve later ready webhook jobs',async()=>{
  const x=await setup()
  const now=Date.now()
  for(let i=0;i<2;i++) {
    const component=`email-component-${i}`, check=`email-check-${i}`
    x.local.db.prepare('INSERT INTO components (id,name,updated_at) VALUES (?,?,?)').run(component,component,now)
    x.local.db.prepare("INSERT INTO http_checks (id,component_id,endpoint_id,enabled,interval_minutes,expected_status,last_status,last_scheduled_at) VALUES (?,?,'check',1,1,200,'down',10)").run(check,component)
    x.local.db.prepare("INSERT INTO automation_transition_state (check_id,check_version,status) VALUES (?,1,'down')").run(check)
    for(let j=0;j<10;j++) {
      const channel=`email-${j}`
      x.local.db.prepare("INSERT OR IGNORE INTO notification_channels (id,name,endpoint_id,endpoint_fingerprint,vault_id,secret_id,enabled,created_at,updated_at,channel_type,recipient_id,email_fingerprint) VALUES (?,?,'','',0,0,1,?,?,'email','ops','fingerprint')").run(channel,channel,now,now)
      x.local.db.prepare('INSERT INTO notification_channel_checks (channel_id,check_id) VALUES (?,?)').run(channel,check)
      x.local.db.prepare("INSERT INTO notification_outbox (id,channel_id,channel_version,check_id,check_version,scheduled_at,status,created_at,updated_at,observed_at) VALUES (?,?,1,?,1,10,'down',?,?,10)").run(`email-job-${i}-${j}`,channel,check,now,now)
    }
  }
  await queueTimingEvent(x)
  await flushChannelDeliveries(x.env)
  assert.equal(x.calls.length,1)
  assert.equal((x.local.db.prepare("SELECT state FROM notification_outbox WHERE channel_id=?").get(x.channel.id) as {state:string}).state,'sent')
  assert.equal((x.local.db.prepare("SELECT count(*) AS n FROM notification_outbox WHERE channel_id LIKE 'email-%' AND state='pending' AND attempts=0").get() as {n:number}).n,20)
})

test('rotations take effect, missing credentials fail closed, and delivery errors remain generic',async()=>{
  const x=await setup()
  await vaultApi(request('PATCH',{version:1,value:'fixture-token-two'}),x.db,key,actor,`/admin/vaults/${x.vault.id}/secrets/${x.secret.id}`)
  assert.equal(await sendChannel(x.env,x.channel.id,1,{},false),'sent')
  assert.equal((x.calls[0]!.init.headers as Record<string,string>).Authorization,'Bearer fixture-token-two')
  x.setStatus(302)
  assert.equal(await sendChannel(x.env,x.channel.id,1,{},false),'delivery_failed')
  await vaultApi(request('DELETE',{version:2}),x.db,key,actor,`/admin/vaults/${x.vault.id}/secrets/${x.secret.id}`)
  assert.equal(await sendChannel(x.env,x.channel.id,1,{},false),'unavailable')
  assert.equal(x.calls.length,2)
  const bad=await channelApi(request('POST',{version:1}),x.env,actor,`/admin/notifications/channels/${x.channel.id}/test`).catch(e=>e)
  assert.ok(bad instanceof ChannelError)
  assert.doesNotMatch(String(bad),/fixture-token|private response body/)
})

test('stale monitor or channel versions and disabled readiness never emit queued credentials',async()=>{
  const x=await setup()
  const result=x.db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,http_status,latency_ms) VALUES (?,1,100,100,'down',500,4)").bind(checkId)
  await x.db.batch([result,enqueueTransition(x.db,checkId,1,'approved',100,'down')])
  await flushChannelDeliveries({...x.env,CHANNELS_READY:'false'})
  assert.equal(x.calls.length,0)
  x.local.db.prepare('UPDATE http_checks SET config_version=2 WHERE id=?').run(checkId)
  await flushChannelDeliveries(x.env)
  assert.equal(x.calls.length,0)
  assert.equal((x.local.db.prepare('SELECT error_code FROM notification_outbox').get() as {error_code:string}).error_code,'unavailable')
  await assert.rejects(channelApi(request('GET'),{...x.env,CHANNELS_READY:'false'},actor,'/admin/notifications/channels'),(e:unknown)=>e instanceof ChannelError && e.status===503)
  assert.equal(await sendChannel(x.env,x.channel.id,2,{},false),'unavailable')
})

test('failed deliveries retry within a bound and record only generic errors',async()=>{
  const x=await setup(); x.setStatus(500)
  const result=x.db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,http_status,latency_ms) VALUES (?,1,100,100,'down',500,4)").bind(checkId)
  await x.db.batch([result,enqueueTransition(x.db,checkId,1,'approved',100,'down')])
  x.local.db.prepare("UPDATE automation_transition_state SET status='down',generation=1 WHERE check_id=?").run(checkId)
  await flushChannelDeliveries(x.env); await flushChannelDeliveries(x.env); await flushChannelDeliveries(x.env); await flushChannelDeliveries(x.env)
  assert.equal(x.calls.length,3)
  const row=x.local.db.prepare('SELECT state,attempts,error_code FROM notification_outbox').get() as {state:string;attempts:number;error_code:string}
  assert.deepEqual({...row},{state:'failed',attempts:3,error_code:'delivery_failed'})
  assert.doesNotMatch(JSON.stringify(row),/fixture-token|private response body/)
})

test('revoked actors cannot mutate channels or send tests',async()=>{
  const x=await setup()
  const stale={...actor,version:0}
  await assert.rejects(channelApi(request('POST',{...x.channelBody,name:'revoked'}),x.env,stale,'/admin/notifications/channels'))
  await assert.rejects(channelApi(request('POST',{version:1}),x.env,stale,`/admin/notifications/channels/${x.channel.id}/test`))
  assert.equal(x.calls.length,0)
  assert.equal((x.local.db.prepare("SELECT COUNT(*) AS n FROM notification_channels WHERE name='revoked'").get() as {n:number}).n,0)
})

test('Workerd D1 atomically queues and claims one delivery for concurrent schedulers', {skip:!process.env['USE_WORKERS_D1']}, async()=>{
  const {Miniflare,convertV4MiniflareOptions}=await import('miniflare')
  const runtime=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response()}}',d1Databases:['DB']}))
  try {
    const db=await runtime.getD1Database('DB') as D1Database
    for (const file of ['0001_board.sql','0002_checks.sql','0003_endpoint_registry.sql','0005_gatus_sources.sql','0006_advanced_http.sql','0008_vault.sql','0009_monitor_auth.sql','0009_channels.sql','0009_actions.sql','0010_monitor_alert_links.sql','0010_notification_transition_state.sql','0011_email_channels.sql','0012_notification_delivery_state.sql','0013_notification_unlink_cancel.sql']) {
      const sql=readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8').replace(/^\s*--[^\n]*$/gm,'')
      const parts=sql.split(/(?=CREATE TRIGGER |DROP TRIGGER )/)
      const statements=parts.shift()!.split(';').map(s=>s.trim()).filter(Boolean)
      statements.push(...parts.map(s=>s.trim()).filter(Boolean))
      await db.batch(statements.map(s=>db.prepare(s)))
    }
    await db.batch([
      db.prepare("INSERT INTO users (id,issuer,subject,email,role) VALUES ('admin','issuer','subject','admin@example.test','admin')"),
      db.prepare("INSERT INTO components (id,name,updated_at) VALUES ('component','Test monitor',0)"),
      db.prepare("INSERT INTO endpoint_registry VALUES ('check','approved')"),
      db.prepare("INSERT INTO http_checks (id,component_id,endpoint_id,enabled,interval_minutes,expected_status,last_status,last_scheduled_at) VALUES (?,'component','check',1,1,200,'up',1)").bind(checkId),
      db.prepare("INSERT INTO automation_transition_state (check_id,check_version,status) VALUES (?,1,'up')").bind(checkId),
    ])
    let calls=0
    const env={DB:db,CHANNEL_ENDPOINTS:destinations,CHANNELS_READY:'true',VAULT_ENCRYPTION_KEY:key,OUTBOUND:{fetch:async (_url:string,_init:RequestInit)=>{calls++;return new Response(null,{status:204})}}} satisfies ChannelEnvironment
    const vault=await (await vaultApi(request('POST',{name:'fixtures'}),db,key,actor,'/admin/vaults')).json() as {id:number}
    const secret=await (await vaultApi(request('POST',{name:'token',type:'value',value:'fixture-token'}),db,key,actor,`/admin/vaults/${vault.id}/secrets`)).json() as {id:number}
    const channel=await (await channelApi(request('POST',{name:'Fixture',endpointId,vaultId:vault.id,secretId:secret.id,enabled:true,checkIds:[checkId],expectedChecks:[{id:checkId,componentId:'component',version:1}]}),env,actor,'/admin/notifications/channels')).json() as {id:string}
    async function save() {
      return db.batch([
        db.prepare("INSERT OR IGNORE INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,http_status,latency_ms) VALUES (?,1,100,100,'down',500,4)").bind(checkId),
        enqueueTransition(db,checkId,1,'approved',100,'down'),
        db.prepare("UPDATE http_checks SET last_status='down',last_scheduled_at=100,last_result_at=100 WHERE id=? AND (last_scheduled_at IS NULL OR last_scheduled_at<100)").bind(checkId),
        db.prepare("UPDATE automation_transition_state SET status='down',generation=generation+1 WHERE check_id=? AND status<>'down'").bind(checkId),
      ])
    }
    await Promise.all([save(),save()])
    await Promise.all([flushChannelDeliveries(env),flushChannelDeliveries(env)])
    assert.equal(calls,1)
    const job=await db.prepare('SELECT state,attempts,error_code FROM notification_outbox WHERE channel_id=?').bind(channel.id).first<{state:string;attempts:number;error_code:string|null}>()
    assert.equal(job?.state,'sent');assert.equal(job?.attempts,1);assert.equal(job?.error_code,null)
  } finally { await runtime.dispose() }
})

test('a competing discarded result cannot enqueue an event with a different status',async()=>{
  const x=await setup()
  await x.db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,http_status,latency_ms) VALUES (?,1,100,100,'up',200,4)").bind(checkId).run()
  await x.db.batch([
    x.db.prepare("INSERT OR IGNORE INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,http_status,latency_ms) VALUES (?,1,100,100,'down',500,4)").bind(checkId),
    enqueueTransition(x.db,checkId,1,'approved',100,'down'),
  ])
  assert.equal((x.local.db.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get() as {n:number}).n,0)
  await flushChannelDeliveries(x.env)
  assert.equal(x.calls.length,0)
})

test('expired pending events fail without transmission',async()=>{
  const x=await setup()
  const result=x.db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,http_status,latency_ms) VALUES (?,1,100,100,'down',500,4)").bind(checkId)
  await x.db.batch([result,enqueueTransition(x.db,checkId,1,'approved',100,'down')])
  x.local.db.prepare('UPDATE notification_outbox SET created_at=?').run(Date.now()-3_600_001)
  await flushChannelDeliveries(x.env)
  assert.equal(x.calls.length,0)
  assert.equal((x.local.db.prepare('SELECT state FROM notification_outbox').get() as {state:string}).state,'failed')
})

async function queueTimingEvent(x:Awaited<ReturnType<typeof setup>>) {
  const result=x.db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,http_status,latency_ms) VALUES (?,1,100,100,'down',500,4)").bind(checkId)
  await x.db.batch([result,enqueueTransition(x.db,checkId,1,'approved',100,'down')])
  x.local.db.prepare("UPDATE automation_transition_state SET status='down',generation=1 WHERE check_id=?").run(checkId)
}

test('a lost or expired notification lease cannot transmit after slow resolution',async()=>{
  for(const reason of ['lease','age'] as const) {
    const x=await setup();await queueTimingEvent(x)
    const db={...x.db,prepare(sql:string){
      if(sql.includes('SELECT o.created_at AS createdAt,o.lease_until AS leaseUntil,')) {
        if(reason==='lease') x.local.db.prepare("UPDATE notification_outbox SET lease_token='another-worker'").run()
        else x.local.db.prepare('UPDATE notification_outbox SET created_at=?').run(Date.now()-3_600_001)
      }
      return x.db.prepare(sql)
    }} as D1Database
    await flushChannelDeliveries({...x.env,DB:db})
    assert.equal(x.calls.length,0)
    assert.equal((x.local.db.prepare('SELECT state FROM notification_outbox').get() as {state:string}).state,reason==='lease'?'sending':'pending')
    if(reason==='age') {
      await flushChannelDeliveries(x.env)
      assert.equal((x.local.db.prepare('SELECT state FROM notification_outbox').get() as {state:string}).state,'failed')
    }
  }
})

test('notification jobs that expire after selection cannot be claimed',async()=>{
  const x=await setup();await queueTimingEvent(x)
  const db={...x.db,prepare(sql:string){
    if(sql.includes("WHERE o.id=? AND (o.state='pending' OR (o.state='sending' AND o.lease_until<?)) AND o.created_at<?"))
      x.local.db.prepare('UPDATE notification_outbox SET created_at=?').run(Date.now()-3_600_001)
    return x.db.prepare(sql)
  }} as D1Database
  await flushChannelDeliveries({...x.env,DB:db})
  assert.equal(x.calls.length,0)
  assert.equal((x.local.db.prepare('SELECT state FROM notification_outbox').get() as {state:string}).state,'failed')
})

test('a notification does not send if the final lease query consumes its send window',async()=>{
  const x=await setup();await queueTimingEvent(x)
  const realNow=Date.now;let now=realNow()
  try {
    Date.now=()=>now
    const db={...x.db,prepare(sql:string){
      const statement=x.db.prepare(sql)
      if(!sql.includes('SELECT o.created_at AS createdAt,o.lease_until AS leaseUntil,')) return statement
      return {bind(...values:unknown[]){statement.bind(...values);return this},async first(){const value=await statement.first();now+=11_000;return value}} as D1PreparedStatement
    }} as D1Database
    await flushChannelDeliveries({...x.env,DB:db})
    assert.equal(x.calls.length,0)
  } finally {Date.now=realNow}
})

test('a notification defers when a scheduled maintenance window starts during its final query',async()=>{
  const x=await setup();await queueTimingEvent(x)
  const realNow=Date.now;let now=realNow()
  x.local.db.prepare("INSERT INTO maintenance (id,name,starts_at,ends_at,created_at,updated_at) VALUES ('m','window',?,?,?,?)").run(now+1_000,now+60_000,now,now)
  try {
    Date.now=()=>now
    const db={...x.db,prepare(sql:string){
      const statement=x.db.prepare(sql)
      if(!sql.includes('SELECT o.created_at AS createdAt,o.lease_until AS leaseUntil,')) return statement
      return {bind(...values:unknown[]){statement.bind(...values);return this},async first(){const value=await statement.first();now+=2_000;return value}} as D1PreparedStatement
    }} as D1Database
    await flushChannelDeliveries({...x.env,DB:db})
    assert.equal(x.calls.length,0)
    assert.deepEqual({...x.local.db.prepare('SELECT state,attempts FROM notification_outbox').get()},{state:'pending',attempts:0})
  } finally {Date.now=realNow}
})

test('degraded and down remain distinct and stale effective watermarks fall back to legacy status',async()=>{
  const x=await setup()
  await x.db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,effective_status,http_status,latency_ms) VALUES (?,1,100,100,'down','degraded',200,4)").bind(checkId).run()
  await enqueueTransition(x.db,checkId,1,'approved',100,'degraded').run()
  x.local.db.prepare("UPDATE automation_transition_state SET status='degraded',generation=1 WHERE check_id=?").run(checkId)
  await flushChannelDeliveries(x.env)
  assert.equal(JSON.parse(String(x.calls[0]!.init.body)).status,'degraded')
  x.local.db.prepare("UPDATE http_checks SET last_status='down',last_scheduled_at=101,last_effective_status='up',last_effective_scheduled_at=100 WHERE id=?").run(checkId)
  x.local.db.prepare("UPDATE automation_transition_state SET status='down',generation=generation+1 WHERE check_id=?").run(checkId)
  await x.db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,effective_status,http_status,latency_ms) VALUES (?,1,102,102,'down','down',500,4)").bind(checkId).run()
  await enqueueTransition(x.db,checkId,1,'approved',102,'down').run()
  assert.equal((x.local.db.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get() as {n:number}).n,1)
})

test('a receiver with a stalled cancellation cannot hang delivery',async()=>{
  const x=await setup()
  const env={...x.env, OUTBOUND:{fetch:async()=>new Response(new ReadableStream({cancel:()=>new Promise(()=>{})}),{status:200})}}
  assert.equal(await Promise.race([sendChannel(env,x.channel.id,1,{},false),new Promise(resolve=>setTimeout(()=>resolve('timeout'),100))]),'sent')
})

test('whitespace and overlong Bearer tokens are never transmitted',async()=>{
 const x=await setup()
 await vaultApi(request('PATCH',{version:1,value:'not a bearer token'}),x.db,key,actor,`/admin/vaults/${x.vault.id}/secrets/${x.secret.id}`)
 assert.equal(await sendChannel(x.env,x.channel.id,1,{},false),'unavailable')
 await vaultApi(request('PATCH',{version:2,value:'a'.repeat(4097)}),x.db,key,actor,`/admin/vaults/${x.vault.id}/secrets/${x.secret.id}`)
 assert.equal(await sendChannel(x.env,x.channel.id,1,{},false),'unavailable');assert.equal(x.calls.length,0)
})

test('the first healthy observation after a credential fault cannot enqueue a false recovery',async()=>{
 const x=await setup()
 x.local.db.prepare("UPDATE http_checks SET last_status='down',transition_suppressed=1 WHERE id=?").run(checkId)
 await x.db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,effective_status,http_status,latency_ms) VALUES (?,1,100,100,'up','up',200,4)").bind(checkId).run()
 await enqueueTransition(x.db,checkId,1,'approved',100,'up').run()
 assert.equal((x.local.db.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get() as {n:number}).n,0)
})

test('webhook retries use a stable idempotency key and recovery follows acknowledged outage',async()=>{
 const x=await setup()
 await x.db.batch([
  x.db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,http_status,latency_ms) VALUES (?,1,100,100,'down',500,4)").bind(checkId),
  enqueueTransition(x.db,checkId,1,'approved',100,'down'),
  x.db.prepare("UPDATE http_checks SET last_status='down',last_scheduled_at=100,last_result_at=100 WHERE id=?").bind(checkId),
  x.db.prepare("UPDATE automation_transition_state SET status='down',generation=generation+1 WHERE check_id=?").bind(checkId),
 ])
 x.setStatus(500);await flushChannelDeliveries(x.env);assert.equal(x.calls.length,1)
 x.setStatus(200);await flushChannelDeliveries(x.env);assert.equal(x.calls.length,2)
 await x.db.batch([
  x.db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,http_status,latency_ms) VALUES (?,1,200,200,'up',200,4)").bind(checkId),
  enqueueTransition(x.db,checkId,1,'approved',200,'up'),
  x.db.prepare("UPDATE http_checks SET last_status='up',last_scheduled_at=200,last_result_at=200 WHERE id=?").bind(checkId),
  x.db.prepare("UPDATE automation_transition_state SET status='up',generation=generation+1 WHERE check_id=?").bind(checkId),
 ])
 await flushChannelDeliveries(x.env);assert.equal(x.calls.length,3)
 const headers=x.calls.map(call=>call.init.headers as Record<string,string>)
 assert.ok(headers[0]!['Idempotency-Key']);assert.equal(headers[0]!['Idempotency-Key'],headers[1]!['Idempotency-Key'])
 assert.notEqual(headers[1]!['Idempotency-Key'],headers[2]!['Idempotency-Key'])
 assert.deepEqual(x.calls.map(call=>JSON.parse(String(call.init.body)).status),['down','down','up'])
})

test('a pending channel event waits through maintenance and a fresh observation without expiring',async()=>{
 const x=await setup(), now=Date.now(), scheduled=now-7_200_000
 await x.db.batch([
  x.db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,http_status,latency_ms) VALUES (?,1,?,?,'down',500,4)").bind(checkId,scheduled,scheduled),
  enqueueTransition(x.db,checkId,1,'approved',scheduled,'down'),
  x.db.prepare("UPDATE http_checks SET last_status='down',last_scheduled_at=?,last_result_at=? WHERE id=?").bind(now-60_000,now-60_000,checkId),
  x.db.prepare("UPDATE automation_transition_state SET status='down',generation=generation+1 WHERE check_id=?").bind(checkId),
 ])
 x.local.db.prepare("UPDATE notification_outbox SET created_at=?").run(scheduled)
 x.local.db.prepare("INSERT INTO maintenance (id,name,starts_at,ends_at,created_at,updated_at) VALUES ('m','window',?,?,?,?)").run(now-120_000,now+60_000,now,now)
 await flushChannelDeliveries(x.env);assert.equal(x.calls.length,0)
 assert.equal((x.local.db.prepare('SELECT state FROM notification_outbox').get() as {state:string}).state,'pending')
 x.local.db.prepare("UPDATE maintenance SET ends_at=? WHERE id='m'").run(now-1)
 await flushChannelDeliveries(x.env);assert.equal(x.calls.length,0)
 x.local.db.prepare("UPDATE http_checks SET last_scheduled_at=?,last_result_at=? WHERE id=?").run(now,now,checkId)
 await flushChannelDeliveries(x.env);assert.equal(x.calls.length,1)
 assert.equal((x.local.db.prepare('SELECT state FROM notification_outbox').get() as {state:string}).state,'sent')
})

test('a post-maintenance recovery supersedes an unsent pre-window outage',async()=>{
 const x=await setup(), now=Date.now(), scheduled=now-180_000
 await x.db.batch([
  x.db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,http_status,latency_ms) VALUES (?,1,?,?,'down',500,4)").bind(checkId,scheduled,scheduled),
  enqueueTransition(x.db,checkId,1,'approved',scheduled,'down'),
  x.db.prepare("UPDATE http_checks SET last_status='up',last_scheduled_at=?,last_result_at=? WHERE id=?").bind(now,now,checkId),
  x.db.prepare("UPDATE automation_transition_state SET status='up',generation=generation+2 WHERE check_id=?").bind(checkId),
 ])
 x.local.db.prepare("INSERT INTO maintenance (id,name,starts_at,ends_at,created_at,updated_at) VALUES ('m','window',?,?,?,?)").run(now-120_000,now-60_000,now,now)
 await flushChannelDeliveries(x.env)
 assert.equal(x.calls.length,0)
 assert.equal((x.local.db.prepare('SELECT state FROM notification_outbox').get() as {state:string}).state,'failed')
})

test('an unqueued newer status while delivery is unavailable makes an old event obsolete',async()=>{
 const x=await setup()
 await x.db.batch([
  x.db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,http_status,latency_ms) VALUES (?,1,100,100,'down',500,4)").bind(checkId),
  enqueueTransition(x.db,checkId,1,'approved',100,'down'),
  x.db.prepare("UPDATE http_checks SET last_status='up',last_scheduled_at=200 WHERE id=?").bind(checkId),
  x.db.prepare("UPDATE automation_transition_state SET status='up',generation=generation+2 WHERE check_id=?").bind(checkId),
 ])
 await flushChannelDeliveries(x.env);assert.equal(x.calls.length,0)
 assert.equal((x.local.db.prepare('SELECT error_code FROM notification_outbox').get() as {error_code:string}).error_code,'unavailable')
})

test('a window starting after claim defers a notification before network transmission',async()=>{
 const x=await setup(), now=Date.now()
 await x.db.batch([
  x.db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,http_status,latency_ms) VALUES (?,1,100,100,'down',500,4)").bind(checkId),
  enqueueTransition(x.db,checkId,1,'approved',100,'down'),
  x.db.prepare("UPDATE http_checks SET last_status='down',last_scheduled_at=100 WHERE id=?").bind(checkId),
  x.db.prepare("UPDATE automation_transition_state SET status='down',generation=generation+1 WHERE check_id=?").bind(checkId),
 ])
 let inserted=false
 const db={prepare(sql:string) {
  if(!inserted && sql.includes('FROM notification_outbox o JOIN http_checks')) {
   inserted=true;x.local.db.prepare("INSERT INTO maintenance (id,name,starts_at,ends_at,created_at,updated_at) VALUES ('m','window',?,?,?,?)").run(now-1000,now+60_000,now,now)
  }
  return x.db.prepare(sql)
 }} as D1Database
 await flushChannelDeliveries({...x.env,DB:db})
 assert.equal(x.calls.length,0)
 assert.deepEqual({...x.local.db.prepare('SELECT state,attempts,error_code FROM notification_outbox').get()},{state:'pending',attempts:0,error_code:null})
})

test('down-up-down supersedes an earlier pending outage even if the latest status matches',async()=>{
 const x=await setup()
 await x.db.batch([
  x.db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,http_status,latency_ms) VALUES (?,1,100,100,'down',500,4)").bind(checkId),
  enqueueTransition(x.db,checkId,1,'approved',100,'down'),
  x.db.prepare("UPDATE automation_transition_state SET status='down',generation=3 WHERE check_id=?").bind(checkId),
  x.db.prepare("UPDATE http_checks SET last_status='down',last_scheduled_at=300,last_result_at=300 WHERE id=?").bind(checkId),
 ])
 await flushChannelDeliveries(x.env);assert.equal(x.calls.length,0)
 assert.equal((x.local.db.prepare('SELECT state FROM notification_outbox').get() as {state:string}).state,'failed')
})

test('recovery is suppressed when no unhealthy notification was acknowledged',async()=>{
 const x=await setup()
 await x.db.batch([
  x.db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,http_status,latency_ms) VALUES (?,1,100,100,'down',500,4)").bind(checkId),
  enqueueTransition(x.db,checkId,1,'approved',100,'down'),
  x.db.prepare("UPDATE automation_transition_state SET status='down',generation=1 WHERE check_id=?").bind(checkId),
  x.db.prepare("UPDATE http_checks SET last_status='down',last_scheduled_at=100,last_result_at=100 WHERE id=?").bind(checkId),
 ])
 await x.db.batch([
  x.db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,http_status,latency_ms) VALUES (?,1,200,200,'up',200,4)").bind(checkId),
  enqueueTransition(x.db,checkId,1,'approved',200,'up'),
  x.db.prepare("UPDATE automation_transition_state SET status='up',generation=2 WHERE check_id=?").bind(checkId),
  x.db.prepare("UPDATE http_checks SET last_status='up',last_scheduled_at=200,last_result_at=200 WHERE id=?").bind(checkId),
 ])
 await flushChannelDeliveries(x.env);assert.equal(x.calls.length,0)
 assert.deepEqual(x.local.db.prepare('SELECT state FROM notification_outbox ORDER BY scheduled_at').all().map(row=>row.state),['failed','failed'])
})

test('channel enqueue uses actual completion time at maintenance boundaries',async()=>{
 const x=await setup()
 x.local.db.prepare("INSERT INTO maintenance (id,name,starts_at,ends_at,created_at,updated_at) VALUES ('m','window',100,200,1,1)").run()
 await x.db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,http_status,latency_ms) VALUES (?,1,90,150,'down',500,4)").bind(checkId).run()
 await enqueueTransition(x.db,checkId,1,'approved',90,'down',150).run()
 assert.equal((x.local.db.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get() as {n:number}).n,0)
 await x.db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,http_status,latency_ms) VALUES (?,1,120,210,'down',500,4)").bind(checkId).run()
 await enqueueTransition(x.db,checkId,1,'approved',120,'down',210).run()
 assert.equal((x.local.db.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get() as {n:number}).n,1)
})

test('a webhook configuration change during the last preflight prevents the old send',async()=>{
  const x=await setup()
  await x.db.batch([
    x.db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,http_status,latency_ms) VALUES (?,1,100,100,'down',500,4)").bind(checkId),
    enqueueTransition(x.db,checkId,1,'approved',100,'down'),
    x.db.prepare("UPDATE http_checks SET last_status='down',last_scheduled_at=100 WHERE id=?").bind(checkId),
    x.db.prepare("UPDATE automation_transition_state SET status='down',generation=generation+1 WHERE check_id=?").bind(checkId),
  ])
  let started!:()=>void, resume!:()=>void
  const reached=new Promise<void>(resolve=>{started=resolve})
  const blocked=new Promise<void>(resolve=>{resume=resolve})
  let intercepted=false
  const guardedDb={
    prepare(sql:string) {
      const statement=x.db.prepare(sql)
      if (!intercepted && sql.includes('JOIN notification_channels c ON c.id=o.channel_id') && sql.includes('AND c.id=?')) {
        intercepted=true
        return { bind(...values:unknown[]) {
          const bound=statement.bind(...values)
          return { async first() {started();await blocked;return bound.first()} }
        } }
      }
      return statement
    },
    batch:x.db.batch.bind(x.db),
  } as unknown as D1Database
  const flush=flushChannelDeliveries({...x.env,DB:guardedDb})
  await reached
  x.local.db.prepare('UPDATE notification_channels SET version=version+1 WHERE id=?').run(x.channel.id)
  resume()
  await flush
  assert.equal(x.calls.length,0)
  await flushChannelDeliveries(x.env)
  assert.equal(x.calls.length,0)
  assert.deepEqual({...x.local.db.prepare('SELECT state,error_code FROM notification_outbox').get()},{state:'failed',error_code:'unavailable'})
})

test('webhook preflight refuses credentials rotated or deleted after resolution',async()=>{
 for(const change of ['rotate','delete','replace'] as const) {
  const x=await setup()
  await x.db.batch([
   x.db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,http_status,latency_ms) VALUES (?,1,100,100,'down',500,4)").bind(checkId),
   enqueueTransition(x.db,checkId,1,'approved',100,'down'),
   x.db.prepare("UPDATE automation_transition_state SET status='down',generation=1 WHERE check_id=?").bind(checkId),
   x.db.prepare("UPDATE http_checks SET last_status='down',last_scheduled_at=100,last_result_at=100 WHERE id=?").bind(checkId),
  ])
  let changed=false
  const db={prepare(sql:string) {
   if(!changed && sql.includes('FROM notification_outbox o JOIN http_checks') && sql.includes('JOIN vault_secrets v')) {
    changed=true
    if(change==='delete') x.local.db.prepare('DELETE FROM vault_secrets WHERE id=?').run(x.secret.id)
    else if(change==='rotate') x.local.db.prepare('UPDATE vault_secrets SET version=version+1 WHERE id=?').run(x.secret.id)
    else x.local.db.prepare("UPDATE vault_secrets SET nonce='replacement' WHERE id=?").run(x.secret.id)
   }
   return x.db.prepare(sql)
  }} as D1Database
  await flushChannelDeliveries({...x.env,DB:db})
  assert.equal(x.calls.length,0,change)
  assert.equal((x.local.db.prepare('SELECT state FROM notification_outbox').get() as {state:string}).state,'pending',change)
 }
})

test('manual webhook tests refuse credentials rotated after resolution',async()=>{
 const x=await setup();let changed=false
 const db={prepare(sql:string) {
  if(!changed && sql.includes('SELECT 1 FROM notification_channels c JOIN vault_secrets v')) {
   changed=true;x.local.db.prepare('UPDATE vault_secrets SET version=version+1 WHERE id=?').run(x.secret.id)
  }
  return x.db.prepare(sql)
 }} as D1Database
 assert.equal(await sendChannel({...x.env,DB:db},x.channel.id,1,{},false),'unavailable')
 assert.equal(x.calls.length,0)
})

test('a maintenance window or credential fault beginning during validation defers an unsent channel claim',async()=>{
 for(const reason of ['maintenance','credential'] as const) {
  const x=await setup(),now=Date.now()
  await x.db.batch([
   x.db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,http_status,latency_ms) VALUES (?,1,100,100,'down',500,4)").bind(checkId),
   enqueueTransition(x.db,checkId,1,'approved',100,'down'),
   x.db.prepare("UPDATE automation_transition_state SET status='down',generation=1 WHERE check_id=?").bind(checkId),
   x.db.prepare("UPDATE http_checks SET last_status='down',last_scheduled_at=100,last_result_at=100 WHERE id=?").bind(checkId),
  ])
  let changed=false
  const db={prepare(sql:string) {
   if (!changed && sql.includes('SELECT vault_id,secret_id FROM notification_channels')) {
    changed=true
    if(reason==='maintenance') x.local.db.prepare("INSERT INTO maintenance (id,name,starts_at,ends_at,created_at,updated_at) VALUES ('m','window',?,?,?,?)").run(now-1000,now+60_000,now,now)
    else x.local.db.prepare('UPDATE http_checks SET transition_suppressed=1,last_status=\'up\' WHERE id=?').run(checkId)
    x.local.db.prepare('DELETE FROM vault_secrets WHERE id=?').run(x.secret.id)
   }
   return x.db.prepare(sql)
  }} as D1Database
  await flushChannelDeliveries({...x.env,DB:db})
  assert.equal(changed,true,reason)
  assert.equal(x.calls.length,0,reason)
  assert.deepEqual({...x.local.db.prepare('SELECT state,attempts,error_code FROM notification_outbox').get()},{state:'pending',attempts:0,error_code:null},reason)
 }
})

test('channel no-op and rename preserve pending delivery and acknowledged history',async()=>{
  const x=await setup();await queueTimingEvent(x)
  x.local.db.prepare("INSERT INTO notification_delivery_state (channel_id,check_id,check_version,channel_version,status) VALUES (?,?,1,1,'up')").run(x.channel.id,checkId)
  const noop=await channelApi(request('PATCH',{...x.channelBody,expectedCheckIds:[checkId],expectedAssociationVersion:1,version:1}),x.env,actor,`/admin/notifications/channels/${x.channel.id}`)
  assert.equal((await noop.json() as {version:number}).version,1)
  const renamed=await channelApi(request('PATCH',{...x.channelBody,expectedCheckIds:[checkId],expectedAssociationVersion:1,name:'Renamed',version:1}),x.env,actor,`/admin/notifications/channels/${x.channel.id}`)
  assert.equal((await renamed.json() as {version:number}).version,2)
  assert.deepEqual({...x.local.db.prepare('SELECT state,channel_version FROM notification_outbox').get()},{state:'pending',channel_version:2})
  assert.equal(x.local.db.prepare('SELECT channel_version FROM notification_delivery_state').get()?.channel_version,2)
  await flushChannelDeliveries(x.env)
  assert.equal(x.calls.length,1)
  assert.equal(x.local.db.prepare('SELECT state FROM notification_outbox').get()?.state,'sent')
})

test('channel create and update reject a monitor moved or changed before the transaction',async()=>{
  for (const method of ['POST','PATCH'] as const) for (const change of ['component','version'] as const) {
    const x=await setup()
    x.local.db.prepare("INSERT INTO components (id,name,updated_at) VALUES ('other','Other monitor',0)").run()
    const choices=await (await channelApi(request('GET'),x.env,actor,'/admin/notifications/checks')).json() as {id:string;componentId:string;version:number}[]
    assert.deepEqual(choices.map(({id,componentId,version})=>({id,componentId,version})),x.channelBody.expectedChecks)
    let changed=false
    const db={prepare:(sql:string)=>x.db.prepare(sql),async batch(statements: D1PreparedStatement[]) {
      if (!changed) {
        changed=true
        if (change==='component') x.local.db.prepare('UPDATE http_checks SET component_id=? WHERE id=?').run('other',checkId)
        else x.local.db.prepare('UPDATE http_checks SET config_version=config_version+1 WHERE id=?').run(checkId)
      }
      return x.db.batch(statements)
    }} as D1Database
    const input=method==='POST' ? {...x.channelBody,name:'Second'} : {...x.channelBody,expectedCheckIds:[checkId],expectedAssociationVersion:1,name:'Changed',version:1}
    const route=method==='POST' ? '/admin/notifications/channels' : `/admin/notifications/channels/${x.channel.id}`
    const audits=x.local.db.prepare('SELECT COUNT(*) AS n FROM audit_events').get()?.n
    await assert.rejects(channelApi(request(method,input),{...x.env,DB:db},actor,route),(e:unknown)=>e instanceof ChannelError && e.status===409)
    assert.equal(changed,true)
    assert.equal(x.local.db.prepare('SELECT name FROM notification_channels WHERE id=?').get(x.channel.id)?.name,'Fixture')
    assert.equal(x.local.db.prepare('SELECT COUNT(*) AS n FROM notification_channel_checks WHERE channel_id=?').get(x.channel.id)?.n,change==='component'?0:1)
    assert.equal(x.local.db.prepare('SELECT COUNT(*) AS n FROM audit_events').get()?.n,audits)
  }
})

test('an old channel editor must refresh; malformed monitor snapshots remain invalid',async()=>{
  const x=await setup(), legacy:Record<string,unknown>={...x.channelBody}
  delete legacy.expectedChecks
  for (const method of ['POST','PATCH'] as const) {
    const route=method==='POST' ? '/admin/notifications/channels' : `/admin/notifications/channels/${x.channel.id}`
    const input=method==='POST' ? {...legacy,name:'Second'} : {...legacy,version:1}
    await assert.rejects(channelApi(request(method,input),x.env,actor,route),(e:unknown)=>e instanceof ChannelError && e.status===409 && /refresh/i.test(e.message))
    await assert.rejects(channelApi(request(method,{...input,expectedChecks:null}),x.env,actor,route),(e:unknown)=>e instanceof ChannelError && e.status===400)
  }
  assert.equal(x.local.db.prepare('SELECT COUNT(*) AS n FROM notification_channels').get()?.n,1)
  assert.equal(x.local.db.prepare('SELECT version FROM notification_channels WHERE id=?').get(x.channel.id)?.version,1)
})

test('removing a monitor still invokes integrated unlink cancellation',async()=>{
  const x=await setup();await queueTimingEvent(x)
  x.local.db.prepare("INSERT INTO notification_delivery_state (channel_id,check_id,check_version,channel_version,status) VALUES (?,?,1,1,'down')").run(x.channel.id,checkId)
  await channelApi(request('PATCH',{...x.channelBody,expectedCheckIds:[checkId],expectedAssociationVersion:1,checkIds:[],expectedChecks:[],version:1}),x.env,actor,`/admin/notifications/channels/${x.channel.id}`)
  assert.equal(x.local.db.prepare('SELECT state FROM notification_outbox').get()?.state,'failed')
  assert.equal(x.local.db.prepare('SELECT COUNT(*) AS n FROM notification_delivery_state').get()?.n,0)
  await flushChannelDeliveries(x.env)
  assert.equal(x.calls.length,0)
})

test('functional channel edits do not carry pending work or delivery history',async()=>{
  const x=await setup();await queueTimingEvent(x)
  x.local.db.prepare("INSERT INTO notification_delivery_state (channel_id,check_id,check_version,channel_version,status) VALUES (?,?,1,1,'down')").run(x.channel.id,checkId)
  const response=await channelApi(request('PATCH',{...x.channelBody,expectedCheckIds:[checkId],expectedAssociationVersion:1,enabled:false,version:1}),x.env,actor,`/admin/notifications/channels/${x.channel.id}`)
  assert.equal((await response.json() as {version:number}).version,2)
  assert.equal(x.local.db.prepare('SELECT channel_version FROM notification_outbox').get()?.channel_version,1)
  assert.equal(x.local.db.prepare('SELECT channel_version FROM notification_delivery_state').get()?.channel_version,1)
  await flushChannelDeliveries(x.env)
  assert.equal(x.calls.length,0)
})

test('concurrent channel rename and functional edits have one version winner',async()=>{
  const x=await setup();await queueTimingEvent(x)
  const path=`/admin/notifications/channels/${x.channel.id}`
  const results=await Promise.allSettled([
    channelApi(request('PATCH',{...x.channelBody,expectedCheckIds:[checkId],expectedAssociationVersion:1,name:'Renamed',version:1}),x.env,actor,path),
    channelApi(request('PATCH',{...x.channelBody,expectedCheckIds:[checkId],expectedAssociationVersion:1,enabled:false,version:1}),x.env,actor,path),
  ])
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1)
  const failure=results.find(result=>result.status==='rejected') as PromiseRejectedResult
  assert.ok(failure.reason instanceof ChannelError && failure.reason.status===409)
  const row=x.local.db.prepare('SELECT name,enabled,version FROM notification_channels').get() as {name:string;enabled:number;version:number}
  assert.equal(row.version,2)
  assert.equal(x.local.db.prepare('SELECT channel_version FROM notification_outbox').get()?.channel_version,row.name==='Renamed'?2:1)
})

test('channel rename does not retry an in-flight send and retains its acknowledgement',async()=>{
  const x=await setup();await queueTimingEvent(x)
  let start!:()=>void, release!:()=>void
  const started=new Promise<void>(resolve=>{start=resolve}), blocked=new Promise<void>(resolve=>{release=resolve})
  const env={...x.env,OUTBOUND:{fetch:async()=>{start();await blocked;return new Response(null,{status:200})}}}
  const flushing=flushChannelDeliveries(env);await started
  await channelApi(request('PATCH',{...x.channelBody,expectedCheckIds:[checkId],expectedAssociationVersion:1,name:'Renamed',version:1}),env,actor,`/admin/notifications/channels/${x.channel.id}`)
  assert.deepEqual({...x.local.db.prepare('SELECT state,channel_version FROM notification_outbox').get()},{state:'sending',channel_version:2})
  release();await flushing
  assert.equal(x.local.db.prepare('SELECT state FROM notification_outbox').get()?.state,'sent')
  assert.equal(x.local.db.prepare('SELECT channel_version FROM notification_delivery_state').get()?.channel_version,2)
})

test('channel rename during claimed pre-send validation defers rather than discarding',async()=>{
  const x=await setup();await queueTimingEvent(x)
  let renamed=false
  const db={...x.db,prepare(sql:string){
    const statement=x.db.prepare(sql)
    if(renamed || !sql.includes('SELECT 1 AS present FROM notification_channels WHERE')) return statement
    return {bind(...values:unknown[]){statement.bind(...values);return this},async first(){
      renamed=true
      await channelApi(request('PATCH',{...x.channelBody,expectedCheckIds:[checkId],expectedAssociationVersion:1,name:'Renamed',version:1}),x.env,actor,`/admin/notifications/channels/${x.channel.id}`)
      return statement.first()
    }} as D1PreparedStatement
  }} as D1Database
  await flushChannelDeliveries({...x.env,DB:db})
  assert.deepEqual({...x.local.db.prepare('SELECT state,channel_version FROM notification_outbox').get()},{state:'pending',channel_version:2})
  assert.equal(x.calls.length,0)
  await flushChannelDeliveries(x.env)
  assert.equal(x.calls.length,1)
})
