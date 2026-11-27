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
import { branchPreviewEmailProxy } from '../runtime/preview-mailer.mjs'

// Run against a checkout that contains the subscriber feature, for example:
// PREVIEW_FEATURE_DIR=/path/to/feature npm test --prefix .github/actions/branch-previews
const control = fileURLToPath(new URL('../../../../', import.meta.url))
const feature = process.env.PREVIEW_FEATURE_DIR || control
const subscriberSource = path.join(feature,'apps/worker/src/subscribers.ts')
const schedulerSource = path.join(feature,'apps/worker/src/preview-subscriber-scheduler.ts')
const hasFeature = existsSync(subscriberSource) && existsSync(schedulerSource)

class Statement {
  constructor(sql, db) { this.sql=sql; this.db=db; this.values=[] }
  bind(...values) { this.values=values; return this }
  runSync() { const result=this.db.prepare(this.sql).run(...this.values); return {success:true,meta:{changes:Number(result.changes)}} }
  async run() { return this.runSync() }
  async first() { return this.db.prepare(this.sql).get(...this.values) ?? null }
  async all() { return {results:this.db.prepare(this.sql).all(...this.values)} }
}
class D1 {
  constructor() { this.db=new DatabaseSync(':memory:') }
  prepare(sql) { return new Statement(sql,this.db) }
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
  const subscribersBundle=path.join(temp,'subscribers.mjs'), deliveryBundle=path.join(temp,'delivery.mjs')
  await compile(subscriberSource,subscribersBundle)
  await compile(path.join(feature,'apps/worker/src/subscriber-delivery.ts'),deliveryBundle)
  writeFileSync(path.join(workers,'api.mjs'),'export default {fetch(){return new Response()}}')
  const wrappers=await buildTrustedPreviewWrappers({control,branchDir,dir:output,subscriber:true})
  const {subscriberApi}=await import(pathToFileURL(subscribersBundle).href)
  const {enqueueSubscriberDeliveries}=await import(pathToFileURL(deliveryBundle).href)
  const mailer=(await import(pathToFileURL(wrappers.mailer).href)).default
  const featureWorker=(await import(pathToFileURL(wrappers.subscriberFeature).href)).default
  const scheduler=(await import(pathToFileURL(wrappers.subscriberScheduler).href)).default

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
  const fenceEnv={PREVIEW_SELECTOR:selector,PREVIEW_RELEASE:release,PREVIEW_FLAG_PREFIX:'status-preview-',INVENTORY:controlDb,FLAGS}
  const PREVIEW_FENCE={fetch:(url,init)=>fenceWorker.fetch(new Request(url,init),fenceEnv)}
  const sent=[]
  const mailEnv={PREVIEW_MAIL_FROM:from,PREVIEW_MAIL_TO:to,PREVIEW_MAIL_PUBLIC_URL:origin,PREVIEW_FENCE,EMAIL:{send:async message=>{sent.push(message)}}}
  const PREVIEW_MAILER={fetch:(url,init)=>mailer.fetch(new Request(url,init),mailEnv)}
  const common={DB:appDb,PREVIEW_SELECTOR:selector,PREVIEW_RELEASE:release,PREVIEW_SUBSCRIBER_SCOPE:scope,PREVIEW_SUBSCRIBER_REQUIRED:'true',PREVIEW_DATABASE_ISOLATED:'true',SUBSCRIBERS_READY:'true',SUBSCRIBER_EMAIL_READY:'true',SUBSCRIBER_EMAIL_FROM:from,SUBSCRIBER_EMAIL_DESTINATIONS:JSON.stringify([{id:'test',name:'Test',address:to}]),SUBSCRIBER_PUBLIC_URL:origin}
  const ops={...common,SUBSCRIBER_EMAIL:branchPreviewEmailProxy(PREVIEW_MAILER)}
  const request=(method,body)=>new Request(origin,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)})
  const owner={id:'owner',email:to,role:'viewer'}, admin={id:'admin',email:'admin@example.test',role:'admin'}
  assert.equal((await subscriberApi(request('PUT',{enabled:true,allowEmail:true,allowComponentScope:true,allowedEvents:['incident.created']}),ops,admin,'/admin/subscribers/settings')).status,200)
  assert.equal((await subscriberApi(request('POST',{type:'email',email:to,events:['incident.created'],monitorIds:[],tags:[]}),ops,owner,'/public/subscriptions')).status,202)
  assert.equal(sent.length,1)
  const token=/token=([a-f0-9]{64})$/.exec(sent[0].text)?.[1]
  assert.ok(token)
  assert.equal((await subscriberApi(request('POST',{token}),ops,owner,'/public/subscriptions/confirm')).status,200)
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
  controlDb.db.prepare("UPDATE preview_execution_fences SET state='draining' WHERE selector=?").run(selector)
  await scheduler.scheduled({scheduledTime:Date.now()},schedulerEnv)
  assert.equal(sent.length,2)
})
