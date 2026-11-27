import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { newRelease } from './release-contract.mjs'
import { createRetirementAdapter } from './retirement-cloudflare.mjs'

test('retirement drains the flag, preserves other bindings and removes only owned workers', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'retirement-test-'))
  const calls = []
  const other = newRelease({ ref: 'refs/heads/fix/other', sha: 'b'.repeat(40) })
  const stem = `status-p-${createHash('sha256').update(`${other.selector}:${other.desiredSha}`).digest('hex').slice(0, 24)}`
  other.active = { sha: other.desiredSha, generation: 1, resources: { gateway: `${stem}-gateway` } }
  const target = newRelease({ ref: 'refs/heads/feat/one', sha: 'a'.repeat(40) })
  const targetStem = `status-p-${createHash('sha256').update(`${target.selector}:${target.desiredSha}`).digest('hex').slice(0, 24)}`
  const workers = Object.fromEntries(Object.entries({ gateway: 'gateway', api: 'operations', statusApi: 'status-api', monitoring: 'monitoring-api', status: 'status-ui', admin: 'admin-ui', probe: 'probe' }).map(([key, suffix]) => [key, `${targetStem}-${suffix}`]))
  const release = { sha: target.desiredSha, resources: { gateway: workers.gateway, workers, database: { id: 'dev', owned: false } } }
  let flag = { enabled: true, default_variation: 'current', rules: [], variations: { current: { selector: target.selector, release: release.sha } } }
  const adapter = createRetirementAdapter({ accountId: 'account', appId: 'app', token: 'token', store: { list: async () => [{ record: target }, { record: other }] }, dispatcherName: 'dispatcher', dispatcherSource: '/dispatcher.ts', dispatcherVars: { ACCESS_AUD: 'aud' }, directory, databaseConfig: {}, databaseAdapter: {}, now: () => 3_600_000,
    run: async args => calls.push(args), fetcher: async (url, options) => {
      if (url.includes('/flagship/')) {
        if (options.method === 'PUT') flag = JSON.parse(options.body)
        return { ok: true, json: async () => ({ success: true, result: flag }) }
      }
      calls.push([options.method, url])
      return { ok: true, status: 204 }
    },
  })
  try {
    await adapter.disableFlag({ ref: target.ref, selector: target.selector })
    assert.equal(await adapter.resolveDisable({ ref: target.ref, selector: target.selector }), true)
    assert.equal(await adapter.propagationElapsed(0, target.ref), true)
    await adapter.removeBindings({ ref: target.ref })
    const config = JSON.parse(readFileSync(path.join(directory, 'retirement-dispatcher.json')))
    assert.equal(config.services.length, 1)
    assert.equal(config.services[0].service, `${stem}-gateway`)
    assert.equal(config.vars.ACCESS_AUD, 'aud')
    await adapter.deleteOwnedResources({ ref: target.ref, release })
    assert.equal(calls.filter(call => call[0] === 'DELETE').length, 7)
    await assert.rejects(adapter.deleteOwnedResources({ ref: target.ref, release: { ...release, resources: { ...release.resources, gateway: 'shared' } } }), /ownership/)
    const extra = { ...workers, fixture: `${targetStem}-fixture`, cas: `${targetStem}-cas` }
    const offset = calls.length
    await adapter.deleteOwnedResources({ ref: target.ref, release: { ...release, resources: { ...release.resources, workers: extra } } })
    const deletions = calls.slice(offset).filter(call => call[0] === 'DELETE')
    assert.equal(deletions.length, 9)
    assert.match(deletions.at(-2)[1], /-cas$/)
    assert.match(deletions.at(-1)[1], /-fixture$/)
    await assert.rejects(adapter.deleteOwnedResources({ ref: target.ref, release: { ...release, resources: { ...release.resources, workers: { ...extra, fixture: 'shared-worker' } } } }), /ownership/)
    const scheduled = { ...extra, fence: `${targetStem}-fence`, probeScheduler: `${targetStem}-probe-scheduler` }
    const beforeScheduled = calls.length
    await adapter.deleteOwnedResources({ ref: target.ref, release: { ...release, resources: { ...release.resources, workers: scheduled } } })
    const scheduleDeletes = calls.slice(beforeScheduled).filter(call => call[0] === 'DELETE')
    assert.equal(scheduleDeletes.length, 11)
    assert.match(scheduleDeletes[0][1], /-probe-scheduler$/)
    assert.match(scheduleDeletes.at(-1)[1], /-fence$/)
    await assert.rejects(adapter.deleteOwnedResources({ ref: target.ref, release: { ...release, resources: { ...release.resources, workers: { ...scheduled, fence: 'shared-worker' } } } }), /ownership/)
    const withSubscriber = { ...scheduled, mailer:`${targetStem}-mailer`, subscriberFeature:`${targetStem}-subscriber-feature`, subscriberScheduler:`${targetStem}-subscriber-scheduler` }
    const beforeSubscriber = calls.length
    await adapter.deleteOwnedResources({ ref: target.ref, release: { ...release, resources: { ...release.resources, workers: withSubscriber } } })
    const subscriberDeletes = calls.slice(beforeSubscriber).filter(call => call[0] === 'DELETE')
    assert.equal(subscriberDeletes.length,14)
    assert.match(subscriberDeletes[0][1], /-subscriber-scheduler$/)
    assert.match(subscriberDeletes[1][1], /-probe-scheduler$/)
    assert.match(subscriberDeletes.at(-1)[1], /-fence$/)
    assert.ok(subscriberDeletes.findIndex(call=>/-mailer$/.test(call[1])) > subscriberDeletes.findIndex(call=>/-subscriber-feature$/.test(call[1])))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('retirement drains active execution before tombstoning', async t => {
  const directory=mkdtempSync(path.join(tmpdir(),'retirement-fence-'))
  t.after(()=>rmSync(directory,{force:true,recursive:true}))
  const target=newRelease({ref:'refs/heads/feat/one',sha:'a'.repeat(40)})
  const events=[]
  let flag={enabled:true,default_variation:'current',rules:[],variations:{current:{selector:target.selector,release:target.desiredSha}}}
  const adapter=createRetirementAdapter({accountId:'account',appId:'app',token:'token',store:{list:async()=>[],read:async()=>({record:{...target,active:{sha:target.desiredSha,resources:{workers:{fence:'owned'}}}}})},dispatcherName:'dispatcher',dispatcherSource:'/dispatcher.ts',directory,run:async()=>{},databaseConfig:{},databaseAdapter:{},
    executionFence:{async readState(){return {activeRelease:target.desiredSha,state:'active',leased:false}},async beginRetirement(selector){events.push('drain');assert.equal(selector,target.selector);return target.desiredSha},async finishRetirement(){events.push('retire')}},
    fetcher:async(_url,options)=>{if(options.method==='PUT'){events.push('tombstone');flag=JSON.parse(options.body)};return {ok:true,json:async()=>({success:true,result:flag})}},
  })
  await adapter.disableFlag({ref:target.ref,selector:target.selector})
  assert.deepEqual(events,['drain','tombstone','retire'])
})

test('retirement refuses a missing or mismatched active fixture fence', async t => {
  const directory=mkdtempSync(path.join(tmpdir(),'retirement-fence-invalid-'))
  t.after(()=>rmSync(directory,{force:true,recursive:true}))
  const target=newRelease({ref:'refs/heads/feat/one',sha:'a'.repeat(40)})
  for (const state of [null, {activeRelease:'b'.repeat(40),state:'active',leased:false}]) {
    let called = false
    const adapter=createRetirementAdapter({accountId:'account',appId:'app',token:'token',store:{read:async()=>({record:{...target,active:{sha:target.desiredSha,resources:{workers:{fence:'owned'}}}}})},dispatcherName:'dispatcher',dispatcherSource:'/dispatcher.ts',directory,run:async()=>{},databaseConfig:{},databaseAdapter:{},
      executionFence:{async readState(){return state},async beginRetirement(){called=true}},fetcher:async()=>{called=true},
    })
    await assert.rejects(adapter.disableFlag({ref:target.ref,selector:target.selector}), /no execution fence|does not match/)
    assert.equal(called,false)
  }
})
