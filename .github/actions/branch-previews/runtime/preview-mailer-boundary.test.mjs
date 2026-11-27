import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { handleBranchPreviewMail } from './preview-mailer.mjs'

function setup() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT);
    CREATE TABLE preview_subscriber_leases(scope TEXT,slot INTEGER,target TEXT,release TEXT,expires_at INTEGER);
    CREATE TABLE preview_subscription_settings(scope TEXT,enabled INTEGER,allow_email INTEGER,allowed_events TEXT,updated_at INTEGER);
    CREATE TABLE preview_subscribers(id INTEGER PRIMARY KEY,scope TEXT,user_id TEXT,email TEXT,status TEXT,events TEXT,monitor_ids TEXT,updated_at INTEGER,confirmation_hash TEXT,confirmation_expires_at INTEGER);
    CREATE TABLE preview_subscriber_deliveries(id TEXT,scope TEXT,subscriber_id INTEGER,state TEXT,lease_token TEXT,lease_until INTEGER,created_at INTEGER,event_type TEXT,component_ids TEXT);`)
  const selector='branch-'+'a'.repeat(24),release='b'.repeat(40),scope=createHash('sha256').update(selector).digest('hex')
  const token='c'.repeat(64), hash=createHash('sha256').update(token).digest('hex'), from='sender@example.test', to='recipient@example.test', origin='https://status.example.test', now=Date.now()
  db.prepare('INSERT INTO users VALUES (?,?)').run('user',to)
  db.prepare('INSERT INTO preview_subscriber_leases VALUES (?,1,\'a\',?,?)').run(scope,release,now+60000)
  db.prepare('INSERT INTO preview_subscription_settings VALUES (?,1,1,?,?)').run(scope,'["incident.created"]',now-1000)
  db.prepare('INSERT INTO preview_subscribers VALUES (1,?,?,?,?,?,?,?,?,?)').run(scope,'user',to,'active','["incident.created"]','[]',now-1000,hash,now+60000)
  db.prepare('INSERT INTO preview_subscriber_deliveries VALUES (?,?,?,?,?,?,?,?,?)').run('delivery',scope,1,'sending','claim',now+60000,now,'incident.created','[]')
  const DB={prepare(sql){ let args=[];return {bind(...a){args=a;return this},async run(){const result=db.prepare(sql).run(...args);return {meta:{changes:Number(result.changes)}}},async first(){return db.prepare(sql).get(...args)||null}}}}
  const sent=[]
  const env={PREVIEW_FIXTURE_EXPIRES_AT:String(Date.now()+60000),DB,PREVIEW_SELECTOR:selector,PREVIEW_RELEASE:release,PREVIEW_SUBSCRIBER_SCOPE:scope,PREVIEW_DATABASE_ISOLATED:'true',PREVIEW_MAIL_FROM:from,PREVIEW_MAIL_TO:to,PREVIEW_MAIL_PUBLIC_URL:origin,EMAIL:{async send(message){sent.push(message)}}}
  const update={from,to,subject:'Status page update',text:`A status update has been published. Visit ${origin} to view it or manage your subscription.`,previewDelivery:{id:'delivery',scope,leaseToken:'claim'}}
  const confirmation={from,to,subject:'Confirm your status subscription',text:`Confirm your subscription: ${origin}/#subscription=confirm&token=${token}`,previewConfirmation:{scope,userId:'user'}}
  const reserved=new Set()
  const send=(message,gate=()=>{})=>handleBranchPreviewMail(new Request('https://mailer.invalid/send',{method:'POST',body:JSON.stringify(message)}),env,async(_env,callback)=>callback(async()=>true,async()=>{await gate();return true},'private-token',async(kind,key)=>{const id=kind+':'+key;if(reserved.has(id))return false;reserved.add(id);return true}))
  return {db,scope,env,sent,update,confirmation,send}
}

test('update rejects revocations during quota and prevents replay, including ambiguous provider failure',async t=>{
  for(const sql of ["UPDATE preview_subscribers SET status='unsubscribed'",'DELETE FROM preview_subscribers',"UPDATE users SET email='wrong@example.test'",'UPDATE preview_subscription_settings SET enabled=0',"UPDATE preview_subscriber_deliveries SET lease_token='reaped'",'UPDATE preview_subscriber_deliveries SET lease_until=0','UPDATE preview_subscriber_leases SET expires_at=0',"UPDATE preview_subscribers SET events='[]'", "UPDATE preview_subscribers SET monitor_ids='[\"other\"]'", "UPDATE preview_subscription_settings SET allowed_events='[]'"]) {
    const h=setup(); t.after(()=>h.db.close())
    if(sql.includes('monitor_ids')) h.db.exec("UPDATE preview_subscriber_deliveries SET component_ids='[\"component\"]'")
    assert.equal((await h.send(h.update,()=>h.db.exec(sql))).status,503,sql)
    assert.equal(h.sent.length,0,sql)
  }
  const expired=setup();t.after(()=>expired.db.close())
  expired.env.PREVIEW_FIXTURE_EXPIRES_AT=String(Date.now()+5)
  assert.equal((await expired.send(expired.update,()=>new Promise(resolve=>setTimeout(resolve,10)))).status,503)
  const h=setup();t.after(()=>h.db.close())
  assert.equal((await h.send({...h.update,previewDelivery:{...h.update.previewDelivery,scope:'bad'}})).status,400)
  assert.equal((await h.send({...h.update,to:'other@example.test'})).status,400)
  assert.equal((await h.send(h.update)).status,204)
  assert.equal((await h.send(h.update)).status,503)
  assert.equal(h.sent.length,1)
  const x=setup();t.after(()=>x.db.close());let calls=0
  x.env.EMAIL.send=async()=>{calls++;throw new Error('ambiguous')}
  assert.equal((await x.send(x.update)).status,503)
  x.db.exec("UPDATE preview_subscriber_deliveries SET lease_token='new-claim'")
  assert.equal((await x.send({...x.update,previewDelivery:{...x.update.previewDelivery,leaseToken:'new-claim'}})).status,503)
  assert.equal(calls,1)
})

test('confirmation checks current identity, token, preferences, and local lease after quota',async t=>{
  for(const sql of ["UPDATE preview_subscribers SET status='unsubscribed'",'DELETE FROM preview_subscribers',"UPDATE users SET email='changed@example.test'",'UPDATE preview_subscription_settings SET allow_email=0',"UPDATE preview_subscribers SET confirmation_hash='replaced'",'UPDATE preview_subscribers SET confirmation_expires_at=0','UPDATE preview_subscriber_leases SET expires_at=0']) {
    const h=setup();t.after(()=>h.db.close());h.db.exec("UPDATE preview_subscribers SET status='pending'")
    assert.equal((await h.send(h.confirmation,()=>h.db.exec(sql))).status,503,sql)
    assert.equal(h.sent.length,0,sql)
  }
  const h=setup();t.after(()=>h.db.close());h.db.exec("UPDATE preview_subscribers SET status='pending'")
  assert.equal((await h.send(h.confirmation)).status,204)
  assert.equal((await h.send(h.confirmation)).status,503)
  assert.equal(h.sent.length,1)
})

test('concurrent requests reserve a delivery only once',async t=>{
  const h=setup();t.after(()=>h.db.close());let started,finish
  const entered=new Promise(resolve=>{started=resolve}), pending=new Promise(resolve=>{finish=resolve})
  h.env.EMAIL.send=async()=>{h.sent.push(1);started();await pending}
  const first=h.send(h.update)
  await entered
  assert.equal((await h.send(h.update)).status,503)
  finish()
  assert.equal((await first).status,204)
  assert.equal(h.sent.length,1)
})
