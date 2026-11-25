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
  for (const file of ['0001_board.sql','0002_checks.sql','0003_endpoint_registry.sql','0005_gatus_sources.sql','0006_advanced_http.sql','0008_vault.sql','0009_monitor_auth.sql','0009_channels.sql']) local.db.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'))
  local.db.prepare("INSERT INTO users (id,issuer,subject,email,role) VALUES ('admin','issuer','subject','admin@example.test','admin')").run()
  local.db.prepare("INSERT INTO components (id,name,updated_at) VALUES ('component','Test monitor',0)").run()
  local.db.prepare("INSERT INTO endpoint_registry VALUES ('check','approved')").run()
  local.db.prepare("INSERT INTO http_checks (id,component_id,endpoint_id,enabled,interval_minutes,expected_status,last_status,last_scheduled_at) VALUES (?,'component','check',1,1,200,'up',1)").run(checkId)
  const db=local as unknown as D1Database
  const calls:{url:string;init:RequestInit}[]=[]
  let status=200
  const env={ DB:db, CHANNEL_ENDPOINTS:destinations, CHANNELS_READY:'true', VAULT_ENCRYPTION_KEY:key, OUTBOUND:{fetch:async (url:string,init:RequestInit)=>{calls.push({url,init});return new Response('private response body',{status})}} } satisfies ChannelEnvironment
  const vault=await (await vaultApi(request('POST',{name:'fixtures'}),db,key,actor,'/admin/vaults')).json() as {id:number}
  const secret=await (await vaultApi(request('POST',{name:'token',type:'value',value:'fixture-token-one'}),db,key,actor,`/admin/vaults/${vault.id}/secrets`)).json() as {id:number;version:number}
  const channelBody={name:'Fixture',endpointId,vaultId:vault.id,secretId:secret.id,enabled:true,checkIds:[checkId]}
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
  assert.equal((x.local.db.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get() as {n:number}).n,1)
  await Promise.all([flushChannelDeliveries(x.env),flushChannelDeliveries(x.env)])
  assert.equal(x.calls.length,1)
  const row=x.local.db.prepare('SELECT state,attempts,error_code FROM notification_outbox').get() as {state:string;attempts:number;error_code:string|null}
  assert.deepEqual({...row},{state:'sent',attempts:1,error_code:null})
  assert.doesNotMatch(JSON.stringify(x.local.db.prepare('SELECT * FROM notification_outbox').all()),/fixture-token/)
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
    for (const file of ['0001_board.sql','0002_checks.sql','0003_endpoint_registry.sql','0005_gatus_sources.sql','0006_advanced_http.sql','0008_vault.sql','0009_monitor_auth.sql','0009_channels.sql']) {
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
    ])
    let calls=0
    const env={DB:db,CHANNEL_ENDPOINTS:destinations,CHANNELS_READY:'true',VAULT_ENCRYPTION_KEY:key,OUTBOUND:{fetch:async (_url:string,_init:RequestInit)=>{calls++;return new Response(null,{status:204})}}} satisfies ChannelEnvironment
    const vault=await (await vaultApi(request('POST',{name:'fixtures'}),db,key,actor,'/admin/vaults')).json() as {id:number}
    const secret=await (await vaultApi(request('POST',{name:'token',type:'value',value:'fixture-token'}),db,key,actor,`/admin/vaults/${vault.id}/secrets`)).json() as {id:number}
    const channel=await (await channelApi(request('POST',{name:'Fixture',endpointId,vaultId:vault.id,secretId:secret.id,enabled:true,checkIds:[checkId]}),env,actor,'/admin/notifications/channels')).json() as {id:string}
    async function save() {
      return db.batch([
        db.prepare("INSERT OR IGNORE INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,http_status,latency_ms) VALUES (?,1,100,100,'down',500,4)").bind(checkId),
        enqueueTransition(db,checkId,1,'approved',100,'down'),
        db.prepare("UPDATE http_checks SET last_status='down',last_scheduled_at=100 WHERE id=? AND (last_scheduled_at IS NULL OR last_scheduled_at<100)").bind(checkId),
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

test('degraded and down remain distinct and stale effective watermarks fall back to legacy status',async()=>{
  const x=await setup()
  await x.db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,effective_status,http_status,latency_ms) VALUES (?,1,100,100,'down','degraded',200,4)").bind(checkId).run()
  await enqueueTransition(x.db,checkId,1,'approved',100,'degraded').run()
  await flushChannelDeliveries(x.env)
  assert.equal(JSON.parse(String(x.calls[0]!.init.body)).status,'degraded')
  x.local.db.prepare("UPDATE http_checks SET last_status='down',last_scheduled_at=101,last_effective_status='up',last_effective_scheduled_at=100 WHERE id=?").run(checkId)
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
