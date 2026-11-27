import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SignJWT, generateKeyPair, exportJWK } from 'jose'
import { buildTrustedPreviewWrappers } from '../src/trusted-wrappers.mjs'
import fenceWorker from '../runtime/preview-fence.mjs'

// Build this artifact in a credential-free job with the controller's real
// buildArtifact(feature, output), then set PREVIEW_ACTUAL_ARTIFACT and
// PREVIEW_FEATURE_DIR to run this test. It does not send real email.
const control=fileURLToPath(new URL('../../../../',import.meta.url))
const artifact=process.env.PREVIEW_ACTUAL_ARTIFACT
const feature=process.env.PREVIEW_FEATURE_DIR

class Statement {
  constructor(sql,db,owner){this.sql=sql;this.db=db;this.owner=owner;this.values=[]}
  bind(...values){this.values=values;return this}
  runSync(){const result=this.db.prepare(this.sql).run(...this.values);this.owner.afterRun?.(this.sql);return {success:true,meta:{changes:Number(result.changes)}}}
  async run(){return this.runSync()}
  async first(){return this.db.prepare(this.sql).get(...this.values)??null}
  async all(){return {results:this.db.prepare(this.sql).all(...this.values)}}
}
class D1 {
  constructor(){this.db=new DatabaseSync(':memory:')}
  prepare(sql){return new Statement(sql,this.db,this)}
  async batch(statements){this.db.exec('BEGIN');try{const out=statements.map(s=>s.runSync());this.db.exec('COMMIT');return out}catch(error){this.db.exec('ROLLBACK');throw error}}
}

test('real buildArtifact API preserves confirmation race checks through trusted fixture wrapper', {skip:(!artifact||!feature)&&'set PREVIEW_ACTUAL_ARTIFACT and PREVIEW_FEATURE_DIR'},async t=>{
  const tmp=mkdtempSync(path.join(tmpdir(),'actual-fixture-artifact-'))
  const controlDb=new D1(),appDb=new D1(), originalFetch=globalThis.fetch
  t.after(()=>{globalThis.fetch=originalFetch;controlDb.db.close();appDb.db.close();rmSync(tmp,{recursive:true,force:true})})
  assert.notDeepEqual(readFileSync(path.join(artifact,'workers/api.mjs')),readFileSync(path.join(artifact,'workers/api-feature.mjs')),'raw API must differ from legacy wrapped API')
  const wrappers=await buildTrustedPreviewWrappers({control,branchDir:artifact,dir:tmp,subscriber:true})
  const api=(await import(pathToFileURL(wrappers.api).href)).default
  const auth=(await import(pathToFileURL(wrappers.authorization).href)).default
  const mailer=(await import(pathToFileURL(wrappers.mailer).href)).default
  const scheduler=(await import(pathToFileURL(wrappers.subscriberScheduler).href)).default
  const subscriberFeature=(await import(pathToFileURL(wrappers.subscriberFeature).href)).default
  controlDb.db.exec(readFileSync(new URL('../src/preview-execution-fence.sql',import.meta.url),'utf8'))
  const migrations=path.join(feature,'apps/worker/migrations')
  for(const name of readdirSync(migrations).filter(x=>x.endsWith('.sql')).sort()) appDb.db.exec(readFileSync(path.join(migrations,name),'utf8'))
  const selector='branch-'+'a'.repeat(24),release='b'.repeat(40),scope=createHash('sha256').update(selector).digest('hex')
  const secret='c'.repeat(64),origin='https://status.example.test',issuer='https://preview-test.cloudflareaccess.com',aud='preview-test',from='sender@example.test',to='owner@example.test'
  controlDb.db.prepare("INSERT INTO preview_execution_fences(selector,active_release,state) VALUES (?,?,'active')").run(selector,release)
  appDb.db.prepare('INSERT INTO users(id,issuer,subject,email,role) VALUES(?,?,?,?,?)').run('owner',issuer,'owner',to,'viewer')
  appDb.db.prepare('INSERT INTO users(id,issuer,subject,email,role) VALUES(?,?,?,?,?)').run('admin',issuer,'admin','admin@example.test','admin')
  const keys=await generateKeyPair('RS256',{extractable:true}), jwk={...await exportJWK(keys.publicKey),kid:'preview-test-key',alg:'RS256',use:'sig'}
  globalThis.fetch=async input=>{assert.equal(new URL(String(input)).href,issuer+'/cdn-cgi/access/certs');return Response.json({keys:[jwk]})}
  const sign=(subject,email)=>new SignJWT({email}).setProtectedHeader({alg:'RS256',kid:'preview-test-key'}).setIssuer(issuer).setAudience(aud).setSubject(subject).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey)
  const ownerToken=await sign('owner',to),adminToken=await sign('admin','admin@example.test')
  const FLAGS={getBooleanDetails:async()=>({value:true}),getObjectDetails:async()=>({value:{selector,release}})}
  const fenceEnv={PREVIEW_SELECTOR:selector,PREVIEW_RELEASE:release,PREVIEW_FLAG_PREFIX:'status-preview-',PREVIEW_FIXTURE_EXPIRES_AT:String(Date.now()+60000),INVENTORY:controlDb,FLAGS}
  const PREVIEW_FENCE={fetch:(url,init)=>fenceWorker.fetch(new Request(url,init),fenceEnv)}
  const sent=[]
  const mailEnv={PREVIEW_FIXTURE_EXPIRES_AT:String(Date.now()+60000),DB:appDb,PREVIEW_SELECTOR:selector,PREVIEW_RELEASE:release,PREVIEW_SUBSCRIBER_SCOPE:scope,PREVIEW_DATABASE_ISOLATED:'true',PREVIEW_MAIL_FROM:from,PREVIEW_MAIL_TO:to,PREVIEW_MAIL_PUBLIC_URL:origin,PREVIEW_FENCE,EMAIL:{send:async message=>{sent.push(message)}}}
  const PREVIEW_MAILER={fetch:(url,init)=>mailer.fetch(new Request(url,init),mailEnv)}
  const common={DB:appDb,ASSETS:{fetch:async()=>new Response('asset')},API_SCOPE:'operations',ACCESS_TEAM_DOMAIN:'preview-test.cloudflareaccess.com',ACCESS_AUD:aud,ENDPOINTS:'[]',PREVIEW_SELECTOR:selector,PREVIEW_RELEASE:release,PREVIEW_SUBSCRIBER_SCOPE:scope,PREVIEW_SUBSCRIBER_REQUIRED:'true',PREVIEW_DATABASE_ISOLATED:'true',PREVIEW_BRANCH_DELIVERY_CONTEXT:'true',SUBSCRIBERS_READY:'true',SUBSCRIBER_EMAIL_READY:'true',SUBSCRIBER_EMAIL_FROM:from,SUBSCRIBER_EMAIL_DESTINATIONS:JSON.stringify([{id:'test',name:'Test',address:to}]),SUBSCRIBER_PUBLIC_URL:origin}
  const authorizationEnv={...common,PREVIEW_FENCE}
  const PREVIEW_AUTHORIZATION={fetch:(url,init)=>auth.fetch(new Request(url,init),authorizationEnv)}
  const ops={...common,PREVIEW_MAILER,PREVIEW_AUTHORIZATION}
  const request=(route,method,body,admin=false)=>new Request(origin+'/api/v1/bsp'+route,{method,headers:{origin,'content-type':'application/json','Cf-Access-Jwt-Assertion':admin?adminToken:ownerToken},body:JSON.stringify(body)})
  assert.equal((await api.fetch(request('/admin/subscribers/settings','PUT',{enabled:true,allowEmail:true,allowComponentScope:true,allowedEvents:['incident.created']},true),ops)).status,200)
  const enroll=()=>api.fetch(request('/public/subscriptions','POST',{type:'email',email:to,events:['incident.created'],monitorIds:[],tags:[]}),ops)
  assert.equal((await enroll()).status,202)
  assert.equal(sent.length,1)
  const token=/token=([a-f0-9]{64})$/.exec(sent[0].text)?.[1]
  assert.ok(token)
  assert.equal((await api.fetch(request('/public/subscriptions/confirm','POST',{token}),ops)).status,200)
  const subscriberId=appDb.db.prepare('SELECT id FROM preview_subscribers WHERE scope=?').get(scope).id
  appDb.db.prepare("INSERT INTO preview_subscriber_deliveries(id,scope,subscriber_id,event_id,event_type,component_ids,state,created_at,updated_at) VALUES('delivery',?,?, 'event','incident.created','[]','pending',?,?)").run(scope,subscriberId,Date.now()+1,Date.now()+1)
  const dispatchEnv={...common,PREVIEW_SCHEDULE_SECRET:secret,PREVIEW_MAILER}
  const SUBSCRIBER_FEATURE={fetch:(url,init)=>subscriberFeature.fetch(new Request(url,init),dispatchEnv)}
  const scheduleEnv={PREVIEW_FENCE,SUBSCRIBER_FEATURE,PREVIEW_SCHEDULE_SECRET:secret}
  await scheduler.scheduled({scheduledTime:Date.now()},scheduleEnv)
  assert.equal(sent.length,2)
  assert.equal(sent[1].subject,'Status page update')
  assert.equal(appDb.db.prepare('SELECT state FROM preview_subscriber_deliveries').get().state,'delivered')
  for(const scenario of ['unsubscribe','delete','new-token','identity','disabled','revoked','expired']){
    appDb.db.prepare('DELETE FROM preview_subscriber_deliveries WHERE scope=?').run(scope)
    appDb.db.prepare('DELETE FROM preview_subscribers WHERE scope=?').run(scope)
    appDb.db.prepare("UPDATE users SET email=? WHERE id='owner'").run(to)
    appDb.db.prepare('UPDATE preview_subscription_settings SET enabled=1,allow_email=1 WHERE scope=?').run(scope)
    controlDb.db.prepare("UPDATE preview_execution_fences SET state='active' WHERE selector=?").run(selector)
    fenceEnv.PREVIEW_FIXTURE_EXPIRES_AT=String(Date.now()+60000)
    appDb.afterRun=sql=>{
      if(!/^\s*INSERT INTO preview_subscribers\b/.test(sql))return
      appDb.afterRun=undefined
      if(scenario==='unsubscribe')appDb.db.prepare("UPDATE preview_subscribers SET status='unsubscribed' WHERE scope=?").run(scope)
      if(scenario==='delete')appDb.db.prepare('DELETE FROM preview_subscribers WHERE scope=?').run(scope)
      if(scenario==='new-token')appDb.db.prepare("UPDATE preview_subscribers SET confirmation_hash='newer' WHERE scope=?").run(scope)
      if(scenario==='identity')appDb.db.prepare("UPDATE users SET email='changed@example.test' WHERE id='owner'").run()
      if(scenario==='disabled')appDb.db.prepare('UPDATE preview_subscription_settings SET enabled=0 WHERE scope=?').run(scope)
      if(scenario==='revoked')controlDb.db.prepare("UPDATE preview_execution_fences SET state='draining' WHERE selector=?").run(selector)
      if(scenario==='expired')fenceEnv.PREVIEW_FIXTURE_EXPIRES_AT=String(Date.now()-1)
    }
    assert.equal((await enroll()).status,503,scenario)
    assert.equal(sent.length,2,scenario)
  }
})
