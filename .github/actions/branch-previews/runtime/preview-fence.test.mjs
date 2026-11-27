import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import service from './preview-fence.mjs'
import { withActiveBranchExecution } from './branch-preview-fence.mjs'
import scheduler from './preview-probe-scheduler.mjs'
import { wrapPreviewFixture } from './preview-fixture-fence.mjs'

function harness() {
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync(new URL('../src/preview-execution-fence.sql', import.meta.url), 'utf8'))
  const selector = 'branch-' + 'a'.repeat(24)
  const release = 'b'.repeat(40)
  const route = { selector, release }
  db.prepare(`INSERT INTO preview_execution_fences(selector,active_release,state) VALUES (?,?,'active')`).run(selector, release)
  const INVENTORY = { prepare(sql) { return { bind(...values) { return { async first() { return db.prepare(sql).get(...values) || null } } } } } }
  const FLAGS = { async getBooleanDetails(key) { assert.equal(key, 'status-preview-enabled'); return { value: true } }, async getObjectDetails(key) { assert.equal(key, `status-preview-branch-${selector.slice(7)}`); return { value: route } } }
  const svcEnv = { PREVIEW_SELECTOR: selector, PREVIEW_RELEASE: release, PREVIEW_FLAG_PREFIX:'status-preview-', PREVIEW_FIXTURE_EXPIRES_AT:String(Date.now()+60000), INVENTORY, FLAGS }
  const PREVIEW_FENCE = { fetch(url, init) { return service.fetch(new Request(url, init), svcEnv) } }
  return { db, selector, release, route, svcEnv, env: { PREVIEW_FENCE } }
}

test('expired approval blocks acquire and send checks but permits releasing an in-flight lease', async () => {
  const h = harness()
  const call = (url, body = {}) => h.env.PREVIEW_FENCE.fetch(`https://preview-fence.internal/${url}`, {method:'POST', body:JSON.stringify(body)})
  const acquired = await call('acquire')
  const {token} = await acquired.json()
  h.svcEnv.PREVIEW_FIXTURE_EXPIRES_AT = String(Date.now()-1)
  assert.equal((await call('acquire')).status,409)
  assert.equal((await call('check',{token})).status,409)
  assert.equal((await call('claim-email',{token})).status,409)
  assert.equal((await call('release',{token})).status,204)
  h.db.close()
})

test('synthetic monitor, Actions and CAS fixture requests are fenced and expire', async () => {
  const h = harness(), seen=[]
  const app=wrapPreviewFixture({async fetch(request,env) {
    assert.equal(env.PREVIEW_FENCE,undefined)
    assert.equal(env.INVENTORY,undefined)
    assert.equal(env.FLAGS,undefined)
    seen.push(new URL(request.url).pathname)
    return new Response('ok')
  }})
  for (const path of ['/monitor','/actions/success','/cas/v1/tickets']) {
    assert.equal((await app.fetch(new Request(`https://preview-fixture.invalid${path}`),h.env)).status,200)
  }
  h.svcEnv.PREVIEW_FIXTURE_EXPIRES_AT=String(Date.now()-1)
  for (const path of ['/monitor','/actions/success','/cas/v1/tickets']) {
    assert.equal((await app.fetch(new Request(`https://preview-fixture.invalid${path}`),h.env)).status,503)
  }
  assert.deepEqual(seen,['/monitor','/actions/success','/cas/v1/tickets'])
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM preview_execution_leases').get().n,0)
  h.db.close()
})

test('only the active fixed release can acquire and independent leases cannot be stolen', async () => {
  const h = harness()
  const call = (url, body = {}) => h.env.PREVIEW_FENCE.fetch(`https://preview-fence.internal/${url}`, {method:'POST', body:JSON.stringify(body)})
  const first = await call('acquire')
  assert.equal(first.status, 200)
  const { token } = await first.json()
  const second = await call('acquire')
  assert.equal(second.status, 200)
  const secondToken = (await second.json()).token
  assert.notEqual(secondToken,token)
  assert.equal((await call('check', {token})).status, 204)
  h.route.release = 'c'.repeat(40)
  assert.equal((await call('check', {token})).status, 409)
  assert.equal((await call('release', {token})).status, 204)
  assert.equal((await call('release', {token})).status, 409)
  assert.equal((await call('release', {token:secondToken})).status, 204)
  assert.equal((await call('acquire')).status, 409)
  h.db.close()
})

test('draining prevents new work and waits for explicit lease release before switching', async () => {
  const h = harness()
  let enter, resume
  const entered = new Promise(resolve => { enter = resolve })
  const wait = new Promise(resolve => { resume = resolve })
  const running = withActiveBranchExecution(h.env, async isCurrent => {
    enter()
    await wait
    assert.equal(await isCurrent(), false)
  })
  await entered
  h.db.prepare("UPDATE preview_execution_fences SET state='draining' WHERE selector=?").run(h.selector)
  assert.equal(await withActiveBranchExecution(h.env, async () => assert.fail('must not start')), false)
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM preview_execution_leases WHERE selector=?').get(h.selector).n, 1)
  assert.equal(h.db.prepare("UPDATE preview_execution_fences SET active_release=?,state='active' WHERE selector=? AND state='draining' AND NOT EXISTS (SELECT 1 FROM preview_execution_leases WHERE selector=?)").run('c'.repeat(40),h.selector,h.selector).changes, 0)
  resume()
  assert.equal(await running, true)
  assert.equal(h.db.prepare("UPDATE preview_execution_fences SET active_release=?,state='active' WHERE selector=? AND state='draining' AND NOT EXISTS (SELECT 1 FROM preview_execution_leases WHERE selector=?)").run('c'.repeat(40),h.selector,h.selector).changes, 1)
  assert.equal(await withActiveBranchExecution(h.env, async () => assert.fail('old release')), false)
  h.db.close()
})

test('email claims require the held lease and are limited across releases to four per rolling hour', async () => {
  const h = harness()
  await withActiveBranchExecution(h.env, async (_isCurrent, claimEmail) => {
    for (let i=0; i<4; i++) assert.equal(await claimEmail(), true)
    assert.equal(await claimEmail(), false)
  })
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM preview_email_quota').get().n, 4)
  const replacement = 'c'.repeat(40)
  h.db.prepare('UPDATE preview_execution_fences SET active_release=? WHERE selector=?').run(replacement, h.selector)
  h.svcEnv.PREVIEW_RELEASE = replacement
  h.route.release = replacement
  await withActiveBranchExecution(h.env, async (_isCurrent, claimEmail) => assert.equal(await claimEmail(), false))
  const unauthorized = await h.env.PREVIEW_FENCE.fetch('https://preview-fence.internal/claim-email', {method:'POST', body:JSON.stringify({token:'0'.repeat(36)})})
  assert.equal(unauthorized.status, 409)
  h.db.close()
})

test('trusted mail reservations are single-use across concurrent calls within a release', async () => {
  const h=harness()
  await withActiveBranchExecution(h.env,async (_current,_quota,_token,reserve)=>{
    const results=await Promise.all([reserve('delivery','1'),reserve('delivery','1')])
    assert.deepEqual(results.sort(),[false,true])
    assert.equal(await reserve('confirmation','f'.repeat(64)),true)
    assert.equal(await reserve('confirmation','f'.repeat(64)),false)
    assert.equal(await reserve('confirmation','not-a-token-hash'),false)
    assert.equal(await reserve('unknown','delivery-id'),false)
  })
  const held=await h.env.PREVIEW_FENCE.fetch('https://preview-fence.internal/acquire',{method:'POST',body:'{}'})
  const oldToken=(await held.json()).token
  const oldEnv={...h.svcEnv}
  const replacement='c'.repeat(40)
  h.db.prepare('UPDATE preview_execution_fences SET active_release=? WHERE selector=?').run(replacement,h.selector)
  h.svcEnv.PREVIEW_RELEASE=replacement; h.route.release=replacement
  const oldReservation=await service.fetch(new Request('https://preview-fence.internal/claim-reservation',{method:'POST',body:JSON.stringify({token:oldToken,kind:'delivery',item:'2'})}),oldEnv)
  assert.equal(oldReservation.status,409,'a prior release cannot reserve after the switch')
  const oldRelease=await service.fetch(new Request('https://preview-fence.internal/release',{method:'POST',body:JSON.stringify({token:oldToken})}),oldEnv)
  assert.equal(oldRelease.status,204)
  await withActiveBranchExecution(h.env,async (_current,_quota,_token,reserve)=>{
    assert.equal(await reserve('delivery','1'),true)
    assert.equal(await reserve('confirmation','f'.repeat(64)),true)
  })
  const rows=h.db.prepare('SELECT selector,release,kind,item FROM preview_mail_reservations ORDER BY release,kind').all().map(x=>({...x}))
  assert.deepEqual(rows,[
    {selector:h.selector,release:h.release,kind:'confirmation',item:'f'.repeat(64)},
    {selector:h.selector,release:h.release,kind:'delivery',item:'1'},
    {selector:h.selector,release:replacement,kind:'confirmation',item:'f'.repeat(64)},
    {selector:h.selector,release:replacement,kind:'delivery',item:'1'},
  ])
  h.db.close()
})

test('reservation rejects another selector lease, draining state and expired approval', async () => {
  const h=harness()
  const other='branch-'+'d'.repeat(24)
  h.db.prepare("INSERT INTO preview_execution_fences(selector,active_release,state) VALUES (?,?,'active')").run(other,h.release)
  const flags={async getBooleanDetails(){return {value:true}},async getObjectDetails(){return {value:{selector:other,release:h.release}}}}
  const otherEnv={...h.svcEnv,PREVIEW_SELECTOR:other,FLAGS:flags}
  const call=(env,path,body)=>service.fetch(new Request(`https://preview-fence.internal/${path}`,{method:'POST',body:JSON.stringify(body)}),env)
  await withActiveBranchExecution(h.env,async (_current,_quota,token,reserve)=>{
    assert.equal((await call(otherEnv,'claim-reservation',{token,kind:'delivery',item:'delivery-id'})).status,409)
    h.db.prepare("UPDATE preview_execution_fences SET state='draining' WHERE selector=?").run(h.selector)
    assert.equal(await reserve('delivery','delivery-id'),false)
    h.db.prepare("UPDATE preview_execution_fences SET state='active' WHERE selector=?").run(h.selector)
    h.svcEnv.PREVIEW_FIXTURE_EXPIRES_AT=String(Date.now()-1)
    assert.equal(await reserve('delivery','delivery-id'),false)
  })
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM preview_mail_reservations').get().n,0)
  h.db.close()
})

test('unavailable Flagship or control database fails closed without executing the callback', async () => {
  const h = harness()
  h.svcEnv.FLAGS.getBooleanDetails = async () => { throw new Error('offline') }
  assert.equal(await withActiveBranchExecution(h.env, async () => assert.fail('must not execute')), false)
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM preview_execution_leases WHERE selector=?').get(h.selector).n, 0)
  h.db.close()
})

test('fence rejects oversized bodies without buffering the remainder', async () => {
  const h = harness()
  let cancelled = false
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(257)) },
    cancel() { cancelled = true },
  })
  const request = new Request('https://preview-fence.internal/check', {method:'POST',body,duplex:'half'})
  assert.equal((await service.fetch(request,h.svcEnv)).status,400)
  assert.equal(cancelled,true)
  h.db.close()
})

test('trusted nested delivery shares and does not release its scheduler lease', async () => {
  const h = harness()
  assert.equal(await withActiveBranchExecution(h.env, async (_check, _claim, token) => {
    assert.equal(await withActiveBranchExecution(h.env, async (check, claim, innerToken) => {
      assert.equal(innerToken, token)
      assert.equal(await check(), true)
      assert.equal(await claim(), true)
    }, { leaseToken: token }), true)
    assert.equal(h.db.prepare('SELECT lease_id FROM preview_execution_leases WHERE selector=?').get(h.selector).lease_id, token)
  }), true)
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM preview_execution_leases WHERE selector=?').get(h.selector).n, 0)
  h.db.close()
})

test('probe scheduler holds its fence through the signed private invocation', async () => {
  const h = harness()
  const secret = 's'.repeat(32)
  const tick = Date.now()
  let invoked = 0
  const PROBE = { async fetch(url, init) {
    assert.equal(new URL(url).pathname, '/__preview/scheduled')
    assert.equal(h.db.prepare('SELECT count(*) AS n FROM preview_execution_leases WHERE selector=?').get(h.selector).n, 1)
    assert.equal(JSON.parse(init.body).scheduledTime, tick)
    const sig = init.headers['x-preview-schedule-signature']
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    assert.equal(await crypto.subtle.verify('HMAC', key, Uint8Array.from(sig.match(/../g), x=>parseInt(x,16)), new TextEncoder().encode(String(tick))), true)
    invoked++
    return new Response(null, {status:204})
  } }
  await scheduler.scheduled({scheduledTime:tick}, {...h.env, PROBE, PREVIEW_SCHEDULE_SECRET:secret})
  assert.equal(invoked, 1)
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM preview_execution_leases WHERE selector=?').get(h.selector).n, 0)
  h.db.prepare("UPDATE preview_execution_fences SET state='draining' WHERE selector=?").run(h.selector)
  await scheduler.scheduled({scheduledTime:tick}, {...h.env, PROBE, PREVIEW_SCHEDULE_SECRET:secret})
  assert.equal(invoked, 1)
  h.db.close()
})
