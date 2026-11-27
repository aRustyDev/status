import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { buildTrustedPreviewWrappers } from '../src/trusted-wrappers.mjs'
import fenceWorker from '../runtime/preview-fence.mjs'

// Run with the actual subscriber feature checkout, for example:
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

const scenarios = [
  {name:'confirmation is blocked if the pending subscriber is deleted before provider authorization',kind:'confirmation',change:(db,scope)=>db.prepare('DELETE FROM preview_subscribers WHERE scope=?').run(scope)},
  {name:'confirmation is blocked if its token expires before provider authorization',kind:'confirmation',change:(db,scope)=>db.prepare('UPDATE preview_subscribers SET confirmation_expires_at=? WHERE scope=?').run(Date.now()-1,scope)},
  {name:'confirmation is blocked if its token is replaced before provider authorization',kind:'confirmation',change:(db,scope)=>db.prepare("UPDATE preview_subscribers SET confirmation_hash='replacement' WHERE scope=?").run(scope)},
  {name:'confirmation is blocked if the subscriber unsubscribes before provider authorization',kind:'confirmation',change:(db,scope)=>db.prepare("UPDATE preview_subscribers SET status='unsubscribed' WHERE scope=?").run(scope)},
  {name:'update is blocked if its delivery claim expires before provider authorization',kind:'delivery',change:(db,scope)=>db.prepare("UPDATE preview_subscriber_deliveries SET lease_until=? WHERE scope=? AND state='sending'").run(Date.now()-1,scope)},
  {name:'update is blocked if the subscriber unsubscribes before provider authorization',kind:'delivery',change:(db,scope)=>db.prepare("UPDATE preview_subscribers SET status='unsubscribed' WHERE scope=?").run(scope)},
]

for (const scenario of scenarios) test(scenario.name, {skip: !hasFeature && 'set PREVIEW_FEATURE_DIR to a checkout with subscriber feature'}, async t => {
  const temp=mkdtempSync(path.join(tmpdir(),'subscriber-boundary-regression-'))
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
  const mailEnv={DB:appDb,PREVIEW_SELECTOR:selector,PREVIEW_RELEASE:release,PREVIEW_SUBSCRIBER_SCOPE:scope,PREVIEW_DATABASE_ISOLATED:'true',PREVIEW_FIXTURE_EXPIRES_AT:fenceEnv.PREVIEW_FIXTURE_EXPIRES_AT,PREVIEW_MAIL_FROM:from,PREVIEW_MAIL_TO:to,PREVIEW_MAIL_PUBLIC_URL:origin,PREVIEW_FENCE,EMAIL:{send:async message=>{sent.push(message)}}}
  const targetSubject=scenario.kind==='confirmation' ? 'Confirm your status subscription' : 'Status page update'
  const PREVIEW_MAILER={fetch:(url,init)=>{
    if (JSON.parse(init.body).subject===targetSubject) scenario.change(appDb.db,scope)
    return mailer.fetch(new Request(url,init),mailEnv)
  }}
  const common={DB:appDb,PREVIEW_SELECTOR:selector,PREVIEW_RELEASE:release,PREVIEW_SUBSCRIBER_SCOPE:scope,PREVIEW_SUBSCRIBER_REQUIRED:'true',PREVIEW_DATABASE_ISOLATED:'true',PREVIEW_BRANCH_DELIVERY_CONTEXT:'true',SUBSCRIBERS_READY:'true',SUBSCRIBER_EMAIL_READY:'true',SUBSCRIBER_EMAIL_FROM:from,SUBSCRIBER_EMAIL_DESTINATIONS:JSON.stringify([{id:'test',name:'Test',address:to}]),SUBSCRIBER_PUBLIC_URL:origin}
  const authEnv={...common,PREVIEW_FENCE}
  const PREVIEW_AUTHORIZATION={fetch:(url,init)=>authorization.fetch(new Request(url,init),authEnv)}
  const ops={...common,PREVIEW_AUTHORIZATION,PREVIEW_MAILER}
  const request=(route,method,body,admin=false)=>new Request(origin+route,{method,headers:{'content-type':'application/json',...(admin?{'x-test-admin':'1'}:{})},body:JSON.stringify(body)})
  assert.equal((await api.fetch(request('/admin/subscribers/settings','PUT',{enabled:true,allowEmail:true,allowComponentScope:true,allowedEvents:['incident.created']},true),ops)).status,200)
  const enrollment=await api.fetch(request('/public/subscriptions','POST',{type:'email',email:to,events:['incident.created'],monitorIds:[],tags:[]}),ops)
  if (scenario.kind==='confirmation') {
    assert.equal(enrollment.status,503)
    assert.equal(sent.length,0)
  } else {
    assert.equal(enrollment.status,202)
    assert.equal(sent.length,1)
    const token=/token=([a-f0-9]{64})$/.exec(sent[0].text)?.[1]
    assert.ok(token)
    assert.equal((await api.fetch(request('/public/subscriptions/confirm','POST',{token}),ops)).status,200)
    await enqueueSubscriberDeliveries(appDb,'event-1','incident.created',[],Date.now()+1,undefined,common).run()
    const dispatchEnv={...common,PREVIEW_SCHEDULE_SECRET:secret,PREVIEW_MAILER}
    const SUBSCRIBER_FEATURE={fetch:(url,init)=>featureWorker.fetch(new Request(url,init),dispatchEnv)}
    await scheduler.scheduled({scheduledTime:Date.now()},{PREVIEW_FENCE,SUBSCRIBER_FEATURE,PREVIEW_SCHEDULE_SECRET:secret})
    assert.equal(sent.length,1,'no update email reaches provider')
  }
  // A reservation is deliberately consumed even when the final eligibility
  // check fails: that keeps any ambiguous provider attempt non-retryable.
  assert.equal(controlDb.db.prepare('SELECT count(*) AS n FROM preview_mail_reservations WHERE selector=? AND release=? AND kind=?').get(selector,release,scenario.kind).n,1)
  assert.equal(controlDb.db.prepare('SELECT count(*) AS n FROM preview_execution_leases').get().n,0)
})
