import {test} from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {readFileSync} from 'node:fs'
import {vaultApi} from '../src/vault.ts'
import {actionApi,ActionError} from '../src/actions.ts'
import {enqueueActionTransition,flushActions,type ActionEnvironment} from '../src/actions-runtime.ts'
import {issue14PreviewEnvironment} from '../../gateway/issue14-preview.ts'
class Statement {
  private values:unknown[]=[]
  constructor(private sql:string,private db:DatabaseSync) {}
  bind(...values:unknown[]){this.values=values;return this}
  runSync(){const r=this.db.prepare(this.sql).run(...this.values as never[]);return {success:true,meta:{changes:Number(r.changes)}}}
  async run(){return this.runSync()}
  async first<T>(){return (this.db.prepare(this.sql).get(...this.values as never[])??null) as T|null}
  async all<T>(){return {results:this.db.prepare(this.sql).all(...this.values as never[]) as T[]}}
}
class DB {
  db=new DatabaseSync(':memory:')
  prepare(sql:string){return new Statement(sql,this.db)}
  async batch(statements:Statement[]){this.db.exec('BEGIN');try{const r=statements.map(s=>s.runSync());this.db.exec('COMMIT');return r}catch(e){this.db.exec('ROLLBACK');throw e}}
}
const actor={id:'admin',email:'admin@example.test',version:1}, key='aa'.repeat(32), checkId='00000000-0000-4000-8000-000000000001'
const destinations=JSON.stringify([{id:'approved',name:'Approved action',url:'https://action.example.test/run',binding:'ACTION',serviceId:'test'}])
const request=(method:string,body?:unknown)=>new Request('https://status.example.test',{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})})
async function setup(){
 const local=new DB()
 for(const file of ['0001_board.sql','0002_checks.sql','0003_endpoint_registry.sql','0005_gatus_sources.sql','0006_advanced_http.sql','0008_vault.sql','0009_monitor_auth.sql','0009_actions.sql','0009_channels.sql','0010_monitor_alert_links.sql','0010_notification_transition_state.sql','0011_email_channels.sql','0012_notification_delivery_state.sql','0013_notification_unlink_cancel.sql','0017_monitor_action_links.sql']) local.db.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'))
 local.db.prepare("INSERT INTO users (id,issuer,subject,email,role) VALUES ('admin','issuer','subject','admin@example.test','admin')").run()
 local.db.prepare("INSERT INTO components (id,name,updated_at) VALUES ('component','Service',0)").run()
 local.db.prepare("INSERT INTO endpoint_registry VALUES ('check','approved')").run()
 local.db.prepare("INSERT INTO http_checks (id,component_id,endpoint_id,enabled,interval_minutes,expected_status,last_status,last_scheduled_at) VALUES (?,'component','check',1,1,200,'up',1)").run(checkId)
 local.db.prepare("INSERT INTO automation_transition_state (check_id,check_version,status) VALUES (?,1,'up')").run(checkId)
 const db=local as unknown as D1Database, calls:{url:string;init:RequestInit}[]=[]
 let status=204
 const env={DB:db,ACTIONS_READY:'true',ACTION_ENDPOINTS:destinations,VAULT_ENCRYPTION_KEY:key,ACTION:{fetch:async(url:string,init:RequestInit)=>{calls.push({url,init});return status===204?new Response(null,{status}):new Response('private response',{status})}}} satisfies ActionEnvironment
 const vault=await (await vaultApi(request('POST',{name:'fixture'}),db,key,actor,'/admin/vaults')).json() as {id:number}
 const secret=await (await vaultApi(request('POST',{name:'token',type:'value',value:'fixture-token-one'}),db,key,actor,`/admin/vaults/${vault.id}/secrets`)).json() as {id:number}
 const actionBody={name:'Action',endpointId:'approved',vaultId:vault.id,secretId:secret.id,enabled:true,checkIds:[checkId],checkSnapshots:[{id:checkId,componentId:'component',configVersion:1}],triggerStatus:'all'}
 const action=await (await actionApi(request('POST',actionBody),env,actor,'/admin/actions')).json() as {id:string;version:number}
 return {local,db,env,calls,vault,secret,action,actionBody,setStatus:(v:number)=>{status=v}}
}
async function queue(x:Awaited<ReturnType<typeof setup>>,status:'up'|'down'|'degraded'='down',time=100){
 const binary=status==='up'?'up':'down'
 // Each standalone queue call models a fresh transition from a prior up baseline.
 x.local.db.prepare("UPDATE automation_transition_state SET status='up' WHERE check_id=?").run(checkId)
 await x.db.batch([
  x.db.prepare('INSERT OR IGNORE INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,effective_status,http_status,latency_ms) VALUES (?,1,?,?,?,?,500,4)').bind(checkId,time,time,binary,status),
  enqueueActionTransition(x.db,checkId,1,'approved',time,status),
  x.db.prepare('UPDATE http_checks SET last_status=?,last_effective_status=?,last_scheduled_at=?,last_effective_scheduled_at=?,last_result_at=? WHERE id=? AND EXISTS (SELECT 1 FROM http_check_results WHERE check_id=? AND config_version=1 AND scheduled_at=? AND effective_status=?)').bind(binary,status,time,time,time,checkId,checkId,time,status),
  x.db.prepare("UPDATE automation_transition_state SET status=?,generation=generation+1 WHERE check_id=? AND EXISTS (SELECT 1 FROM http_checks WHERE id=? AND last_scheduled_at=?)").bind(status,checkId,checkId,time),
 ])
}

test('isolated editor mutation rolls back cleanly when a monitor link races into existence',async()=>{
 const x=await setup()
 const testActor={id:'issue14-preview-editor-actor',email:'preview-editor@automation.invalid',version:1}
 x.local.db.prepare("INSERT INTO users (id,issuer,subject,email,role) VALUES (?,?,?,?,?)").run(testActor.id,'https://preview-editor.invalid','fixture',testActor.email,'admin')
 x.local.db.prepare('DELETE FROM worker_action_checks WHERE action_id=?').run(x.action.id)
 x.local.db.prepare('DELETE FROM monitor_action_revisions').run()
 x.local.db.prepare("UPDATE audit_events SET actor_email=? WHERE entity_type='action' AND entity_id=? AND action='create'").run(testActor.email,x.action.id)
 let raced=false
 const racingDb={prepare:x.db.prepare.bind(x.db),async batch(statements:D1PreparedStatement[]){
  if(!raced){raced=true;x.local.db.prepare('INSERT INTO worker_action_checks (action_id,check_id) VALUES (?,?)').run(x.action.id,checkId)}
  return x.db.batch(statements)
 }} as D1Database
 const input={...x.actionBody,name:'Editor update',checkIds:[],checkSnapshots:[],version:x.action.version}
 await assert.rejects(actionApi(request('PATCH',input),{...x.env,DB:racingDb},testActor,`/admin/actions/${x.action.id}`),(error:unknown)=>error instanceof ActionError&&error.status===409)
 assert.equal(raced,true)
 assert.equal((x.local.db.prepare('SELECT COUNT(*) AS n FROM monitor_action_revisions').get() as {n:number}).n,0)
 assert.deepEqual({...x.local.db.prepare('SELECT name,version FROM worker_actions WHERE id=?').get(x.action.id)},{name:'Action',version:1})
 assert.equal((x.local.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE entity_type='action' AND action='update'").get() as {n:number}).n,0)
})

test('actions use saved scoped credentials at an approved HTTPS target',async()=>{
 const x=await setup()
 const list=await (await actionApi(request('GET'),x.env,actor,'/admin/actions')).json()
 assert.doesNotMatch(JSON.stringify(list),/fixture-token|action.example/)
 await queue(x,'degraded')
 await Promise.all([flushActions(x.env),flushActions(x.env)])
 assert.equal(x.calls.length,1)
 assert.equal((x.calls[0]!.init.headers as Record<string,string>).Authorization,'Bearer fixture-token-one')
 assert.ok((x.calls[0]!.init.headers as Record<string,string>)['Idempotency-Key'])
 assert.equal(x.calls[0]!.init.redirect,'manual')
 assert.equal(JSON.parse(String(x.calls[0]!.init.body)).status,'degraded')
 assert.doesNotMatch(String(x.calls[0]!.init.body),/fixture-token/)
 const job=x.local.db.prepare('SELECT state FROM worker_action_outbox').get() as {state:string}
 assert.equal(job.state,'completed')
 const audit=x.local.db.prepare("SELECT details FROM audit_events WHERE entity_type='action'").all()
 assert.doesNotMatch(JSON.stringify(audit),/fixture-token|private response/)
})

test('isolated preview action fails closed without any outbound request',async()=>{
 const x=await setup()
 const env=issue14PreviewEnvironment({...x.env, API_SCOPE:'operations',PREVIEW_SUBSCRIBER_REQUIRED:'true',PREVIEW_SUBSCRIBER_SCOPE:'737597c9ba1d3cc17826ea2f2b48a9d259e03dbf1acd241dc62d886da5c20511',PREVIEW_RELEASE:'a'.repeat(40)}) as ActionEnvironment
 await actionApi(request('PATCH',{...x.actionBody,endpointId:'issue14-isolated-sink',version:x.action.version}),env,actor,`/admin/actions/${x.action.id}`)
 await queue(x)
 let externalCalls=0
 const originalFetch=globalThis.fetch
 globalThis.fetch=(async()=>{externalCalls++;throw new Error('network request forbidden')}) as typeof fetch
 try { await flushActions(env) } finally { globalThis.fetch=originalFetch }
 assert.equal(externalCalls,0)
 assert.equal(x.calls.length,0)
 assert.equal((x.local.db.prepare('SELECT state FROM worker_action_outbox').get() as {state:string}).state,'unavailable')
})

test('action saves atomically fence the selected monitor identity and check version',async()=>{
 for(const method of ['POST','PATCH'] as const) for(const change of ['move','version'] as const) {
  const x=await setup()
  const choices=await (await actionApi(request('GET'),x.env,actor,'/admin/actions/checks')).json() as {id:string;componentId:string;configVersion:number}[]
  assert.deepEqual(choices.map(({id,componentId,configVersion})=>({id,componentId,configVersion})),x.actionBody.checkSnapshots)
  x.local.db.prepare("INSERT INTO components (id,name,updated_at) VALUES ('other','Other',0)").run()
  const auditBefore=x.local.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE entity_type='action'").get() as {n:number}
  let changed=false
  const racingDb={prepare:x.db.prepare.bind(x.db), async batch(statements:D1PreparedStatement[]) {
   if(!changed) {
    changed=true
    if(change==='move') x.local.db.prepare("UPDATE http_checks SET component_id='other' WHERE id=?").run(checkId)
    else x.local.db.prepare('UPDATE http_checks SET config_version=config_version+1 WHERE id=?').run(checkId)
   }
   return x.db.batch(statements)
  }} as D1Database
  const input={...x.actionBody,name:'Changed',...(method==='PATCH'?{version:x.action.version}:{})}
  await assert.rejects(actionApi(request(method,input),{...x.env,DB:racingDb},actor,method==='PATCH'?`/admin/actions/${x.action.id}`:'/admin/actions'),(e:unknown)=>e instanceof ActionError&&e.status===409)
  assert.equal(changed,true)
  assert.deepEqual({...x.local.db.prepare('SELECT name,version FROM worker_actions WHERE id=?').get(x.action.id)},{name:'Action',version:1})
  assert.equal((x.local.db.prepare('SELECT COUNT(*) AS n FROM worker_actions').get() as {n:number}).n,1)
  assert.equal((x.local.db.prepare('SELECT COUNT(*) AS n FROM worker_action_checks WHERE action_id=? AND check_id=?').get(x.action.id,checkId) as {n:number}).n,1)
  assert.equal((x.local.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE entity_type='action'").get() as {n:number}).n,auditBefore.n)
 }
})

test('actions fail closed after configuration drift, key loss, rotation or deletion without leaking secrets',async()=>{
 const x=await setup()
 await assert.rejects(actionApi(request('POST',{...x.actionBody,name:'invalid',endpointId:'other'}),x.env,actor,'/admin/actions'),(e:unknown)=>e instanceof ActionError&&e.status===400)
 await assert.rejects(actionApi(request('POST',x.actionBody),{...x.env,ACTIONS_READY:'false'},actor,'/admin/actions'),(e:unknown)=>e instanceof ActionError&&e.status===503)
 await queue(x)
 await flushActions({...x.env,ACTION_ENDPOINTS:destinations.replace('/run','/changed')})
 assert.equal(x.calls.length,0)
 assert.equal((x.local.db.prepare('SELECT state FROM worker_action_outbox').get() as {state:string}).state,'unavailable')
 x.local.db.prepare('DELETE FROM worker_action_outbox').run()
 await vaultApi(request('PATCH',{version:1,value:'fixture-token-two'}),x.db,key,actor,`/admin/vaults/${x.vault.id}/secrets/${x.secret.id}`)
 await queue(x,'down',101);await flushActions(x.env)
 assert.equal((x.calls[0]!.init.headers as Record<string,string>).Authorization,'Bearer fixture-token-two')
 x.local.db.prepare('DELETE FROM worker_action_outbox').run()
 await vaultApi(request('DELETE',{version:2}),x.db,key,actor,`/admin/vaults/${x.vault.id}/secrets/${x.secret.id}`)
 await queue(x,'down',102);await flushActions(x.env)
 assert.equal(x.calls.length,1)
 assert.equal((x.local.db.prepare('SELECT state FROM worker_action_outbox').get() as {state:string}).state,'unavailable')
})

test('crashes, ambiguous responses and stale jobs never cause automatic re-execution',async()=>{
 const x=await setup()
 await queue(x); x.local.db.prepare("UPDATE worker_action_outbox SET state='executing',claimed_at=?").run(Date.now()-31_000)
 await flushActions(x.env);await flushActions(x.env)
 assert.equal(x.calls.length,0)
 assert.equal((x.local.db.prepare('SELECT state FROM worker_action_outbox').get() as {state:string}).state,'uncertain')
 x.local.db.prepare('DELETE FROM worker_action_outbox').run();await queue(x,'down',101);x.setStatus(500)
 await flushActions(x.env);await flushActions(x.env)
 assert.equal(x.calls.length,1)
 assert.equal((x.local.db.prepare('SELECT state FROM worker_action_outbox').get() as {state:string}).state,'uncertain')
 x.local.db.prepare('DELETE FROM worker_action_outbox').run();await queue(x,'down',102)
 x.local.db.prepare('UPDATE http_checks SET config_version=2 WHERE id=?').run(checkId)
 await flushActions(x.env);assert.equal(x.calls.length,1)
 assert.equal((x.local.db.prepare('SELECT state FROM worker_action_outbox').get() as {state:string}).state,'unavailable')
})

test('an expired or superseded action claim cannot transmit after slow resolution',async()=>{
 for(const reason of ['claim','age'] as const) {
  const x=await setup();await queue(x)
  const db={...x.db,batch:x.db.batch.bind(x.db),prepare(sql:string){
   if(sql.includes('SELECT MAX(o.created_at,o.due_at) AS createdAt,')) {
    if(reason==='claim') x.local.db.prepare("UPDATE worker_action_outbox SET state='uncertain'").run()
    else x.local.db.prepare('UPDATE worker_action_outbox SET created_at=?').run(Date.now()-3_600_001)
   }
   return x.db.prepare(sql)
  }} as D1Database
  await flushActions({...x.env,DB:db})
  assert.equal(x.calls.length,0)
  assert.equal((x.local.db.prepare('SELECT state FROM worker_action_outbox').get() as {state:string}).state,reason==='claim'?'uncertain':'pending')
  if(reason==='age') {
   await flushActions(x.env)
   assert.equal((x.local.db.prepare('SELECT state FROM worker_action_outbox').get() as {state:string}).state,'unavailable')
  }
 }
})

test('action jobs that expire after selection cannot be claimed',async()=>{
 const x=await setup();await queue(x)
 const realNow=Date.now;let now=realNow(),selected=0
 x.local.db.prepare('UPDATE worker_action_outbox SET created_at=?').run(now-3_599_000)
 try {
  Date.now=()=>now
  const db={prepare(sql:string){
   const statement=x.db.prepare(sql)
   if(!sql.includes('SELECT o.id,o.action_id,o.action_version,o.check_id')) return statement
   return {bind(...values:unknown[]){statement.bind(...values);return this},async all(){
    const result=await statement.all();selected=result.results.length;now+=2_000;return result
   }} as D1PreparedStatement
  },batch:x.db.batch.bind(x.db)} as D1Database
  await flushActions({...x.env,DB:db})
  assert.equal(selected,1)
  assert.equal(x.calls.length,0)
  assert.equal((x.local.db.prepare('SELECT state FROM worker_action_outbox').get() as {state:string}).state,'unavailable')
 } finally {Date.now=realNow}
})

test('an action does not send if the final claim query crosses its deadline',async()=>{
 const x=await setup();await queue(x)
 const realNow=Date.now;let now=realNow()
 try {
  Date.now=()=>now
  const db={...x.db,batch:x.db.batch.bind(x.db),prepare(sql:string){
   const statement=x.db.prepare(sql)
   if(!sql.includes('SELECT MAX(o.created_at,o.due_at) AS createdAt,')) return statement
   return {bind(...values:unknown[]){statement.bind(...values);return this},async first(){const result=await statement.first();now+=31_000;return result}} as D1PreparedStatement
  }} as D1Database
  await flushActions({...x.env,DB:db})
  assert.equal(x.calls.length,0)
 } finally {Date.now=realNow}
})

test('an action defers when a scheduled maintenance window starts during its final query',async()=>{
 const x=await setup();await queue(x)
 const realNow=Date.now;let now=realNow()
 x.local.db.prepare("INSERT INTO maintenance (id,name,starts_at,ends_at,created_at,updated_at) VALUES ('m','window',?,?,?,?)").run(now+1_000,now+60_000,now,now)
 try {
  Date.now=()=>now
  const db={...x.db,batch:x.db.batch.bind(x.db),prepare(sql:string){
   const statement=x.db.prepare(sql)
   if(!sql.includes('SELECT MAX(o.created_at,o.due_at) AS createdAt,')) return statement
   return {bind(...values:unknown[]){statement.bind(...values);return this},async first(){const result=await statement.first();now+=2_000;return result}} as D1PreparedStatement
  }} as D1Database
  await flushActions({...x.env,DB:db})
  assert.equal(x.calls.length,0)
  assert.equal((x.local.db.prepare('SELECT state FROM worker_action_outbox').get() as {state:string}).state,'pending')
 } finally {Date.now=realNow}
})

test('revoked administrators cannot create actions and competing discarded results do not enqueue',async()=>{
 const x=await setup()
 await assert.rejects(actionApi(request('POST',{...x.actionBody,name:'revoked'}),x.env,{...actor,version:0},'/admin/actions'))
 assert.equal((x.local.db.prepare("SELECT COUNT(*) AS n FROM worker_actions WHERE name='revoked'").get() as {n:number}).n,0)
 await x.db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,effective_status,http_status,latency_ms) VALUES (?,1,100,100,'up','up',200,4)").bind(checkId).run()
 await queue(x,'down')
 assert.equal((x.local.db.prepare('SELECT COUNT(*) AS n FROM worker_action_outbox').get() as {n:number}).n,0)
})

test('action trigger filters, readiness and credentials fail closed',async()=>{
 const x=await setup()
 const updated={...x.actionBody,triggerStatus:'down',version:1}
 await actionApi(request('PATCH',updated),x.env,actor,`/admin/actions/${x.action.id}`)
 await queue(x,'degraded');await flushActions(x.env)
 assert.equal(x.calls.length,0)
 assert.equal((x.local.db.prepare('SELECT COUNT(*) AS n FROM worker_action_outbox').get() as {n:number}).n,0)
 await queue(x,'down',101);await flushActions({...x.env,ACTIONS_READY:'false'});assert.equal(x.calls.length,0)
 await flushActions({...x.env,VAULT_ENCRYPTION_KEY:'bb'.repeat(32)});assert.equal(x.calls.length,0)
 assert.equal((x.local.db.prepare('SELECT state FROM worker_action_outbox').get() as {state:string}).state,'unavailable')
})

test('an action response with a stalled cancellation cannot hang dispatch',async()=>{
 const x=await setup();await queue(x)
 const env={...x.env,ACTION:{fetch:async()=>new Response(new ReadableStream({cancel:()=>new Promise(()=>{})}),{status:200})}}
 assert.equal(await Promise.race([flushActions(env).then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),100))]),true)
 assert.equal((x.local.db.prepare('SELECT state FROM worker_action_outbox').get() as {state:string}).state,'completed')
})

test('Workerd D1 concurrently dispatches a transition at most once', {skip:!process.env['USE_WORKERS_D1']}, async()=>{
 const {Miniflare,convertV4MiniflareOptions}=await import('miniflare')
 const runtime=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response()}}',d1Databases:['DB']}))
 try {
  const db=await runtime.getD1Database('DB') as D1Database
  for(const file of ['0001_board.sql','0002_checks.sql','0003_endpoint_registry.sql','0005_gatus_sources.sql','0006_advanced_http.sql','0008_vault.sql','0009_monitor_auth.sql','0009_actions.sql','0009_channels.sql','0010_monitor_alert_links.sql','0010_notification_transition_state.sql','0011_email_channels.sql','0012_notification_delivery_state.sql','0013_notification_unlink_cancel.sql','0017_monitor_action_links.sql']) {
   const sql=readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8').replace(/^\s*--[^\n]*$/gm,'')
   const parts=sql.split(/(?=CREATE TRIGGER |DROP TRIGGER )/),statements=parts.shift()!.split(';').map(s=>s.trim()).filter(Boolean)
   statements.push(...parts.map(s=>s.trim()).filter(Boolean));await db.batch(statements.map(s=>db.prepare(s)))
  }
  await db.batch([
   db.prepare("INSERT INTO users (id,issuer,subject,email,role) VALUES ('admin','issuer','subject','admin@example.test','admin')"),
   db.prepare("INSERT INTO components (id,name,updated_at) VALUES ('component','Service',0)"),
   db.prepare("INSERT INTO endpoint_registry VALUES ('check','approved')"),
   db.prepare("INSERT INTO http_checks (id,component_id,endpoint_id,enabled,interval_minutes,expected_status,last_status,last_scheduled_at) VALUES (?,'component','check',1,1,200,'up',1)").bind(checkId),
      db.prepare("INSERT INTO automation_transition_state (check_id,check_version,status) VALUES (?,1,'up')").bind(checkId),
  ])
  let calls=0
  const env={DB:db,ACTIONS_READY:'true',ACTION_ENDPOINTS:destinations,VAULT_ENCRYPTION_KEY:key,ACTION:{fetch:async()=>{calls++;return new Response(null,{status:204})}}} satisfies ActionEnvironment
  const vault=await (await vaultApi(request('POST',{name:'fixture'}),db,key,actor,'/admin/vaults')).json() as {id:number}
  const secret=await (await vaultApi(request('POST',{name:'token',type:'value',value:'fixture-token'}),db,key,actor,`/admin/vaults/${vault.id}/secrets`)).json() as {id:number}
  const action=await (await actionApi(request('POST',{name:'Action',endpointId:'approved',vaultId:vault.id,secretId:secret.id,enabled:true,checkIds:[checkId],checkSnapshots:[{id:checkId,componentId:'component',configVersion:1}],triggerStatus:'down'}),env,actor,'/admin/actions')).json() as {id:string}
  await db.prepare("INSERT INTO monitor_action_links (id,component_id,action_id,on_status,delay_minutes,cooldown_minutes) VALUES ('link','component',?,'down',0,30)").bind(action.id).run()
  async function save(){return db.batch([
   db.prepare("INSERT OR IGNORE INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,effective_status,http_status,latency_ms) VALUES (?,1,100,100,'down','down',500,4)").bind(checkId),
   enqueueActionTransition(db,checkId,1,'approved',100,'down'),
   db.prepare("UPDATE http_checks SET last_status='down',last_scheduled_at=100,last_result_at=100 WHERE id=? AND (last_scheduled_at IS NULL OR last_scheduled_at<100)").bind(checkId),
   db.prepare("UPDATE automation_transition_state SET status='down',generation=generation+1 WHERE check_id=? AND status<>'down'").bind(checkId),
  ])}
  await Promise.all([save(),save()]);await Promise.all([flushActions(env),flushActions(env)])
  assert.equal(calls,1)
  assert.equal((await db.prepare('SELECT state FROM worker_action_outbox').first<{state:string}>())?.state,'completed')
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM monitor_action_cooldowns').first<{n:number}>())?.n,1)
  // A newer transition must wait while another job still owns the cooldown.
  const claimAt=Date.now()
  await db.batch([
   db.prepare('DELETE FROM worker_action_outbox'),
   db.prepare('DELETE FROM monitor_action_cooldowns'),
   db.prepare(`INSERT INTO worker_action_outbox (id,action_id,action_version,check_id,check_version,scheduled_at,status,state,claimed_at,created_at,updated_at,transition_generation,link_id,cooldown_minutes) VALUES ('old',?,1,?,1,100,'down','executing',?,?,?,1,'link',30)`).bind(action.id,checkId,claimAt,claimAt,claimAt),
   db.prepare("INSERT INTO monitor_action_cooldowns (component_id,action_id,on_status,claimed_at,reservation_id) VALUES ('component',?,'down',?,'old')").bind(action.id,claimAt),
   db.prepare("UPDATE automation_transition_state SET status='up',generation=generation+1 WHERE check_id=?").bind(checkId),
   db.prepare("UPDATE http_checks SET last_status='up' WHERE id=?").bind(checkId),
  ])
  await db.batch([
   db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,effective_status,http_status,latency_ms) VALUES (?,1,101,101,'down','down',500,4)").bind(checkId),
   enqueueActionTransition(db,checkId,1,'approved',101,'down'),
   db.prepare("UPDATE http_checks SET last_status='down',last_scheduled_at=101,last_result_at=101 WHERE id=?").bind(checkId),
   db.prepare("UPDATE automation_transition_state SET status='down',generation=generation+1 WHERE check_id=?").bind(checkId),
  ])
  await Promise.all([flushActions(env),flushActions(env)])
  assert.equal((await db.prepare('SELECT state FROM worker_action_outbox WHERE scheduled_at=101').first<{state:string}>())?.state,'pending')
  await db.batch([db.prepare("UPDATE worker_action_outbox SET state='unavailable' WHERE id='old'"),db.prepare("DELETE FROM monitor_action_cooldowns WHERE reservation_id='old'")])
  await Promise.all([flushActions(env),flushActions(env)])
  assert.equal(calls,2)
  assert.equal((await db.prepare('SELECT state FROM worker_action_outbox WHERE scheduled_at=101').first<{state:string}>())?.state,'completed')
 } finally {await runtime.dispose()}
})

test('invalid Bearer token characters never reach an action destination',async()=>{
 const x=await setup()
 await vaultApi(request('PATCH',{version:1,value:'not a bearer token'}),x.db,key,actor,`/admin/vaults/${x.vault.id}/secrets/${x.secret.id}`)
 await queue(x);await flushActions(x.env)
 assert.equal(x.calls.length,0)
 assert.equal((x.local.db.prepare('SELECT state FROM worker_action_outbox').get() as {state:string}).state,'unavailable')
})

test('the first healthy observation after a credential fault cannot enqueue a false action',async()=>{
 const x=await setup()
 x.local.db.prepare("UPDATE http_checks SET last_status='down',transition_suppressed=1 WHERE id=?").run(checkId)
 await x.db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,effective_status,http_status,latency_ms) VALUES (?,1,100,100,'up','up',200,4)").bind(checkId).run()
 await enqueueActionTransition(x.db,checkId,1,'approved',100,'up').run()
 assert.equal((x.local.db.prepare('SELECT COUNT(*) AS n FROM worker_action_outbox').get() as {n:number}).n,0)
})

test('pending actions wait for post-maintenance observation and do not expire during long windows',async()=>{
 const x=await setup(), now=Date.now(), scheduled=now-7_200_000
 await queue(x,'down',scheduled)
 x.local.db.prepare("UPDATE worker_action_outbox SET created_at=?").run(scheduled)
 x.local.db.prepare("INSERT INTO maintenance (id,name,starts_at,ends_at,created_at,updated_at) VALUES ('m','window',?,?,?,?)").run(now-120_000,now+60_000,now,now)
 await flushActions(x.env);assert.equal(x.calls.length,0)
 assert.equal((x.local.db.prepare('SELECT state FROM worker_action_outbox').get() as {state:string}).state,'pending')
 x.local.db.prepare("UPDATE maintenance SET ends_at=? WHERE id='m'").run(now-1)
 await flushActions(x.env);assert.equal(x.calls.length,0)
 x.local.db.prepare('UPDATE http_checks SET last_scheduled_at=?,last_result_at=? WHERE id=?').run(now,now,checkId)
 await flushActions(x.env);assert.equal(x.calls.length,1)
 assert.equal((x.local.db.prepare('SELECT state FROM worker_action_outbox').get() as {state:string}).state,'completed')
})

test('post-window recovery supersedes an unclaimed outage action',async()=>{
 const x=await setup(), now=Date.now(), scheduled=now-180_000
 await queue(x,'down',scheduled)
 x.local.db.prepare("INSERT INTO maintenance (id,name,starts_at,ends_at,created_at,updated_at) VALUES ('m','window',?,?,?,?)").run(now-120_000,now-60_000,now,now)
 x.local.db.prepare("UPDATE http_checks SET last_status='up',last_effective_status='up',last_scheduled_at=?,last_effective_scheduled_at=?,last_result_at=? WHERE id=?").run(now,now,now,checkId)
 await flushActions(x.env);assert.equal(x.calls.length,0)
 assert.equal((x.local.db.prepare('SELECT state FROM worker_action_outbox').get() as {state:string}).state,'unavailable')
})

test('a window starting after an action claim defers it before network transmission',async()=>{
 const x=await setup(), now=Date.now();await queue(x)
 let inserted=false
 const db={batch:x.db.batch.bind(x.db),prepare(sql:string) {
  if(!inserted && sql.includes('SELECT 1 FROM worker_action_outbox o JOIN http_checks')) {
   inserted=true;x.local.db.prepare("INSERT INTO maintenance (id,name,starts_at,ends_at,created_at,updated_at) VALUES ('m','window',?,?,?,?)").run(now-1000,now+60_000,now,now)
  }
  return x.db.prepare(sql)
 }} as D1Database
 await flushActions({...x.env,DB:db})
 assert.equal(x.calls.length,0)
 assert.deepEqual({...x.local.db.prepare('SELECT state,claimed_at FROM worker_action_outbox').get()},{state:'pending',claimed_at:null})
})

test('a credential fault after maintenance holds a pending action until a valid observation',async()=>{
 const x=await setup(), now=Date.now(), scheduled=now-180_000
 await queue(x,'down',scheduled)
 x.local.db.prepare("INSERT INTO maintenance (id,name,starts_at,ends_at,created_at,updated_at) VALUES ('m','window',?,?,?,?)").run(now-120_000,now-60_000,now,now)
 x.local.db.prepare("UPDATE http_checks SET last_status='down',last_effective_status='down',last_scheduled_at=?,last_effective_scheduled_at=?,transition_suppressed=1 WHERE id=?").run(now,now,checkId)
 await flushActions(x.env);assert.equal(x.calls.length,0)
 assert.equal((x.local.db.prepare('SELECT state FROM worker_action_outbox').get() as {state:string}).state,'pending')
 x.local.db.prepare('UPDATE http_checks SET transition_suppressed=0,last_scheduled_at=?,last_effective_scheduled_at=?,last_result_at=? WHERE id=?').run(now+1,now+1,now+1,checkId)
 await flushActions(x.env);assert.equal(x.calls.length,1)
})

test('a credential fault after an action claim defers it before transmission',async()=>{
 const x=await setup();await queue(x)
 let marked=false
 const db={batch:x.db.batch.bind(x.db),prepare(sql:string) {
  if(!marked && sql.includes('SELECT 1 FROM worker_action_outbox o JOIN http_checks')) {
   marked=true;x.local.db.prepare('UPDATE http_checks SET transition_suppressed=1 WHERE id=?').run(checkId)
  }
  return x.db.prepare(sql)
 }} as D1Database
 await flushActions({...x.env,DB:db})
 assert.equal(x.calls.length,0)
 assert.equal((x.local.db.prepare('SELECT state FROM worker_action_outbox').get() as {state:string}).state,'pending')
})

test('an old action cannot run after down-up-down transitions during unavailable delivery',async()=>{
 const x=await setup();await queue(x,'down',100)
 x.local.db.prepare("UPDATE automation_transition_state SET status='up',generation=generation+1 WHERE check_id=?").run(checkId)
 x.local.db.prepare("UPDATE automation_transition_state SET status='down',generation=generation+1 WHERE check_id=?").run(checkId)
 x.local.db.prepare("UPDATE http_checks SET last_status='down',last_effective_status='down',last_scheduled_at=300,last_effective_scheduled_at=300,last_result_at=300 WHERE id=?").run(checkId)
 await flushActions(x.env)
 assert.equal(x.calls.length,0)
 assert.equal((x.local.db.prepare('SELECT state FROM worker_action_outbox').get() as {state:string}).state,'unavailable')
})

test('action enqueue uses actual completion time at maintenance boundaries',async()=>{
 const x=await setup()
 x.local.db.prepare("INSERT INTO maintenance (id,name,starts_at,ends_at,created_at,updated_at) VALUES ('m','window',100,200,1,1)").run()
 await x.db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,effective_status,http_status,latency_ms) VALUES (?,1,90,150,'down','down',500,4)").bind(checkId).run()
 await enqueueActionTransition(x.db,checkId,1,'approved',90,'down',150).run()
 assert.equal((x.local.db.prepare('SELECT COUNT(*) AS n FROM worker_action_outbox').get() as {n:number}).n,0)
 await x.db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,effective_status,http_status,latency_ms) VALUES (?,1,120,210,'down','down',500,4)").bind(checkId).run()
 await enqueueActionTransition(x.db,checkId,1,'approved',120,'down',210).run()
 assert.equal((x.local.db.prepare('SELECT COUNT(*) AS n FROM worker_action_outbox').get() as {n:number}).n,1)
})

test('first valid outage after a credential fault compares against the last valid baseline',async()=>{
 const x=await setup()
 x.local.db.prepare("UPDATE http_checks SET last_status='down',transition_suppressed=1 WHERE id=?").run(checkId)
 await x.db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,effective_status,http_status,latency_ms) VALUES (?,1,100,100,'down','down',500,4)").bind(checkId).run()
 await enqueueActionTransition(x.db,checkId,1,'approved',100,'down').run()
 assert.equal((x.local.db.prepare('SELECT COUNT(*) AS n FROM worker_action_outbox').get() as {n:number}).n,1)
})

test('transition-state migration excludes results from overlapping maintenance windows',()=>{
 for(const targeted of [false,true]) {
  const db=new DatabaseSync(':memory:')
  for(const file of ['0001_board.sql','0002_checks.sql','0003_endpoint_registry.sql','0006_advanced_http.sql','0009_monitor_auth.sql','0009_channels.sql','0009_actions.sql']) db.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'))
  const now=Date.now()
  db.prepare("INSERT INTO components (id,name,updated_at) VALUES ('component','Service',0)").run()
  db.prepare("INSERT INTO http_checks (id,component_id,endpoint_id,enabled,interval_minutes,expected_status,last_status,last_scheduled_at,last_result_at) VALUES (?,'component','check',1,1,200,'down',?,?)").run(checkId,now-10_000,now-10_000)
  db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,http_status,latency_ms) VALUES (?,1,?,?,'up',200,1)").run(checkId,now-180_000,now-180_000)
  db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,http_status,latency_ms) VALUES (?,1,?,?,'down',500,1)").run(checkId,now-90_000,now-90_000)
  db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,http_status,latency_ms) VALUES (?,1,?,?,'down',500,1)").run(checkId,now-10_000,now-10_000)
  db.prepare("INSERT INTO maintenance (id,name,starts_at,ends_at,created_at,updated_at) VALUES ('m1','earlier',?,?,?,?),('m2','active',?,?,?,?)").run(now-120_000,now-60_000,now,now,now-30_000,now+60_000,now,now)
  if(targeted) {db.prepare("INSERT INTO maintenance_components VALUES ('m1','component'),('m2','component')").run()}
  db.exec(readFileSync(new URL('../migrations/0010_notification_transition_state.sql',import.meta.url),'utf8'))
  assert.equal(db.prepare('SELECT status FROM automation_transition_state WHERE check_id=?').get(checkId)?.status,'up')
  db.close()
 }
})

test('a transition after the action claim prevents a stale action before transmission',async()=>{
 const x=await setup();await queue(x)
 let changed=false
 const db={batch:x.db.batch.bind(x.db),prepare(sql:string) {
  if(!changed && sql.includes('FROM worker_action_outbox o JOIN http_checks') && sql.includes('JOIN vault_secrets v')) {
   changed=true;x.local.db.prepare("UPDATE automation_transition_state SET generation=generation+1,status='up' WHERE check_id=?").run(checkId)
  }
  return x.db.prepare(sql)
 }} as D1Database
 await flushActions({...x.env,DB:db});assert.equal(x.calls.length,0)
 assert.equal((x.local.db.prepare('SELECT state FROM worker_action_outbox').get() as {state:string}).state,'pending')
 await flushActions(x.env);assert.equal(x.calls.length,0)
 assert.equal((x.local.db.prepare('SELECT state FROM worker_action_outbox').get() as {state:string}).state,'unavailable')
})

test('generation migration fails old pending work closed while preserving claimed action uncertainty',()=>{
 const db=new DatabaseSync(':memory:')
 for(const file of ['0001_board.sql','0002_checks.sql','0003_endpoint_registry.sql','0006_advanced_http.sql','0009_monitor_auth.sql','0009_channels.sql','0009_actions.sql']) db.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'))
 db.prepare("INSERT INTO components (id,name,updated_at) VALUES ('component','Service',0)").run()
 db.prepare("INSERT INTO http_checks (id,component_id,endpoint_id,enabled,interval_minutes,expected_status,last_status,last_scheduled_at,last_result_at) VALUES (?,'component','check',1,1,200,'down',100,100)").run(checkId)
 db.prepare("INSERT INTO notification_channels (id,name,endpoint_id,endpoint_fingerprint,vault_id,secret_id,enabled,created_at,updated_at) VALUES ('c','Channel','endpoint','fingerprint',1,1,1,0,0)").run()
 db.prepare("INSERT INTO worker_actions (id,name,endpoint_id,endpoint_fingerprint,vault_id,secret_id,enabled,trigger_status,created_at,updated_at) VALUES ('a','Action','endpoint','fingerprint',1,1,1,'all',0,0)").run()
 db.prepare("INSERT INTO notification_outbox (id,channel_id,channel_version,check_id,check_version,scheduled_at,status,state,attempts,created_at,updated_at) VALUES ('n1','c',1,?,1,100,'down','pending',0,0,0),('n2','c',1,?,1,101,'up','sending',1,0,0)").run(checkId,checkId)
 db.prepare("INSERT INTO worker_action_outbox (id,action_id,action_version,check_id,check_version,scheduled_at,status,state,created_at,updated_at) VALUES ('a1','a',1,?,1,100,'down','pending',0,0),('a2','a',1,?,1,101,'up','executing',0,0)").run(checkId,checkId)
 db.exec(readFileSync(new URL('../migrations/0010_notification_transition_state.sql',import.meta.url),'utf8'))
 assert.deepEqual(db.prepare('SELECT state FROM notification_outbox ORDER BY id').all().map(row=>row.state),['failed','failed'])
 assert.deepEqual(db.prepare('SELECT state FROM worker_action_outbox ORDER BY id').all().map(row=>row.state),['unavailable','uncertain'])
 db.close()
})

test('maintenance beginning during action preflight holds an in-window status change',async()=>{
 const x=await setup(), now=Date.now();await queue(x,'down',now-120_000)
 let inserted=false
 const db={batch:x.db.batch.bind(x.db),prepare(sql:string) {
  if(!inserted && sql.includes('SELECT 1 AS present FROM worker_actions a JOIN')) {
   inserted=true;x.local.db.prepare("INSERT INTO maintenance (id,name,starts_at,ends_at,created_at,updated_at) VALUES ('m','window',?,?,?,?)").run(now-1000,now+60_000,now,now)
   x.local.db.prepare("UPDATE http_checks SET last_status='up',last_effective_status='up',last_scheduled_at=?,last_effective_scheduled_at=?,last_result_at=? WHERE id=?").run(now,now,now,checkId)
  }
  return x.db.prepare(sql)
 }} as D1Database
 await flushActions({...x.env,DB:db});assert.equal(x.calls.length,0)
 assert.equal((x.local.db.prepare('SELECT state FROM worker_action_outbox').get() as {state:string}).state,'pending')
})

test('action preflight refuses credentials rotated or deleted after resolution',async()=>{
 for(const change of ['rotate','delete','replace'] as const) {
  const x=await setup();await queue(x)
  let changed=false
  const db={batch:x.db.batch.bind(x.db),prepare(sql:string) {
   if(!changed && sql.includes('FROM worker_action_outbox o JOIN http_checks') && sql.includes('JOIN vault_secrets v')) {
    changed=true
    if(change==='delete') x.local.db.prepare('DELETE FROM vault_secrets WHERE id=?').run(x.secret.id)
    else if(change==='rotate') x.local.db.prepare('UPDATE vault_secrets SET version=version+1 WHERE id=?').run(x.secret.id)
    else x.local.db.prepare("UPDATE vault_secrets SET nonce='replacement' WHERE id=?").run(x.secret.id)
   }
   return x.db.prepare(sql)
  }} as D1Database
  await flushActions({...x.env,DB:db})
  assert.equal(x.calls.length,0,change)
  assert.equal((x.local.db.prepare('SELECT state FROM worker_action_outbox').get() as {state:string}).state,'pending',change)
 }
})

test('migration leaves the baseline unknown after repeated credential faults',()=>{
 const db=new DatabaseSync(':memory:')
 for(const file of ['0001_board.sql','0002_checks.sql','0003_endpoint_registry.sql','0006_advanced_http.sql','0009_monitor_auth.sql','0009_channels.sql','0009_actions.sql']) db.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'))
 db.prepare("INSERT INTO components (id,name,updated_at) VALUES ('component','Service',0)").run()
 db.prepare("INSERT INTO http_checks (id,component_id,endpoint_id,enabled,interval_minutes,expected_status,last_status,last_scheduled_at,last_result_at,transition_suppressed) VALUES (?,'component','check',1,1,200,'down',300,300,1)").run(checkId)
 db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,http_status,latency_ms) VALUES (?,1,100,100,'up',200,1),(?,1,200,200,'down',NULL,0),(?,1,300,300,'down',NULL,0)").run(checkId,checkId,checkId)
 db.exec(readFileSync(new URL('../migrations/0010_notification_transition_state.sql',import.meta.url),'utf8'))
 assert.equal(db.prepare('SELECT status FROM automation_transition_state WHERE check_id=?').get(checkId),undefined)
 db.close()
})

test('credential fault beginning during action preflight defers before invalidating old status',async()=>{
 const x=await setup();await queue(x,'down',Date.now()-120_000)
 let changed=false
 const db={batch:x.db.batch.bind(x.db),prepare(sql:string) {
  if(!changed && sql.includes('SELECT 1 AS present FROM worker_actions a JOIN')) {
   changed=true;x.local.db.prepare("UPDATE http_checks SET last_status='up',last_effective_status='up',last_scheduled_at=?,last_effective_scheduled_at=?,last_result_at=?,transition_suppressed=1 WHERE id=?").run(Date.now(),Date.now(),Date.now(),checkId)
  }
  return x.db.prepare(sql)
 }} as D1Database
 await flushActions({...x.env,DB:db});assert.equal(x.calls.length,0)
 assert.equal((x.local.db.prepare('SELECT state FROM worker_action_outbox').get() as {state:string}).state,'pending')
})

test('action no-op and rename retain the pending transition',async()=>{
 const x=await setup();await queue(x)
 const path=`/admin/actions/${x.action.id}`
 const noop=await actionApi(request('PATCH',{...x.actionBody,version:1}),x.env,actor,path)
 assert.equal((await noop.json() as {version:number}).version,1)
 const renamed=await actionApi(request('PATCH',{...x.actionBody,name:'Renamed',version:1}),x.env,actor,path)
 assert.equal((await renamed.json() as {version:number}).version,2)
 assert.deepEqual({...x.local.db.prepare('SELECT state,action_version FROM worker_action_outbox').get()},{state:'pending',action_version:2})
 await flushActions(x.env);assert.equal(x.calls.length,1)
 assert.equal(x.local.db.prepare('SELECT state FROM worker_action_outbox').get()?.state,'completed')
})

test('an old action editor must refresh; malformed monitor snapshots remain invalid',async()=>{
 const x=await setup(), legacy:Record<string,unknown>={...x.actionBody}
 delete legacy.checkSnapshots
 for(const method of ['POST','PATCH'] as const) {
  const route=method==='POST' ? '/admin/actions' : `/admin/actions/${x.action.id}`
  const input=method==='POST' ? {...legacy,name:'Second'} : {...legacy,version:1}
  await assert.rejects(actionApi(request(method,input),x.env,actor,route),(e:unknown)=>e instanceof ActionError && e.status===409 && /refresh/i.test(e.message))
  await assert.rejects(actionApi(request(method,{...input,checkSnapshots:null}),x.env,actor,route),(e:unknown)=>e instanceof ActionError && e.status===400)
 }
 assert.equal(x.local.db.prepare('SELECT COUNT(*) AS n FROM worker_actions').get()?.n,1)
 assert.equal(x.local.db.prepare('SELECT version FROM worker_actions WHERE id=?').get(x.action.id)?.version,1)
})

test('functional action edits do not carry pending transitions',async()=>{
 const x=await setup();await queue(x)
 await actionApi(request('PATCH',{...x.actionBody,triggerStatus:'up',version:1}),x.env,actor,`/admin/actions/${x.action.id}`)
 assert.equal(x.local.db.prepare('SELECT action_version FROM worker_action_outbox').get()?.action_version,1)
 await flushActions(x.env);assert.equal(x.calls.length,0)
})

test('concurrent action rename and functional edits have one version winner',async()=>{
 const x=await setup();await queue(x);const path=`/admin/actions/${x.action.id}`
 const results=await Promise.allSettled([
  actionApi(request('PATCH',{...x.actionBody,name:'Renamed',version:1}),x.env,actor,path),
  actionApi(request('PATCH',{...x.actionBody,triggerStatus:'up',version:1}),x.env,actor,path),
 ])
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1)
 const failure=results.find(result=>result.status==='rejected') as PromiseRejectedResult
 assert.ok(failure.reason instanceof ActionError && failure.reason.status===409)
 const row=x.local.db.prepare('SELECT name,version FROM worker_actions').get() as {name:string;version:number}
 assert.equal(row.version,2)
 assert.equal(x.local.db.prepare('SELECT action_version FROM worker_action_outbox').get()?.action_version,row.name==='Renamed'?2:1)
})

test('action rename during an in-flight send preserves its claim and never retries',async()=>{
 const x=await setup();await queue(x)
 let start!:()=>void,release!:()=>void,calls=0
 const started=new Promise<void>(resolve=>{start=resolve}),blocked=new Promise<void>(resolve=>{release=resolve})
 const env={...x.env,ACTION:{fetch:async()=>{calls++;start();await blocked;return new Response(null,{status:204})}}}
 const flushing=flushActions(env);await started
 await actionApi(request('PATCH',{...x.actionBody,name:'Renamed',version:1}),env,actor,`/admin/actions/${x.action.id}`)
 assert.deepEqual({...x.local.db.prepare('SELECT state,action_version FROM worker_action_outbox').get()},{state:'executing',action_version:2})
 release();await flushing;await flushActions(env)
 assert.equal(calls,1);assert.equal(x.local.db.prepare('SELECT state FROM worker_action_outbox').get()?.state,'completed')
})

test('action rename during claimed pre-send validation defers rather than discarding',async()=>{
 const x=await setup();await queue(x);let renamed=false
 const db={...x.db,batch:x.db.batch.bind(x.db),prepare(sql:string){
  const statement=x.db.prepare(sql)
  if(renamed || !sql.includes('SELECT id,endpoint_id,endpoint_fingerprint,enabled,version FROM worker_actions')) return statement
  return {bind(...values:unknown[]){statement.bind(...values);return this},async first(){
   renamed=true
   await actionApi(request('PATCH',{...x.actionBody,name:'Renamed',version:1}),x.env,actor,`/admin/actions/${x.action.id}`)
   return statement.first()
  }} as D1PreparedStatement
 }} as D1Database
 await flushActions({...x.env,DB:db})
 assert.deepEqual({...x.local.db.prepare('SELECT state,action_version FROM worker_action_outbox').get()},{state:'pending',action_version:2})
 assert.equal(x.calls.length,0)
 await flushActions(x.env);assert.equal(x.calls.length,1)
})

const monitorId='00000000-0000-4000-8000-000000000002'
async function monitorFixture() {
 const x=await setup()
 x.local.db.prepare('INSERT INTO components (id,name,updated_at) VALUES (?,\'Another\',0)').run(monitorId)
 x.local.db.prepare('UPDATE http_checks SET component_id=? WHERE id=?').run(monitorId,checkId)
 const route=`/admin/actions/monitor/${monitorId}`
 const get=async()=>await (await actionApi(request('GET'),x.env,actor,route)).json() as {links:{actionId:string;onStatus:'up'|'down';delayMinutes:number;cooldownMinutes:number}[];version:number}
 const put=async(links:unknown,version:number)=>actionApi(request('PUT',{links,version}),x.env,actor,route)
 return {...x,route,get,put}
}

test('monitor action links round trip, fence concurrent edits, validate duplicates and preserve degraded legacy links',async()=>{
 const x=await monitorFixture(), before=await x.get()
 assert.deepEqual(before.links.map(x=>x.onStatus),['down','up'])
 const link={actionId:x.action.id,onStatus:'down',delayMinutes:10,cooldownMinutes:30}
 await assert.rejects(x.put([link,link],before.version),(e:unknown)=>e instanceof ActionError&&e.status===400)
 await assert.rejects(actionApi(request('PUT',{links:[link],version:before.version}),x.env,{...actor,version:0},x.route),(e:unknown)=>e instanceof ActionError&&e.status===409)
 const saved=await (await x.put([link],before.version)).json() as Awaited<ReturnType<typeof x.get>>
 assert.deepEqual(saved.links,[link]);assert.equal(saved.version,1)
 assert.equal(x.local.db.prepare("SELECT COUNT(*) n FROM monitor_action_links WHERE on_status='degraded'").get()?.n,1)
 await assert.rejects(x.put([link],before.version),(e:unknown)=>e instanceof ActionError&&e.status===409)
 await queue(x,'degraded',100);await flushActions(x.env);assert.equal(x.calls.length,1)
})

test('monitor saves preserve unrelated degraded-only legacy actions',async()=>{
 const x=await monitorFixture()
 x.local.db.prepare("UPDATE worker_actions SET trigger_status='degraded' WHERE id=?").run(x.action.id)
 const before=await x.get();assert.deepEqual(before.links,[])
 await x.put([],before.version)
 assert.equal(x.local.db.prepare('SELECT COUNT(*) n FROM worker_action_checks WHERE action_id=?').get(x.action.id)?.n,1)
 await queue(x,'degraded');await flushActions(x.env);assert.equal(x.calls.length,1)
})

test('monitor actions wait for delay, cancel on recovery and enforce cooldown after delivery',async()=>{
 const x=await monitorFixture(), before=await x.get()
 const link={actionId:x.action.id,onStatus:'down',delayMinutes:2,cooldownMinutes:30}
 await x.put([link],before.version)
 const actual=Date.now;let now=actual()
 try {
  Date.now=()=>now
  await queue(x,'down',100);await flushActions(x.env);assert.equal(x.calls.length,0)
  now+=120_000;await flushActions(x.env);assert.equal(x.calls.length,1)
  await queue(x,'down',101);now+=120_000;await flushActions(x.env);assert.equal(x.calls.length,1)
  assert.equal(x.local.db.prepare('SELECT state FROM worker_action_outbox WHERE scheduled_at=101').get()?.state,'unavailable')
  now+=31*60_000;await queue(x,'down',102)
  x.local.db.prepare("UPDATE automation_transition_state SET status='up',generation=generation+1 WHERE check_id=?").run(checkId)
  x.local.db.prepare("UPDATE http_checks SET last_status='up',last_effective_status='up' WHERE id=?").run(checkId)
  now+=120_000;await flushActions(x.env);assert.equal(x.calls.length,1)
  assert.equal(x.local.db.prepare('SELECT state FROM worker_action_outbox WHERE scheduled_at=102').get()?.state,'unavailable')
 } finally {Date.now=actual}
})

test('a changed link invalidates a pending run and recovery links run on recovery',async()=>{
 const x=await monitorFixture(), before=await x.get()
 const down={actionId:x.action.id,onStatus:'down',delayMinutes:1,cooldownMinutes:0}
 const up={...down,onStatus:'up',delayMinutes:0}
 const saved=await (await x.put([down,up],before.version)).json() as {version:number}
 await queue(x,'down',100)
 await x.put([up],saved.version)
 x.local.db.prepare('UPDATE worker_action_outbox SET due_at=0').run()
 await flushActions(x.env);assert.equal(x.calls.length,0)
 x.local.db.prepare("UPDATE automation_transition_state SET status='down' WHERE check_id=?").run(checkId)
 await x.db.batch([
  x.db.prepare("INSERT INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,effective_status,http_status,latency_ms) VALUES (?,1,101,101,'up','up',200,4)").bind(checkId),
  enqueueActionTransition(x.db,checkId,1,'approved',101,'up'),
  x.db.prepare("UPDATE http_checks SET last_status='up',last_effective_status='up',last_scheduled_at=101,last_effective_scheduled_at=101 WHERE id=?").bind(checkId),
  x.db.prepare("UPDATE automation_transition_state SET status='up',generation=generation+1 WHERE check_id=?").bind(checkId),
 ])
 await flushActions(x.env);assert.equal(x.calls.length,1)
})

test('monitor link changes fence stale action editors and preserve unrelated scheduled links',async()=>{
 const x=await monitorFixture(), before=await x.get()
 const down={actionId:x.action.id,onStatus:'down',delayMinutes:1,cooldownMinutes:0}
 const up={...down,onStatus:'up',delayMinutes:2}
 const saved=await (await x.put([down,up],before.version)).json() as {version:number}
 const actionVersion=(await (await actionApi(request('GET'),x.env,actor,'/admin/actions')).json() as {id:string;version:number}[]).find(a=>a.id===x.action.id)!.version
 await queue(x,'down',100)
 const original=x.local.db.prepare('SELECT link_id FROM worker_action_outbox').get()?.link_id
 const changed=await (await x.put([down,{...up,delayMinutes:3}],saved.version)).json() as {version:number}
 assert.equal(x.local.db.prepare("SELECT id FROM monitor_action_links WHERE on_status='down'").get()?.id,original)
 const snapshot={id:checkId,componentId:monitorId,configVersion:1}
 await assert.rejects(actionApi(request('PATCH',{...x.actionBody,version:actionVersion,checkIds:[],checkSnapshots:[]}),x.env,actor,`/admin/actions/${x.action.id}`),(e:unknown)=>e instanceof ActionError&&e.status===409)
 assert.equal((await x.get()).links.length,2)
 const revision=(await x.get()).version
 await x.put([down,{...up,delayMinutes:3}],changed.version)
 assert.equal((await x.get()).version,revision)
 x.local.db.prepare('UPDATE worker_action_outbox SET due_at=0').run()
 await flushActions(x.env);assert.equal(x.calls.length,1)
 assert.equal(snapshot.componentId,monitorId)
})

test('a pre-send maintenance deferral releases its cooldown reservation',async()=>{
 const x=await monitorFixture(), before=await x.get()
 await x.put([{actionId:x.action.id,onStatus:'down',delayMinutes:0,cooldownMinutes:30}],before.version)
 await queue(x,'down',100)
 let inserted=false;const now=Date.now()
 const db={batch:x.db.batch.bind(x.db),prepare(sql:string) {
  if(!inserted && sql.includes('SELECT 1 FROM worker_action_outbox o JOIN http_checks')) {
   inserted=true;x.local.db.prepare("INSERT INTO maintenance (id,name,starts_at,ends_at,created_at,updated_at) VALUES ('m','window',?,?,?,?)").run(now-1000,now+60_000,now,now)
  }
  return x.db.prepare(sql)
 }} as D1Database
 await flushActions({...x.env,DB:db})
 assert.equal(x.calls.length,0)
 assert.equal(x.local.db.prepare('SELECT COUNT(*) n FROM monitor_action_cooldowns').get()?.n,0)
 assert.equal(x.local.db.prepare('SELECT state FROM worker_action_outbox').get()?.state,'pending')
 x.local.db.prepare('DELETE FROM maintenance').run()
 await flushActions(x.env);assert.equal(x.calls.length,1)
})

test('legacy pending work carries over when an unchanged policy is materialized',async()=>{
 const x=await monitorFixture(), before=await x.get()
 await queue(x,'down',100)
 assert.equal(x.local.db.prepare('SELECT link_id FROM worker_action_outbox').get()?.link_id,null)
 const down=before.links.find(link=>link.onStatus==='down')!
 await x.put([down],before.version)
 assert.ok(x.local.db.prepare('SELECT link_id FROM worker_action_outbox').get()?.link_id)
 await flushActions(x.env);assert.equal(x.calls.length,1)
})

test('action editor preserves links on monitors that have no check',async()=>{
 const x=await monitorFixture(), before=await x.get()
 const link={actionId:x.action.id,onStatus:'down',delayMinutes:1,cooldownMinutes:0}
 await x.put([link],before.version)
 x.local.db.prepare('DELETE FROM http_checks WHERE id=?').run(checkId)
 const action=(await (await actionApi(request('GET'),x.env,actor,'/admin/actions')).json() as {id:string;version:number}[]).find(a=>a.id===x.action.id)!
 await actionApi(request('PATCH',{...x.actionBody,version:action.version,name:'Renamed',checkIds:[],checkSnapshots:[]}),x.env,actor,`/admin/actions/${x.action.id}`)
 assert.deepEqual((await x.get()).links,[link])
})

test('monitor link snapshot cannot pair old links with a newer revision',async()=>{
 const x=await monitorFixture(), initial=await x.get()
 const link={actionId:x.action.id,onStatus:'down',delayMinutes:10,cooldownMinutes:0}
 let interrupted=false
 const db={batch:x.db.batch.bind(x.db),prepare(sql:string) {
  const statement=x.db.prepare(sql)
  if(!sql.includes('WITH links AS')) return statement
  return {bind(...values:unknown[]){statement.bind(...values);return this},async first(){
   const row=await statement.first()
   if(!interrupted){interrupted=true;await x.put([link],initial.version)}
   return row
  }} as D1PreparedStatement
 }} as D1Database
 const snapshot=await (await actionApi(request('GET'),{...x.env,DB:db},actor,x.route)).json() as Awaited<ReturnType<typeof x.get>>
 assert.deepEqual(snapshot,initial)
 await assert.rejects(x.put(snapshot.links,snapshot.version),(e:unknown)=>e instanceof ActionError&&e.status===409)
 assert.deepEqual((await x.get()).links,[link])
})

test('Gatus-managed monitors reject action links',async()=>{
 const x=await monitorFixture()
 x.local.db.prepare('DELETE FROM worker_action_checks').run()
 x.local.db.prepare('DELETE FROM http_checks WHERE id=?').run(checkId)
 x.local.db.prepare("INSERT INTO gatus_sources (source_id,component_id,kind,source_key,source_name,stale_after_seconds) VALUES ('source',?,'endpoint','external','External',60)").run(monitorId)
 await assert.rejects(x.get(),(e:unknown)=>e instanceof ActionError&&e.status===403)
 await assert.rejects(x.put([],0),(e:unknown)=>e instanceof ActionError&&e.status===403)
})

test('uncertain action failures consume cooldown and are never retried automatically',async()=>{
 const x=await monitorFixture(), before=await x.get()
 await x.put([{actionId:x.action.id,onStatus:'down',delayMinutes:0,cooldownMinutes:30}],before.version)
 x.setStatus(500)
 const actual=Date.now;let now=actual()
 try {
  Date.now=()=>now
  await queue(x,'down',100);await flushActions(x.env);await flushActions(x.env)
  assert.equal(x.calls.length,1)
  assert.equal(x.local.db.prepare('SELECT state FROM worker_action_outbox WHERE scheduled_at=100').get()?.state,'uncertain')
  now+=60_000;await queue(x,'down',101);await flushActions(x.env)
  assert.equal(x.calls.length,1)
  assert.equal(x.local.db.prepare('SELECT state FROM worker_action_outbox WHERE scheduled_at=101').get()?.state,'unavailable')
 } finally {Date.now=actual}
})

test('the maximum delay is not expired before it becomes due',async()=>{
 const x=await monitorFixture(), before=await x.get()
 await x.put([{actionId:x.action.id,onStatus:'down',delayMinutes:10080,cooldownMinutes:0}],before.version)
 const actual=Date.now;let now=actual()
 try {
  Date.now=()=>now
  await queue(x,'down',100)
  now+=7*24*60*60_000-60_000;await flushActions(x.env)
  assert.equal(x.local.db.prepare('SELECT state FROM worker_action_outbox').get()?.state,'pending')
  now+=60_000;await flushActions(x.env);assert.equal(x.calls.length,1)
 } finally {Date.now=actual}
})

test('unrelated monitor edits cannot revive legacy jobs invalidated by destination or credential changes',async()=>{
 for (const change of ['destination','credential'] as const) {
  const x=await monitorFixture()
  const endpoints=JSON.parse(destinations) as {id:string;name:string;url:string;binding:string;serviceId:string}[]
  endpoints.push({...endpoints[0]!,id:'other',name:'Other destination',url:'https://other.example.test/run'})
  x.env.ACTION_ENDPOINTS=JSON.stringify(endpoints)
  await queue(x,'down',100)
  const replacement=change==='credential' ? await (await vaultApi(request('POST',{name:'replacement',type:'value',value:'another-token'}),x.db,key,actor,`/admin/vaults/${x.vault.id}/secrets`)).json() as {id:number} : undefined
  const updated={...x.actionBody,version:x.action.version,checkSnapshots:[{id:checkId,componentId:monitorId,configVersion:1}],...(replacement?{secretId:replacement.id}:{endpointId:'other'})}
  await actionApi(request('PATCH',updated),x.env,actor,`/admin/actions/${x.action.id}`)
  assert.equal(x.local.db.prepare('SELECT action_version FROM worker_action_outbox').get()?.action_version,1)
  const other=await (await actionApi(request('POST',{...x.actionBody,name:'Additional action',checkIds:[],checkSnapshots:[]}),x.env,actor,'/admin/actions')).json() as {id:string}
  const current=await x.get()
  await x.put([...current.links,{actionId:other.id,onStatus:'down',delayMinutes:0,cooldownMinutes:0}],current.version)
  await flushActions(x.env)
  assert.equal(x.calls.length,0,`${change} change must invalidate the old action job`)
  assert.equal(x.local.db.prepare('SELECT state FROM worker_action_outbox').get()?.state,'unavailable')
 }
})

test('a superseded pre-send claim releases its reservation before the newer outage runs',async()=>{
 const x=await monitorFixture(), before=await x.get()
 await x.put([{actionId:x.action.id,onStatus:'down',delayMinutes:0,cooldownMinutes:30}],before.version)
 await queue(x,'down',100)
 let raced=false
 const db={batch:x.db.batch.bind(x.db),prepare(sql:string){
  const statement=x.db.prepare(sql)
  if(!sql.trimStart().startsWith('SELECT 1 FROM worker_action_outbox o JOIN http_checks')) return statement
  return {bind(...values:unknown[]){statement.bind(...values);return this},async first(){
   const result=await statement.first()
   if(!raced){raced=true;await queue(x,'down',101);await flushActions(x.env)}
   return result
  }} as D1PreparedStatement
 }} as D1Database
 await flushActions({...x.env,DB:db})
 assert.equal(x.local.db.prepare('SELECT state FROM worker_action_outbox WHERE scheduled_at=101').get()?.state,'pending')
 await flushActions(x.env)
 assert.equal(x.calls.length,1)
 assert.equal(x.local.db.prepare('SELECT state FROM worker_action_outbox WHERE scheduled_at=101').get()?.state,'completed')
})

test('a newer outage waits for an in-flight delivery and honors its completed or uncertain outcome',async()=>{
 for (const status of [204,500]) {
  const x=await monitorFixture(), before=await x.get()
  await x.put([{actionId:x.action.id,onStatus:'down',delayMinutes:0,cooldownMinutes:30}],before.version)
  await queue(x,'down',100)
  let finish!: (response:Response)=>void, notifyStart!:()=>void
  const started=new Promise<void>(resolve=>{notifyStart=resolve})
  const result=new Promise<Response>(resolve=>{finish=resolve})
  let calls=0
  x.env.ACTION={fetch:async()=>{calls++;notifyStart();return result}}
  const first=flushActions(x.env)
  await started
  await queue(x,'down',101)
  await flushActions(x.env)
  assert.equal(x.local.db.prepare('SELECT state FROM worker_action_outbox WHERE scheduled_at=101').get()?.state,'pending')
  finish(status===204?new Response(null,{status}):new Response('error',{status}))
  await first
  await flushActions(x.env)
  assert.equal(calls,1)
  assert.equal(x.local.db.prepare('SELECT state FROM worker_action_outbox WHERE scheduled_at=100').get()?.state,status===204?'completed':'uncertain')
  assert.equal(x.local.db.prepare('SELECT state FROM worker_action_outbox WHERE scheduled_at=101').get()?.state,'unavailable')
 }
})

test('a stale claimed action becomes uncertain and retains its cooldown for newer outages',async()=>{
 const x=await monitorFixture(), before=await x.get()
 await x.put([{actionId:x.action.id,onStatus:'down',delayMinutes:0,cooldownMinutes:30}],before.version)
 await queue(x,'down',100)
 const job=x.local.db.prepare('SELECT id FROM worker_action_outbox WHERE scheduled_at=100').get() as {id:string}
 const claimed=Date.now()-31_000
 x.local.db.prepare("UPDATE worker_action_outbox SET state='executing',claimed_at=? WHERE id=?").run(claimed,job.id)
 x.local.db.prepare("INSERT INTO monitor_action_cooldowns (component_id,action_id,on_status,claimed_at,reservation_id) VALUES (?,?,'down',?,?)").run(monitorId,x.action.id,claimed,job.id)
 await queue(x,'down',101)
 await Promise.all([flushActions(x.env),flushActions(x.env)])
 assert.equal(x.calls.length,0)
 assert.equal(x.local.db.prepare('SELECT state FROM worker_action_outbox WHERE scheduled_at=100').get()?.state,'uncertain')
 assert.equal(x.local.db.prepare('SELECT state FROM worker_action_outbox WHERE scheduled_at=101').get()?.state,'unavailable')
})
