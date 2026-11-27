import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import fenceService from './preview-fence.mjs'
import { withActiveBranchExecution } from './branch-preview-fence.mjs'
import { handleBranchPreviewMail } from './preview-mailer.mjs'
import { dispatchBranchSubscribers } from './preview-subscriber-dispatch.mjs'
import scheduler from './preview-subscriber-scheduler.mjs'
import { createExecutionFenceController } from '../src/execution-fence.mjs'

async function harness() {
  const control=new DatabaseSync(':memory:')
  control.exec(readFileSync(new URL('../src/preview-execution-fence.sql',import.meta.url),'utf8'))
  const db=new DatabaseSync(':memory:')
  db.exec('CREATE TABLE preview_subscriber_leases(scope TEXT,slot INTEGER PRIMARY KEY,target TEXT,release TEXT,expires_at INTEGER)')
  const selector='branch-'+'a'.repeat(24),release='b'.repeat(40)
  const scope=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(selector)))].map(x=>x.toString(16).padStart(2,'0')).join('')
  control.prepare("INSERT INTO preview_execution_fences(selector,active_release,state) VALUES (?,?,'active')").run(selector,release)
  const INVENTORY={prepare(sql){return {bind(...args){return {async first(){return control.prepare(sql).get(...args)||null}}}}}}
  const DB={prepare(sql){return {bind(...args){return {async run(){return {meta:{changes:db.prepare(sql).run(...args).changes}}}}}}}}
  const FLAGS={async getBooleanDetails(){return {value:true}},async getObjectDetails(){return {value:{selector,release}}}}
  const fenceEnv={INVENTORY,FLAGS,PREVIEW_SELECTOR:selector,PREVIEW_RELEASE:release,PREVIEW_FLAG_PREFIX:'status-preview-',PREVIEW_FIXTURE_EXPIRES_AT:String(Date.now()+60000)}
  const PREVIEW_FENCE={fetch(url,init){return fenceService.fetch(new Request(url,init),fenceEnv)}}
  let send=async()=>{}
  const mailEnv={PREVIEW_FENCE,PREVIEW_MAIL_FROM:'status@example.test',PREVIEW_MAIL_TO:'owner@example.test',PREVIEW_MAIL_PUBLIC_URL:'https://example.test/',EMAIL:{send:async message=>send(message)}}
  const PREVIEW_MAILER={fetch(url,init){return handleBranchPreviewMail(new Request(url,init),mailEnv,withActiveBranchExecution)}}
  const secret='s'.repeat(32)
  const featureEnv={PREVIEW_SELECTOR:selector,PREVIEW_RELEASE:release,PREVIEW_SUBSCRIBER_SCOPE:scope,PREVIEW_DATABASE_ISOLATED:'true',PREVIEW_SCHEDULE_SECRET:secret,DB,PREVIEW_MAILER}
  const message={from:'status@example.test',to:'owner@example.test',subject:'Status page update',text:'A status update has been published. Visit https://example.test to view it or manage your subscription.'}
  let dispatch=async(env,authorize)=>{
    assert.equal(await authorize(),true)
    for (const key of ['PREVIEW_FENCE','INVENTORY','PREVIEW_MAILER','PREVIEW_SCHEDULE_SECRET','EMAIL','FLAGS']) assert.equal(key in env,false)
    await env.SUBSCRIBER_EMAIL.send(message)
  }
  const SUBSCRIBER_FEATURE={fetch(url,init){return dispatchBranchSubscribers(new Request(url,init),featureEnv,dispatch,2)}}
  const env={PREVIEW_FENCE,SUBSCRIBER_FEATURE,PREVIEW_SCHEDULE_SECRET:secret}
  const query=async(sql,params)=>control.prepare(sql).all(...params)
  const controller=createExecutionFenceController({query,attempts:1,wait:async()=>{}})
  return {control,db,selector,release,scope,env,featureEnv,mailer:PREVIEW_MAILER,controller,setSend(fn){send=fn},setDispatch(fn){dispatch=fn}}
}

test('scheduler and mailer hold independent leases while feature code sees no control capability', async () => {
  const h=await harness()
  let count=0
  h.setSend(async()=>{assert.equal(h.control.prepare('SELECT count(*) n FROM preview_execution_leases').get().n,2);count++})
  await scheduler.scheduled({scheduledTime:Date.now()},h.env)
  assert.equal(count,1)
  assert.equal(h.control.prepare('SELECT count(*) n FROM preview_execution_leases').get().n,0)
  h.control.close();h.db.close()
})

test('drain waits for both scheduler and in-flight mailer, while preventing new sends', async () => {
  const h=await harness()
  let entered,release
  const started=new Promise(resolve=>{entered=resolve}), wait=new Promise(resolve=>{release=resolve})
  h.setSend(async()=>{entered();await wait})
  const tick=scheduler.scheduled({scheduledTime:Date.now()},h.env)
  let timeout
  try { await Promise.race([started,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('provider send did not start')),1000)})]) }
  finally { clearTimeout(timeout) }
  const args={selector:h.selector,previousRelease:h.release,release:'c'.repeat(40)}
  await assert.rejects(h.controller.beginActivation(args),/still leased/)
  assert.equal(h.control.prepare('SELECT count(*) n FROM preview_execution_leases').get().n,2)
  assert.equal(await withActiveBranchExecution(h.env,async()=>assert.fail('draining')),false)
  release()
  await tick
  assert.equal(h.control.prepare('SELECT count(*) n FROM preview_execution_leases').get().n,0)
  await h.controller.beginActivation(args)
  await h.controller.finishActivation(args)
  h.control.close();h.db.close()
})

test('feature dispatch rejects unsigned invocation and accidental privileged bindings', async () => {
  const h=await harness()
  const request=()=>new Request('https://preview-subscriber.internal/__preview/scheduled',{method:'POST',body:JSON.stringify({scheduledTime:Date.now()})})
  assert.equal((await dispatchBranchSubscribers(request(),h.featureEnv,async()=>assert.fail('unsigned'),2)).status,403)
  assert.equal((await dispatchBranchSubscribers(request(),{...h.featureEnv,INVENTORY:{}},async()=>assert.fail('privileged'),2)).status,403)
  assert.equal(h.db.prepare('SELECT count(*) n FROM preview_subscriber_leases').get().n,0)
  h.control.close();h.db.close()
})
