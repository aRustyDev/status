import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { createExecutionFenceController, createCloudflareExecutionFence, ensureExecutionFenceSchema, executionFenceFor, inventoryHasFencedResources, initializeExecutionFenceIfNeeded } from './execution-fence.mjs'

test('missing fence tables do not affect unfenced previews, but recorded or new fixtures initialize fail-closed', async () => {
  let calls=0
  const unavailable=()=>{calls++;return {initialize:async()=>{throw new Error('missing fence table')}}}
  const store=records=>({list:async()=>records.map(record=>({record}))})
  assert.equal(await initializeExecutionFenceIfNeeded({store:store([{active:{resources:{workers:{api:'worker'}}}}]),createFence:unavailable}),null)
  assert.equal(calls,0)
  for (const key of ['active','previous','candidate','retained']) {
    const release={resources:{workers:{fence:'owned-fence'}}}
    const record={ [key]:key==='retained'?[release]:release }
    assert.equal(inventoryHasFencedResources([{record}]),true)
    await assert.rejects(initializeExecutionFenceIfNeeded({store:store([record]),createFence:unavailable}),/missing fence table/)
  }
  await assert.rejects(initializeExecutionFenceIfNeeded({store:store([]),fixtureEnabled:true,createFence:unavailable}),/missing fence table/)
  assert.equal(calls,5)
  assert.equal(inventoryHasFencedResources([{record:{candidate:{resources:{workers:{fence:''}}}}}]),true)
  assert.throws(()=>inventoryHasFencedResources([{record:{active:{resources:{workers:'invalid'}}}}]),/Invalid preview Worker/)
})

test('deploy initialization ignores other branches but reconcile scans them globally', async () => {
  const ref='refs/heads/feat/plain', other='refs/heads/feat/fixture'
  const records=[{record:{ref,active:{resources:{workers:{api:'plain'}}}}},{record:{ref:other,active:{resources:{workers:{fence:'owned'}}}}}]
  let reads=0,lists=0,creates=0
  const store={read:async key=>{reads++;return records.find(({record})=>record.ref===key)??null},list:async()=>{lists++;return records}}
  const unavailable=()=>{creates++;return {initialize:async()=>{throw new Error('missing fence table')}}}
  assert.equal(await initializeExecutionFenceIfNeeded({store,ref,createFence:unavailable}),null)
  assert.equal(reads,1);assert.equal(lists,0);assert.equal(creates,0)
  await assert.rejects(initializeExecutionFenceIfNeeded({store,ref:other,createFence:unavailable}),/missing fence table/)
  await assert.rejects(initializeExecutionFenceIfNeeded({store,createFence:unavailable}),/missing fence table/)
  await assert.rejects(initializeExecutionFenceIfNeeded({store,ref,fixtureEnabled:true,createFence:unavailable}),/missing fence table/)
  assert.equal(reads,3);assert.equal(lists,1);assert.equal(creates,3)
})

test('isolated-preview history initializes the fence after its Workers are pruned', async () => {
  const release={resources:{isolatedPreview:true,workers:{api:'ordinary'}}}
  for (const key of ['active','previous','candidate','retained']) {
    const record={ [key]:key==='retained'?[release]:release }
    assert.equal(inventoryHasFencedResources([{record}]),true)
    await assert.rejects(initializeExecutionFenceIfNeeded({store:{list:async()=>[{record}]},createFence:()=>({initialize:async()=>{throw new Error('missing fence table')}})}),/missing fence table/)
  }
  assert.equal(inventoryHasFencedResources([{record:{active:{resources:{isolatedPreview:false,workers:{api:'ordinary'}}}}}]),false)
  assert.equal(inventoryHasFencedResources([{record:{active:{resources:{isolatedPreview:true}}}}]),true)
})

test('inventory schema setup is idempotent and rejects incompatible tables', async () => {
  const db = new DatabaseSync(':memory:')
  const query = async (sql, params) => db.prepare(sql).all(...params)
  await ensureExecutionFenceSchema(query)
  await ensureExecutionFenceSchema(query)
  db.exec('DROP TABLE preview_email_quota; CREATE TABLE preview_email_quota(selector TEXT)')
  await assert.rejects(ensureExecutionFenceSchema(query), /incompatible|no such column/i)
  db.close()
})

test('fixture, unfenced and later fixture releases preserve the same authoritative fence', async () => {
  const h = harness()
  const select = executionFenceFor(h.controller)
  const fenced = {workers:{fence:'owned-fence'}}, plain = {workers:{}}
  assert.equal(await select({selector:h.selector,sha:h.old,resources:plain,active:null}), null)
  const first = await select({selector:h.selector,sha:h.old,resources:fenced,active:null})
  assert.equal(first.previousRelease,null)
  await first.controller.beginActivation({selector:h.selector,previousRelease:null,release:h.old})
  await first.controller.finishActivation({selector:h.selector,previousRelease:null,release:h.old})
  const middle = await select({selector:h.selector,sha:h.next,resources:plain,active:{sha:h.old,resources:fenced}})
  assert.equal(middle.previousRelease,h.old)
  await middle.controller.beginActivation({selector:h.selector,previousRelease:h.old,release:h.next})
  await middle.controller.finishActivation({selector:h.selector,previousRelease:h.old,release:h.next})
  const third = 'd'.repeat(40)
  assert.equal((await select({selector:h.selector,sha:third,resources:fenced,active:{sha:h.next,resources:plain}})).previousRelease,h.next)
  await assert.rejects(select({selector:h.selector,sha:third,resources:fenced,active:{sha:'e'.repeat(40),resources:fenced}}), /does not match/)
  h.db.close()
})

test('missing fence for an active fixture fails closed and initial unfenced transition can resume', async () => {
  const h = harness(), select = executionFenceFor(h.controller), fenced = {workers:{fence:'owned-fence'}}
  await assert.rejects(select({selector:h.selector,sha:h.next,resources:fenced,active:{sha:h.old,resources:fenced}}), /no execution fence/)
  await assert.rejects(select({selector:h.selector,sha:h.next,resources:fenced,active:{sha:h.old,resources:{workers:{}}},previous:{sha:'e'.repeat(40),resources:fenced}}), /no execution fence/)
  const pending = await select({selector:h.selector,sha:h.next,resources:fenced,active:{sha:h.old,resources:{workers:{}}}})
  await pending.controller.beginActivation({selector:h.selector,previousRelease:null,release:h.next})
  assert.equal((await select({selector:h.selector,sha:h.next,resources:fenced,active:{sha:h.old,resources:{workers:{}}}})).previousRelease,null)
  h.db.close()
})

test('a deleted-branch ambiguity drains a published candidate and remains recoverable', async () => {
  const h = harness(), fenced = {workers:{fence:'owned-fence'}}
  h.db.prepare("INSERT INTO preview_execution_fences(selector,active_release,state) VALUES (?,?,'active')").run(h.selector,h.next)
  h.db.prepare('INSERT INTO preview_execution_leases(selector,release,lease_id) VALUES (?,?,?)').run(h.selector,h.next,'in-flight')
  await assert.rejects(h.controller.beginRetirement(h.selector), /still leased/)
  assert.deepEqual(await h.controller.readState(h.selector), {activeRelease:h.next,state:'draining',leased:true})
  h.db.prepare('DELETE FROM preview_execution_leases WHERE selector=?').run(h.selector)
  assert.equal(await h.controller.beginRetirement(h.selector),h.next)
  const recovery=await executionFenceFor(h.controller)({selector:h.selector,sha:h.next,resources:fenced,active:{sha:h.old,resources:fenced}})
  assert.equal(recovery.previousRelease,h.next)
  await recovery.controller.beginActivation({selector:h.selector,previousRelease:recovery.previousRelease,release:h.next})
  await recovery.controller.finishActivation({selector:h.selector,previousRelease:recovery.previousRelease,release:h.next})
  assert.deepEqual(await h.controller.readState(h.selector), {activeRelease:h.next,state:'active',leased:false})
  h.db.close()
})

test('fixture re-opt-in drains stale fence state after all recorded fenced Workers are retired', async () => {
  const h=harness(), fenced={workers:{fence:'owned-fence'}}, plain={workers:{}}
  h.db.prepare("INSERT INTO preview_execution_fences(selector,active_release,state) VALUES (?,?,'active')").run(h.selector,h.old)
  h.db.prepare('INSERT INTO preview_execution_leases(selector,release,lease_id) VALUES (?,?,?)').run(h.selector,h.old,'in-flight')
  const select=executionFenceFor(h.controller)
  const next=await select({selector:h.selector,sha:h.next,resources:fenced,active:{sha:'d'.repeat(40),resources:plain}})
  assert.equal(next.previousRelease,h.old)
  await assert.rejects(next.controller.beginActivation({selector:h.selector,previousRelease:next.previousRelease,release:h.next}),/still leased/)
  assert.equal((await h.controller.readState(h.selector)).state,'draining')
  h.db.prepare('DELETE FROM preview_execution_leases WHERE selector=?').run(h.selector)
  await next.controller.beginActivation({selector:h.selector,previousRelease:next.previousRelease,release:h.next})
  await next.controller.finishActivation({selector:h.selector,previousRelease:next.previousRelease,release:h.next})
  assert.deepEqual(await h.controller.readState(h.selector),{activeRelease:h.next,state:'active',leased:false})
  h.db.close()
})

function harness(options = {}) {
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync(new URL('./preview-execution-fence.sql', import.meta.url), 'utf8'))
  const query = async (sql, params) => db.prepare(sql).all(...params)
  const controller = createExecutionFenceController({ query, attempts:2, wait:async()=>{}, ...options })
  const selector = 'branch-'+'a'.repeat(24), old = 'b'.repeat(40), next = 'c'.repeat(40)
  return { db, query, controller, selector, old, next }
}

test('first activation and retry after completion are idempotent', async () => {
  const h = harness()
  const args = {selector:h.selector,previousRelease:null,release:h.next}
  assert.equal(await h.controller.beginActivation(args),'drained')
  await h.controller.finishActivation(args)
  assert.equal(await h.controller.beginActivation(args),'already-active')
  await h.controller.finishActivation(args)
  assert.deepEqual({...h.db.prepare('SELECT active_release,state FROM preview_execution_fences').get()}, {active_release:h.next,state:'active'})
  h.db.close()
})

test('state lookup distinguishes absent, active, draining, and leased rows without exposing the lease token', async () => {
  const h = harness()
  assert.equal(await h.controller.readState(h.selector), null)
  h.db.prepare("INSERT INTO preview_execution_fences(selector,active_release,state) VALUES (?,?,'active')").run(h.selector,h.old)
  h.db.prepare('INSERT INTO preview_execution_leases(selector,release,lease_id) VALUES (?,?,?)').run(h.selector,h.old,'sensitive-token')
  assert.deepEqual(await h.controller.readState(h.selector), {activeRelease:h.old,state:'active',leased:true})
  h.db.prepare("UPDATE preview_execution_fences SET state='draining' WHERE selector=?").run(h.selector)
  h.db.prepare('DELETE FROM preview_execution_leases WHERE selector=?').run(h.selector)
  assert.deepEqual(await h.controller.readState(h.selector), {activeRelease:h.old,state:'draining',leased:false})
  h.db.close()
})

test('crash before or after Flagship switch leaves drain safe and can resume', async () => {
  const h = harness()
  h.db.prepare("INSERT INTO preview_execution_fences(selector,active_release,state) VALUES (?,?,'active')").run(h.selector,h.old)
  const args = {selector:h.selector,previousRelease:h.old,release:h.next}
  assert.equal(await h.controller.beginActivation(args),'drained')
  // Simulates crashes before the flag switch and after it, before fence activation.
  assert.equal(await h.controller.beginActivation(args),'drained')
  assert.equal(await h.controller.beginActivation(args),'drained')
  await h.controller.finishActivation(args)
  assert.equal(await h.controller.beginActivation(args),'already-active')
  h.db.close()
})

test('stuck lease never expires or permits activation; release permits retry', async () => {
  const h = harness()
  h.db.prepare("INSERT INTO preview_execution_fences(selector,active_release,state) VALUES (?,?,'active')").run(h.selector,h.old)
  h.db.prepare('INSERT INTO preview_execution_leases(selector,release,lease_id) VALUES (?,?,?)').run(h.selector,h.old,'stuck-token')
  const args = {selector:h.selector,previousRelease:h.old,release:h.next}
  await assert.rejects(h.controller.beginActivation(args), /still leased/)
  await assert.rejects(h.controller.finishActivation(args), /could not activate/)
  assert.deepEqual({...h.db.prepare('SELECT state FROM preview_execution_fences').get()}, {state:'draining'})
  assert.equal(h.db.prepare('SELECT lease_id FROM preview_execution_leases').get().lease_id,'stuck-token')
  h.db.prepare('DELETE FROM preview_execution_leases WHERE selector=?').run(h.selector)
  assert.equal(await h.controller.beginActivation(args),'drained')
  await h.controller.finishActivation(args)
  h.db.close()
})

test('drain waits for every independently acquired lease, including an in-flight mailer', async () => {
  const h=harness()
  h.db.prepare("INSERT INTO preview_execution_fences(selector,active_release,state) VALUES (?,?,'active')").run(h.selector,h.old)
  h.db.prepare('INSERT INTO preview_execution_leases(selector,release,lease_id) VALUES (?,?,?)').run(h.selector,h.old,'scheduler')
  h.db.prepare('INSERT INTO preview_execution_leases(selector,release,lease_id) VALUES (?,?,?)').run(h.selector,h.old,'mailer')
  const args={selector:h.selector,previousRelease:h.old,release:h.next}
  await assert.rejects(h.controller.beginActivation(args),/still leased/)
  h.db.prepare('DELETE FROM preview_execution_leases WHERE lease_id=?').run('scheduler')
  await assert.rejects(h.controller.beginActivation(args),/still leased/)
  await assert.rejects(h.controller.finishActivation(args),/could not activate/)
  h.db.prepare('DELETE FROM preview_execution_leases WHERE lease_id=?').run('mailer')
  await h.controller.beginActivation(args)
  await h.controller.finishActivation(args)
  h.db.close()
})

test('retirement blocks on active execution and retries safely after tombstone', async () => {
  const h = harness()
  h.db.prepare("INSERT INTO preview_execution_fences(selector,active_release,state) VALUES (?,?,'active')").run(h.selector,h.old)
  h.db.prepare('INSERT INTO preview_execution_leases(selector,release,lease_id) VALUES (?,?,?)').run(h.selector,h.old,'stuck-token')
  await assert.rejects(h.controller.beginRetirement(h.selector), /still leased/)
  h.db.prepare('DELETE FROM preview_execution_leases WHERE selector=?').run(h.selector)
  assert.equal(await h.controller.beginRetirement(h.selector),h.old)
  assert.equal(await h.controller.beginRetirement(h.selector),h.old)
  await h.controller.finishRetirement(h.selector,h.old)
  assert.equal(await h.controller.beginRetirement(h.selector),null)
  await h.controller.finishRetirement(h.selector,null)
  h.db.close()
})

test('retiring an absent fence and recovering after a tombstone are idempotent', async () => {
  const h=harness()
  assert.equal(await h.controller.beginRetirement(h.selector),null)
  await h.controller.finishRetirement(h.selector,null)
  h.db.prepare("INSERT INTO preview_execution_fences(selector,active_release,state) VALUES (?,?,'active')").run(h.selector,h.old)
  const release=await h.controller.beginRetirement(h.selector)
  // A crash after the external tombstone but before finishing the fence
  // safely resumes from the durable drained state.
  assert.equal(await h.controller.beginRetirement(h.selector),release)
  await h.controller.finishRetirement(h.selector,release)
  await h.controller.finishRetirement(h.selector,release)
  assert.deepEqual(await h.controller.readState(h.selector),{activeRelease:null,state:'draining',leased:false})
  h.db.close()
})

test('stale expected release, failed query and malformed identity fail closed', async () => {
  const h = harness()
  h.db.prepare("INSERT INTO preview_execution_fences(selector,active_release,state) VALUES (?,?,'active')").run(h.selector,h.old)
  await assert.rejects(h.controller.beginActivation({selector:h.selector,previousRelease:'d'.repeat(40),release:h.next}),/Unexpected active/)
  await assert.rejects(h.controller.beginActivation({selector:'other',previousRelease:null,release:h.next}),/Invalid execution/)
  const failing = createCloudflareExecutionFence({accountId:'account',databaseId:'database',token:'token',fetchImpl:async()=>({ok:false,json:async()=>({success:false})})})
  await assert.rejects(failing.beginRetirement(h.selector),/query failed/)
  h.db.close()
})
