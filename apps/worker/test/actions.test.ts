import {test} from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {readFileSync} from 'node:fs'
import {vaultApi} from '../src/vault.ts'
import {actionApi,ActionError} from '../src/actions.ts'
import {enqueueActionTransition,flushActions,type ActionEnvironment} from '../src/actions-runtime.ts'
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
 for(const file of ['0001_board.sql','0002_checks.sql','0003_endpoint_registry.sql','0005_gatus_sources.sql','0006_advanced_http.sql','0008_vault.sql','0009_monitor_auth.sql','0009_actions.sql']) local.db.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'))
 local.db.prepare("INSERT INTO users (id,issuer,subject,email,role) VALUES ('admin','issuer','subject','admin@example.test','admin')").run()
 local.db.prepare("INSERT INTO components (id,name,updated_at) VALUES ('component','Service',0)").run()
 local.db.prepare("INSERT INTO endpoint_registry VALUES ('check','approved')").run()
 local.db.prepare("INSERT INTO http_checks (id,component_id,endpoint_id,enabled,interval_minutes,expected_status,last_status,last_scheduled_at) VALUES (?,'component','check',1,1,200,'up',1)").run(checkId)
 const db=local as unknown as D1Database, calls:{url:string;init:RequestInit}[]=[]
 let status=204
 const env={DB:db,ACTIONS_READY:'true',ACTION_ENDPOINTS:destinations,VAULT_ENCRYPTION_KEY:key,ACTION:{fetch:async(url:string,init:RequestInit)=>{calls.push({url,init});return status===204?new Response(null,{status}):new Response('private response',{status})}}} satisfies ActionEnvironment
 const vault=await (await vaultApi(request('POST',{name:'fixture'}),db,key,actor,'/admin/vaults')).json() as {id:number}
 const secret=await (await vaultApi(request('POST',{name:'token',type:'value',value:'fixture-token-one'}),db,key,actor,`/admin/vaults/${vault.id}/secrets`)).json() as {id:number}
 const actionBody={name:'Action',endpointId:'approved',vaultId:vault.id,secretId:secret.id,enabled:true,checkIds:[checkId],triggerStatus:'all'}
 const action=await (await actionApi(request('POST',actionBody),env,actor,'/admin/actions')).json() as {id:string;version:number}
 return {local,db,env,calls,vault,secret,action,actionBody,setStatus:(v:number)=>{status=v}}
}
async function queue(x:Awaited<ReturnType<typeof setup>>,status:'up'|'down'|'degraded'='down',time=100){
 const binary=status==='up'?'up':'down'
 await x.db.batch([
  x.db.prepare('INSERT OR IGNORE INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,effective_status,http_status,latency_ms) VALUES (?,1,?,?,?,?,500,4)').bind(checkId,time,time,binary,status),
  enqueueActionTransition(x.db,checkId,1,'approved',time,status),
 ])
}

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
  for(const file of ['0001_board.sql','0002_checks.sql','0003_endpoint_registry.sql','0005_gatus_sources.sql','0006_advanced_http.sql','0008_vault.sql','0009_monitor_auth.sql','0009_actions.sql']) {
   const sql=readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8').replace(/^\s*--[^\n]*$/gm,'')
   const parts=sql.split(/(?=CREATE TRIGGER |DROP TRIGGER )/),statements=parts.shift()!.split(';').map(s=>s.trim()).filter(Boolean)
   statements.push(...parts.map(s=>s.trim()).filter(Boolean));await db.batch(statements.map(s=>db.prepare(s)))
  }
  await db.batch([
   db.prepare("INSERT INTO users (id,issuer,subject,email,role) VALUES ('admin','issuer','subject','admin@example.test','admin')"),
   db.prepare("INSERT INTO components (id,name,updated_at) VALUES ('component','Service',0)"),
   db.prepare("INSERT INTO endpoint_registry VALUES ('check','approved')"),
   db.prepare("INSERT INTO http_checks (id,component_id,endpoint_id,enabled,interval_minutes,expected_status,last_status,last_scheduled_at) VALUES (?,'component','check',1,1,200,'up',1)").bind(checkId),
  ])
  let calls=0
  const env={DB:db,ACTIONS_READY:'true',ACTION_ENDPOINTS:destinations,VAULT_ENCRYPTION_KEY:key,ACTION:{fetch:async()=>{calls++;return new Response(null,{status:204})}}} satisfies ActionEnvironment
  const vault=await (await vaultApi(request('POST',{name:'fixture'}),db,key,actor,'/admin/vaults')).json() as {id:number}
  const secret=await (await vaultApi(request('POST',{name:'token',type:'value',value:'fixture-token'}),db,key,actor,`/admin/vaults/${vault.id}/secrets`)).json() as {id:number}
  await actionApi(request('POST',{name:'Action',endpointId:'approved',vaultId:vault.id,secretId:secret.id,enabled:true,checkIds:[checkId],triggerStatus:'down'}),env,actor,'/admin/actions')
  async function save(){return db.batch([
   db.prepare("INSERT OR IGNORE INTO http_check_results (check_id,config_version,scheduled_at,completed_at,status,effective_status,http_status,latency_ms) VALUES (?,1,100,100,'down','down',500,4)").bind(checkId),
   enqueueActionTransition(db,checkId,1,'approved',100,'down'),
   db.prepare("UPDATE http_checks SET last_status='down',last_scheduled_at=100 WHERE id=? AND (last_scheduled_at IS NULL OR last_scheduled_at<100)").bind(checkId),
  ])}
  await Promise.all([save(),save()]);await Promise.all([flushActions(env),flushActions(env)])
  assert.equal(calls,1)
  assert.equal((await db.prepare('SELECT state FROM worker_action_outbox').first<{state:string}>())?.state,'completed')
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
