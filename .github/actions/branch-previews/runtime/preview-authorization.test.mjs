import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import fence from './preview-fence.mjs'
import auth from './preview-authorization.mjs'

function harness(t) {
  const control=new DatabaseSync(':memory:'), app=new DatabaseSync(':memory:')
  t.after(()=>{control.close();app.close()})
  control.exec(readFileSync(new URL('../src/preview-execution-fence.sql',import.meta.url),'utf8'))
  app.exec("CREATE TABLE preview_subscriber_leases (scope TEXT PRIMARY KEY,slot INTEGER UNIQUE,target TEXT,release TEXT,expires_at INTEGER)")
  const d1=db=>({
    prepare(sql) {
      return { bind(...args) {
        return {
          async first() { return db.prepare(sql).get(...args) ?? null },
          async run() { return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}} },
        }
      } }
    },
  })
  const selector='branch-'+'a'.repeat(24), release='b'.repeat(40), scope=createHash('sha256').update(selector).digest('hex')
  control.prepare("INSERT INTO preview_execution_fences(selector,active_release,state) VALUES (?,?,'active')").run(selector,release)
  const FLAGS={async getBooleanDetails(){return {value:true}},async getObjectDetails(){return {value:{selector,release}}}}
  const fenceEnv={PREVIEW_SELECTOR:selector,PREVIEW_RELEASE:release,PREVIEW_FLAG_PREFIX:'status-preview-',PREVIEW_FIXTURE_EXPIRES_AT:String(Date.now()+60000),INVENTORY:d1(control),FLAGS}
  const PREVIEW_FENCE={fetch:(url,init)=>fence.fetch(new Request(url,init),fenceEnv)}
  return {control,app,scope,selector,release,fenceEnv,env:{PREVIEW_SELECTOR:selector,PREVIEW_RELEASE:release,PREVIEW_SUBSCRIBER_SCOPE:scope,PREVIEW_DATABASE_ISOLATED:'true',PREVIEW_FENCE,DB:d1(app)}}
}
const request=()=>new Request('https://preview-authorization.internal/check')

test('boolean check refreshes only its private lease and always releases central lease',async t=>{
  const h=harness(t)
  assert.equal((await auth.fetch(request(),h.env)).status,204)
  assert.equal(h.app.prepare('SELECT release FROM preview_subscriber_leases WHERE scope=?').get(h.scope).release,h.release)
  assert.equal(h.control.prepare('SELECT count(*) n FROM preview_execution_leases').get().n,0)
})

test('rejects inactive, expired, incorrectly scoped and conflicting local leases',async t=>{
  const h=harness(t)
  h.control.prepare("UPDATE preview_execution_fences SET state='draining' WHERE selector=?").run(h.selector)
  assert.equal((await auth.fetch(request(),h.env)).status,403)
  h.control.prepare("UPDATE preview_execution_fences SET state='active' WHERE selector=?").run(h.selector)
  h.fenceEnv.PREVIEW_FIXTURE_EXPIRES_AT=String(Date.now()-1)
  assert.equal((await auth.fetch(request(),h.env)).status,403)
  h.fenceEnv.PREVIEW_FIXTURE_EXPIRES_AT=String(Date.now()+60000)
  assert.equal((await auth.fetch(request(),{...h.env,PREVIEW_SUBSCRIBER_SCOPE:'c'.repeat(64)})).status,503)
  h.app.prepare("INSERT INTO preview_subscriber_leases VALUES (?,1,'a',?,?)").run(h.scope,'c'.repeat(40),Date.now()+60000)
  assert.equal((await auth.fetch(request(),h.env)).status,403)
  assert.equal(h.control.prepare('SELECT count(*) n FROM preview_execution_leases').get().n,0)
  assert.equal((await auth.fetch(new Request('https://preview-authorization.internal/acquire',{method:'POST'}),h.env)).status,404)
})
