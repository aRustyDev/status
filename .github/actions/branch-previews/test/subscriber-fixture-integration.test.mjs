import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { buildTrustedPreviewWrappers } from '../src/trusted-wrappers.mjs'
import fenceWorker from '../runtime/preview-fence.mjs'

// Run against a checkout that contains the subscriber feature, for example:
// PREVIEW_FEATURE_DIR=/path/to/feature npm test --prefix .github/actions/branch-previews
const control = fileURLToPath(new URL('../../../../', import.meta.url))
const feature = process.env.PREVIEW_FEATURE_DIR || control
const subscriberSource = path.join(feature,'apps/worker/src/subscribers.ts')
const schedulerSource = path.join(feature,'apps/worker/src/preview-subscriber-scheduler.ts')
const hasFeature = existsSync(subscriberSource) && existsSync(schedulerSource)

class Statement {
  constructor(sql, db, owner) { this.sql=sql; this.db=db; this.owner=owner; this.values=[] }
  bind(...values) { this.values=values; return this }
  runSync() { const result=this.db.prepare(this.sql).run(...this.values); this.owner.afterRun?.(this.sql); return {success:true,meta:{changes:Number(result.changes)}} }
  async run() { return this.runSync() }
  async first() { return this.db.prepare(this.sql).get(...this.values) ?? null }
  async all() { return {results:this.db.prepare(this.sql).all(...this.values)} }
}
class D1 {
  constructor() { this.db=new DatabaseSync(':memory:') }
  prepare(sql) { return new Statement(sql,this.db,this) }
  async batch(statements) { this.db.exec('BEGIN'); try { const result=statements.map(s=>s.runSync()); this.db.exec('COMMIT'); return result } catch(error) { this.db.exec('ROLLBACK'); throw error } }
}

test('actual subscriber feature completes fenced scheduled delivery through the private mailer', {skip: !hasFeature && 'set PREVIEW_FEATURE_DIR to a checkout with subscriber feature'}, async t => {
  const temp=mkdtempSync(path.join(tmpdir(),'subscriber-feature-integration-'))
  t.after(()=>rmSync(temp,{recursive:true,force:true}))
  const branchDir=path.join(temp,'artifact'), workers=path.join(branchDir,'workers'), output=path.join(temp,'out')
  mkdirSync(workers,{recursive:true}); mkdirSync(output)
  const options={bundle:true,format:'esm',platform:'browser',target:'es2022',conditions:['workerd','worker','browser'],external:['cloudflare:*','node:*'],logLevel:'silent'}
  async function compile(entry,outfile) { await build({...options,entryPoints:[entry],outfile}) }
  await compile(schedulerSource,path.join(workers,'subscriber-feature.mjs'))
  const deliveryBundle=path.join(temp,'delivery.mjs')
  await compile(path.join(feature,'apps/worker/src/subscriber-delivery.ts'),deliveryBundle)
  const appEntry=`import {subscriberApi} from ${JSON.stringify(subscriberSource)}; export default {fetch(request,env) {const admin=request.headers.get('x-test-admin')==='1'; const user=admin ? {id:'admin',email:'admin@example.test',role:'admin'} : {id:'owner',email:'owner@example.test',role:'viewer'}; return subscriberApi(request,env,user,new URL(request.url).pathname)}}`
  await build({...options,stdin:{contents:appEntry,resolveDir:feature,sourcefile:'actual-subscriber-api.mjs'},outfile:path.join(workers,'api-feature.mjs')})
  const wrappers=await buildTrustedPreviewWrappers({control,branchDir,dir:output,subscriber:true})
  const {enqueueSubscriberDeliveries}=await import(pathToFileURL(deliveryBundle).href)
  const mailer=(await import(pathToFileURL(wrappers.mailer).href)).default
  const featureWorker=(await import(pathToFileURL(wrappers.subscriberFeature).href)).default
  const scheduler=(await import(pathToFileURL(wrappers.subscriberScheduler).href)).default
  const api=(await import(pathToFileURL(wrappers.api).href)).default
  const authorization=(await import(pathToFileURL(wrappers.authorization).href)).default

  const controlDb=new D1(), appDb=new D1()
  t.after(()=>{controlDb.db.close(); appDb.db.close()})
  controlDb.db.exec(readFileSync(new URL('../src/preview-execution-fence.sql',import.meta.url),'utf8'))
  const migrations=path.join(feature,'apps/worker/migrations')
  const filenames=readdirSync(migrations)
  for (const suffix of ['board','aliases','subscribers','subscriber_deliveries','preview_subscribers','preview_audit_scope','preview_audit_events']) {
    const matches=filenames.filter(name=>new RegExp(`^\\d{4}_${suffix}\\.sql$`).test(name))
    assert.equal(matches.length,1,`missing or ambiguous ${suffix} migration`)
    appDb.db.exec(readFileSync(path.join(migrations,matches[0]),'utf8'))
  }
  const selector='branch-'+'a'.repeat(24), release='b'.repeat(40), scope=createHash('sha256').update(selector).digest('hex')
  const secret='c'.repeat(64), from='sender@example.test', to='owner@example.test', origin='https://status.example.test'
  controlDb.db.prepare("INSERT INTO preview_execution_fences(selector,active_release,state) VALUES (?,?,'active')").run(selector,release)
  appDb.db.exec("INSERT INTO users(id,issuer,subject,email,role) VALUES('owner','issuer','owner','owner@example.test','viewer'),('admin','issuer','admin','admin@example.test','admin')")
  const FLAGS={getBooleanDetails:async()=>({value:true}),getObjectDetails:async()=>({value:{selector,release}})}
  const fenceEnv={PREVIEW_SELECTOR:selector,PREVIEW_RELEASE:release,PREVIEW_FLAG_PREFIX:'status-preview-',PREVIEW_FIXTURE_EXPIRES_AT:String(Date.now()+60000),INVENTORY:controlDb,FLAGS}
  const PREVIEW_FENCE={fetch:(url,init)=>fenceWorker.fetch(new Request(url,init),fenceEnv)}
  const sent=[]
  const mailEnv={PREVIEW_MAIL_FROM:from,PREVIEW_MAIL_TO:to,PREVIEW_MAIL_PUBLIC_URL:origin,PREVIEW_FENCE,EMAIL:{send:async message=>{sent.push(message)}}}
  const PREVIEW_MAILER={fetch:(url,init)=>mailer.fetch(new Request(url,init),mailEnv)}
  const common={DB:appDb,PREVIEW_SELECTOR:selector,PREVIEW_RELEASE:release,PREVIEW_SUBSCRIBER_SCOPE:scope,PREVIEW_SUBSCRIBER_REQUIRED:'true',PREVIEW_DATABASE_ISOLATED:'true',SUBSCRIBERS_READY:'true',SUBSCRIBER_EMAIL_READY:'true',SUBSCRIBER_EMAIL_FROM:from,SUBSCRIBER_EMAIL_DESTINATIONS:JSON.stringify([{id:'test',name:'Test',address:to}]),SUBSCRIBER_PUBLIC_URL:origin}
  const authEnv={...common,PREVIEW_FENCE}
  const PREVIEW_AUTHORIZATION={fetch:(url,init)=>authorization.fetch(new Request(url,init),authEnv)}
  const ops={...common,PREVIEW_AUTHORIZATION,PREVIEW_MAILER}
  const request=(route,method,body,admin=false)=>new Request(origin+route,{method,headers:{'content-type':'application/json',...(admin?{'x-test-admin':'1'}:{})},body:JSON.stringify(body)})
  assert.equal((await api.fetch(request('/admin/subscribers/settings','PUT',{enabled:true,allowEmail:true,allowComponentScope:true,allowedEvents:['incident.created']},true),ops)).status,200)
  assert.equal((await api.fetch(request('/public/subscriptions','POST',{type:'email',email:to,events:['incident.created'],monitorIds:[],tags:[]}),ops)).status,202)
  assert.equal(sent.length,1)
  const token=/token=([a-f0-9]{64})$/.exec(sent[0].text)?.[1]
  assert.ok(token)
  assert.equal((await api.fetch(request('/public/subscriptions/confirm','POST',{token}),ops)).status,200)
  await enqueueSubscriberDeliveries(appDb,'event-1','incident.created',[],Date.now()+1,undefined,common).run()
  const dispatchEnv={...common,PREVIEW_SCHEDULE_SECRET:secret,PREVIEW_MAILER}
  const SUBSCRIBER_FEATURE={fetch:(url,init)=>featureWorker.fetch(new Request(url,init),dispatchEnv)}
  const schedulerEnv={PREVIEW_FENCE,SUBSCRIBER_FEATURE,PREVIEW_SCHEDULE_SECRET:secret}
  await scheduler.scheduled({scheduledTime:Date.now()},schedulerEnv)
  assert.equal(sent.length,2)
  assert.equal(sent[1].subject,'Status page update')
  assert.equal(appDb.db.prepare('SELECT state FROM preview_subscriber_deliveries').get().state,'delivered')
  assert.equal(controlDb.db.prepare('SELECT count(*) n FROM preview_email_quota').get().n,2)
  assert.equal(controlDb.db.prepare('SELECT count(*) n FROM preview_execution_leases').get().n,0)

  // Run the current feature API through its real trusted wrapper. Changes
  // happen after its pending-token write and before its final authorization.
  for (const scenario of ['unsubscribe','delete','new-token','identity','disabled','revoked','expired']) {
    appDb.db.prepare('DELETE FROM preview_subscriber_deliveries WHERE scope=?').run(scope)
    appDb.db.prepare('DELETE FROM preview_subscribers WHERE scope=?').run(scope)
    appDb.db.prepare("UPDATE users SET email=? WHERE id='owner'").run(to)
    appDb.db.prepare('UPDATE preview_subscription_settings SET enabled=1,allow_email=1 WHERE scope=?').run(scope)
    controlDb.db.prepare("UPDATE preview_execution_fences SET state='active' WHERE selector=?").run(selector)
    fenceEnv.PREVIEW_FIXTURE_EXPIRES_AT=String(Date.now()+60000)
    appDb.afterRun=sql=>{
      if (!/^\s*INSERT INTO preview_subscribers\b/.test(sql)) return
      appDb.afterRun=undefined
      if (scenario==='unsubscribe') appDb.db.prepare("UPDATE preview_subscribers SET status='unsubscribed' WHERE scope=?").run(scope)
      if (scenario==='delete') appDb.db.prepare('DELETE FROM preview_subscribers WHERE scope=?').run(scope)
      if (scenario==='new-token') appDb.db.prepare("UPDATE preview_subscribers SET confirmation_hash='newer' WHERE scope=?").run(scope)
      if (scenario==='identity') appDb.db.prepare("UPDATE users SET email='changed@example.test' WHERE id='owner'").run()
      if (scenario==='disabled') appDb.db.prepare('UPDATE preview_subscription_settings SET enabled=0 WHERE scope=?').run(scope)
      if (scenario==='revoked') controlDb.db.prepare("UPDATE preview_execution_fences SET state='draining' WHERE selector=?").run(selector)
      if (scenario==='expired') fenceEnv.PREVIEW_FIXTURE_EXPIRES_AT=String(Date.now()-1)
    }
    const res=await api.fetch(request('/public/subscriptions','POST',{type:'email',email:to,events:['incident.created'],monitorIds:[],tags:[]}),ops)
    assert.equal(res.status,503,scenario)
    assert.equal(sent.length,2,scenario)
    assert.equal(controlDb.db.prepare('SELECT count(*) n FROM preview_execution_leases').get().n,0,scenario)
  }
  controlDb.db.prepare("UPDATE preview_execution_fences SET state='draining' WHERE selector=?").run(selector)
  await scheduler.scheduled({scheduledTime:Date.now()},schedulerEnv)
  assert.equal(sent.length,2)
})
