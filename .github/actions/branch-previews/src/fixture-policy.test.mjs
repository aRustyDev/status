import test from 'node:test'
import assert from 'node:assert/strict'
import { fixturePolicy, preserveIsolatedHistory, fixtureVaultKey, fixtureScheduleKey, isolatedFallbackSettings, isolatedWorkerSecrets, settingsForFixture } from './fixture-policy.mjs'
import { newRelease } from './release-contract.mjs'

const sha = 'a'.repeat(40)
const artifacts = {workers:{api:'f'.repeat(64)},assets:{},migrations:{'0001.sql':'e'.repeat(64)}}

test('fixture approval is explicit, exact-commit, and uses isolated schema resources', () => {
  const ref = 'refs/heads/feat/example'
  const approval = { sha, cas: true, subscriber: false, probe: true, expiresAt:Date.now()+60000, artifacts }
  assert.deepEqual(fixturePolicy(undefined, ref, sha), { enabled: false, environment: 'dev' })
  assert.deepEqual(fixturePolicy({ branches: { [ref]: approval } }, ref, sha), { enabled: true, environment: 'schema', cas: true, subscriber: false, probe: true, expiresAt:approval.expiresAt })
  assert.deepEqual(fixturePolicy({ branches: { [ref]: approval } }, ref, 'b'.repeat(40)), { enabled:false, environment:'schema', isolatedFallback:true })
  assert.deepEqual(fixturePolicy({ branches: { [ref]: approval } }, 'refs/heads/stage/other', sha), { enabled: false, environment: 'stage' })
})

test('stale or expired opt-ins fall back to isolated schema without fixture privileges', () => {
  const now=1800000000000, sha='a'.repeat(40)
  for (const ref of ['refs/heads/feat/example','refs/heads/stage/example','refs/heads/schema/example']) {
    const approval={sha,cas:true,subscriber:true,probe:true,expiresAt:now+60000,artifacts}
    assert.deepEqual(fixturePolicy({branches:{[ref]:approval}},ref,'b'.repeat(40),now),{enabled:false,environment:'schema',isolatedFallback:true})
    assert.deepEqual(fixturePolicy({branches:{[ref]:{...approval,expiresAt:now}}},ref,sha,now),{enabled:false,environment:'schema',isolatedFallback:true})
    assert.throws(()=>fixturePolicy({branches:{[ref]:{...approval,expiresAt:now+48*3600_000+1}}},ref,sha,now),/Invalid fixture approval/)
  }
})

test('isolated fallback discards shared resource bindings and all side-effect readiness', () => {
  const result=isolatedFallbackSettings({accessTeamDomain:'access',accessAud:'aud',endpoints:'shared',extraServices:{api:[{binding:'GATUS',service:'shared'}]},resourceBindings:{api:{send_email:[{name:'EMAIL'}],r2_buckets:[{binding:'R2'}]}},vpcServices:[{binding:'PRIVATE'}],apiVars:{ACTIONS_READY:'true',SUBSCRIBERS_READY:'true',EMAIL_READY:'true'},statusApiVars:{ACTIONS_READY:'true'},monitoringVars:{MONITOR_AUTH_READY:'true'},probeVars:{ACTIONS_READY:'true'}})
  assert.equal(result.accessTeamDomain,'access')
  assert.equal(result.accessAud,'aud')
  assert.equal(result.endpoints,'[]')
  assert.deepEqual(result.extraServices,{})
  assert.deepEqual(result.resourceBindings,{})
  assert.deepEqual(result.vpcServices,[])
  for (const key of ['apiVars','statusApiVars','monitoringVars','probeVars']) assert.deepEqual(result[key],{})
})

test('enabled fixtures and fallback use sanitized settings while ordinary previews are unchanged', () => {
  const settings={accessTeamDomain:'access',accessAud:'aud',adminVars:{UI_TITLE:'Preview'},extraServices:{probe:[{binding:'GATUS',service:'shared'}]},resourceBindings:{api:{send_email:[{name:'EMAIL'}]},probe:{r2_buckets:[{binding:'SHARED'}]}}}
  assert.equal(settingsForFixture(settings,{enabled:false}),settings)
  for (const fixture of [{enabled:true},{enabled:false,isolatedFallback:true}]) {
    const safe=settingsForFixture(settings,fixture)
    assert.deepEqual(safe.extraServices,{})
    assert.deepEqual(safe.resourceBindings,{})
    assert.equal(safe.accessTeamDomain,'access')
    assert.equal(safe.accessAud,'aud')
    assert.deepEqual(safe.adminVars,{UI_TITLE:'Preview'})
  }
})

test('fallback discards every shared secret and uses only its release-specific Vault key', () => {
  const root='ab'.repeat(32), selector='branch-'+'a'.repeat(24)
  const previous={api:{VAULT_ENCRYPTION_KEY:'shared',TOKEN:'shared-token'},monitoring:{TOKEN:'shared-token'},probe:{TOKEN:'shared-token'},gateway:{TOKEN:'shared-token'}}
  const fresh=isolatedWorkerSecrets(previous,root,selector,sha,{isolatedFallback:true})
  assert.equal(JSON.stringify(fresh).includes('shared'),false)
  assert.deepEqual(fresh.gateway,{})
  assert.equal(fresh.api.VAULT_ENCRYPTION_KEY,fixtureVaultKey(root,selector,sha))
  assert.notEqual(fresh.api.VAULT_ENCRYPTION_KEY,isolatedWorkerSecrets(previous,root,selector,'b'.repeat(40),{isolatedFallback:true}).api.VAULT_ENCRYPTION_KEY)
  assert.equal(fresh.subscriberScheduler,undefined)
  assert.equal(fresh.probeScheduler,undefined)
})

test('removing approval retains schema isolation for fixture and fallback release history', () => {
  for (const ref of ['refs/heads/feat/example','refs/heads/stage/example','refs/heads/schema/example']) {
    const base=newRelease({ref,sha}), policy=fixturePolicy(undefined,ref,sha), fallback={enabled:false,environment:'schema',isolatedFallback:true}
    const fixtureRelease={sha,generation:1,resources:{isolatedPreview:true,workers:{fixture:'preview-owned'}}}
    const fallbackRelease={sha,generation:1,resources:{isolatedPreview:true,database:{id:'owned',name:'owned',owned:true}}}
    for (const release of [fixtureRelease,fallbackRelease]) {
      for (const key of ['active','previous','candidate','retained']) {
        const record={...base,[key]:key==='retained'?[release]:release}
        assert.deepEqual(preserveIsolatedHistory({ref,fixture:policy,snapshot:{record},sharedDatabaseIds:['dev','stage']}),fallback,`${ref} ${key}`)
      }
    }
    const incomplete={...base,candidate:{sha,generation:1,resources:{}}}
    assert.deepEqual(preserveIsolatedHistory({ref,fixture:policy,snapshot:{record:incomplete},sharedDatabaseIds:['dev','stage']}),fallback)
    assert.deepEqual(preserveIsolatedHistory({ref,fixture:policy,snapshot:null,sharedDatabaseIds:['dev','stage']}),policy)
    assert.throws(()=>preserveIsolatedHistory({ref,fixture:policy,snapshot:{record:{...base,ref:'invalid'}},sharedDatabaseIds:['dev','stage']}),/inventory/)
  }
})

test('ordinary shared and schema previews retain their existing configuration when history is clear', () => {
  const sharedRef='refs/heads/feat/normal', shared=newRelease({ref:sharedRef,sha}), sharedPolicy=fixturePolicy(undefined,sharedRef,sha)
  const sharedActive={...shared,active:{sha,generation:1,resources:{database:{id:'dev',name:'dev',owned:false}}}}
  assert.deepEqual(preserveIsolatedHistory({ref:sharedRef,fixture:sharedPolicy,snapshot:{record:sharedActive},sharedDatabaseIds:['dev','stage']}),sharedPolicy)
  const unknown={...sharedActive,active:{...sharedActive.active,resources:{database:{id:'unrecognized',name:'unknown',owned:false}}}}
  assert.deepEqual(preserveIsolatedHistory({ref:sharedRef,fixture:sharedPolicy,snapshot:{record:unknown},sharedDatabaseIds:['dev','stage']}),{enabled:false,environment:'schema',isolatedFallback:true})
  const schemaRef='refs/heads/schema/normal', schema=newRelease({ref:schemaRef,sha}), schemaPolicy=fixturePolicy(undefined,schemaRef,sha)
  const ordinarySchema={...schema,active:{sha,generation:1,resources:{database:{id:'owned',name:'owned',owned:true},databaseIntent:{name:'owned'}}}}
  assert.deepEqual(preserveIsolatedHistory({ref:schemaRef,fixture:schemaPolicy,snapshot:{record:ordinarySchema},sharedDatabaseIds:['dev','stage']}),schemaPolicy)
})

test('fallback marker survives cleanup and continues isolation until an explicitly approved release', () => {
  const ref='refs/heads/stage/example',base=newRelease({ref,sha}),plain=fixturePolicy(undefined,ref,sha)
  const isolated={enabled:false,environment:'schema',isolatedFallback:true}
  const release={sha,generation:1,resources:{isolatedPreview:true,database:{id:'owned',name:'owned',owned:true}}}
  const record={...base,active:release,previous:null,retained:[]}
  assert.deepEqual(preserveIsolatedHistory({ref,fixture:plain,snapshot:{record},sharedDatabaseIds:['dev','stage']}),isolated)
  const later='b'.repeat(40), approved=fixturePolicy({branches:{[ref]:{sha:later,cas:false,subscriber:false,probe:false,expiresAt:Date.now()+60000,artifacts}}},ref,later)
  assert.equal(preserveIsolatedHistory({ref,fixture:approved,snapshot:{record},sharedDatabaseIds:['dev','stage']}).enabled,true)
  assert.throws(()=>preserveIsolatedHistory({ref,fixture:plain,snapshot:{record:{...record,active:{...release,resources:{...release.resources,isolatedPreview:false}}}},sharedDatabaseIds:['dev','stage']}),/history marker/)
})

test('invalid approvals fail closed', () => {
  assert.throws(() => fixturePolicy({ branches: { 'refs/heads/main': sha } }, 'refs/heads/feat/test', sha), /Invalid fixture approval/)
  assert.throws(() => fixturePolicy({ branches: { 'refs/heads/feat/test': '*' } }, 'refs/heads/feat/test', sha), /Invalid fixture approval/)
  assert.throws(() => fixturePolicy({ branches: [] }, 'refs/heads/feat/test', sha), /Invalid isolated/)
  assert.throws(() => fixturePolicy({ branches: { 'refs/heads/feat/test': {sha,cas:true,subscriber:true,probe:true,expiresAt:Date.now()-1,artifacts:{}} } }, 'refs/heads/feat/test', sha), /Invalid fixture approval/)
})

test('fixture Vault keys are stable for a release and distinct between releases and branches', () => {
  const root = 'ab'.repeat(32), selector = 'branch-' + 'a'.repeat(24)
  const key = fixtureVaultKey(root, selector, sha)
  assert.match(key, /^[a-f0-9]{64}$/)
  assert.equal(key, fixtureVaultKey(root, selector, sha))
  assert.notEqual(key, fixtureVaultKey(root, selector, 'b'.repeat(40)))
  assert.notEqual(key, fixtureVaultKey(root, 'branch-' + 'b'.repeat(24), sha))
  assert.notEqual(key, fixtureScheduleKey(root, selector, sha))
  assert.throws(() => fixtureVaultKey('too-short', selector, sha), /Invalid/)
})
