import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createBranchConfigs, deployBranchWorkers } from './branch-workers.mjs'
import { installation } from './installation.mjs'
import { createFixtureSchedulingConfigs } from './fixture-scheduling-config.mjs'

const settings = { d1DatabaseId: 'id', d1DatabaseName: 'db', accessTeamDomain: 'access', accessAud: 'aud', endpoints: '[]', apiVars: { SUBSCRIBERS_READY: 'true' } }
const selector = 'branch-' + 'a'.repeat(24)
const sha = 'b'.repeat(40)

test('creates a private release stack with the selected database and disabled schedules', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'branch-workers-test-'))
  try {
    const { names, order } = createBranchConfigs({ settings, selector, sha, branchDir: '/feature', dir })
    assert.equal(order.at(-1), 'gateway')
    assert.equal(new Set(Object.values(names)).size, order.length)
    for (const name of order) {
      const config = JSON.parse(readFileSync(path.join(dir, `${name}.json`)))
      assert.equal(config.workers_dev, false)
      assert.equal(config.preview_urls, false)
      assert.ok(names[name].length <= 63)
      if (config.d1_databases) assert.equal(config.d1_databases[0].database_id, 'id')
      assert.deepEqual(config.triggers?.crons ?? [], [])
    }
    const api = JSON.parse(readFileSync(path.join(dir, 'api.json')))
    assert.equal(api.vars.SUBSCRIBERS_READY, 'false')
    assert.equal(api.vars.SUBSCRIBER_EMAIL_READY, 'false')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('runs every dry run before deployment and stops after a secret failure', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'branch-workers-test-'))
  const events = []
  try {
    await assert.rejects(deployBranchWorkers({ settings, selector, sha, branchDir: '/feature', dir,
      run: async args => events.push(args.includes('--dry-run') ? 'dry' : 'deploy'),
      installSecrets: async name => { events.push(`secret:${name}`); throw new Error('secret failed') },
    }), /secret failed/)
    assert.deepEqual(events.slice(0, 7), Array(7).fill('dry'))
    assert.deepEqual(events.slice(7), ['deploy', 'secret:probe'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('isolated fixtures use only release-owned Workers and the owned database', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'branch-workers-test-'))
  try {
    const fixtureSettings = { ...settings, databaseOwned: true, isolatedFixture: { source: '/trusted/fixture.mjs', casSource: '/feature/workers/cas.mjs' } }
    const { names, order } = createBranchConfigs({ settings: fixtureSettings, selector, sha, branchDir: '/feature', dir })
    assert.deepEqual(order.slice(0, 3), ['fixture', 'cas', 'probe'])
    for (const id of ['fixture', 'cas']) {
      const config = JSON.parse(readFileSync(path.join(dir, `${id}.json`)))
      assert.equal(config.name, names[id])
      assert.equal(config.workers_dev, false)
      assert.equal(config.preview_urls, false)
      assert.deepEqual(config.triggers.crons, [])
      assert.equal(config.d1_databases[0].database_id, settings.d1DatabaseId)
      assert.equal(config.routes, undefined)
    }
    const probe = JSON.parse(readFileSync(path.join(dir, 'probe.json')))
    const api = JSON.parse(readFileSync(path.join(dir, 'api.json')))
    assert.deepEqual(probe.services.filter(s => ['PREVIEW_FIXTURE', 'CAS_PROBE'].includes(s.binding)), [{ binding: 'PREVIEW_FIXTURE', service: names.fixture }, { binding: 'CAS_PROBE', service: names.cas }])
    assert.equal(api.vars.ACTIONS_READY, 'true')
    assert.equal(JSON.parse(api.vars.ACTION_ENDPOINTS)[0].serviceId, names.fixture)
    assert.equal(JSON.parse(api.vars.ENDPOINTS)[1].authProviders.cas.url, 'https://preview-fixture.invalid/cas/v1/tickets')
    assert.throws(() => createBranchConfigs({ settings: { ...fixtureSettings, databaseOwned: false }, selector, sha, branchDir: '/feature', dir }), /owned database/)
    assert.throws(() => createBranchConfigs({ settings: { ...fixtureSettings, isolatedFixture: { source: '/trusted/fixture.mjs', casSource: '/other/cas.mjs' } }, selector, sha, branchDir: '/feature', dir }), /feature artifact/)
    assert.throws(() => createBranchConfigs({ settings: { ...fixtureSettings, extraServices: { api: [{ binding: 'EVIL', service: 'shared' }] } }, selector, sha, branchDir: '/feature', dir }), /external services/)
    assert.throws(() => createBranchConfigs({ settings: { ...fixtureSettings, resourceBindings: { api: { r2_buckets: [] } } }, selector, sha, branchDir: '/feature', dir }), /shared resources/)
    assert.throws(() => createBranchConfigs({ settings: { ...fixtureSettings, resourceBindings: { api: { send_email: [] } } }, selector, sha, branchDir: '/feature', dir }), /shared resources/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('installs isolated CAS secrets but no fixture secrets', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'branch-workers-test-'))
  const installed = []
  try {
    await deployBranchWorkers({ settings: { ...settings, databaseOwned: true, isolatedFixture: { source: '/trusted/fixture.mjs', casSource: '/feature/workers/cas.mjs' } }, selector, sha, branchDir: '/feature', dir,
      run: async () => {}, installSecrets: async (component, name) => installed.push([component, name]),
    })
    assert.equal(installed.some(([component]) => component === 'fixture'), false)
    assert.equal(installed.filter(([component]) => component === 'cas').length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('owned scheduled fixtures deploy their fence first and scheduler last without exposing control D1', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'branch-workers-test-'))
  const app = installation(), ref = 'refs/heads/feat/scheduled', select = `branch-${app.branchKey(ref)}`, stem = app.workerStem(select, sha)
  const scheduling = createFixtureSchedulingConfigs({ ref, selector: select, sha, database: { id: 'id', name: app.schemaStem(ref,sha)+'-upgrade', owned: true }, inventoryDatabase: { id: 'inventory', name: 'inventory' }, sharedDatabaseIds: ['dev','stage','prod'], flagshipAppId: 'flagship', runtimeDir: '/trusted/runtime', probeName: `${stem}-probe`, dir })
  const fixtureSettings = { ...settings, databaseOwned: true, isolatedFixture: { source: '/trusted/fixture.mjs', probe:true, wrappers:{probe:path.join(dir,'trusted-probe.mjs'),probeScheduler:path.join(dir,'trusted-probeScheduler.mjs')} }, internalScheduling: { names: scheduling.names, configs: scheduling.configs } }
  try {
    const { names, order } = createBranchConfigs({ settings: fixtureSettings, selector: select, sha, branchDir: '/feature', dir })
    assert.equal(order[0], 'fence')
    assert.equal(order.at(-1), 'probeScheduler')
    assert.ok(order.indexOf('probeScheduler') > order.indexOf('probe'))
    assert.equal(names.fence, `${stem}-fence`)
    assert.equal(names.probeScheduler, `${stem}-probe-scheduler`)
    for (const id of Object.keys(app.manifest.components)) {
      const config = JSON.parse(readFileSync(path.join(dir, `${id}.json`)))
      assert.ok(!(config.d1_databases || []).some(d => d.database_id === 'inventory' || d.binding === 'INVENTORY'))
      assert.deepEqual(config.triggers.crons, [])
    }
    const installed=[]
    await deployBranchWorkers({ settings: fixtureSettings, selector: select, sha, branchDir: '/feature', dir, run: async () => {}, installSecrets: async id => installed.push(id) })
    assert.equal(installed.includes('fence'), false)
    assert.equal(installed.includes('fixture'), false)
    assert.equal(installed.at(-1), 'probeScheduler')
    assert.throws(() => createBranchConfigs({ settings: { ...fixtureSettings, isolatedFixture: undefined }, selector: select, sha, branchDir: '/feature', dir }), /isolated fixture/)
    assert.throws(() => createBranchConfigs({ settings: { ...fixtureSettings, internalScheduling: { ...fixtureSettings.internalScheduling, names: { ...scheduling.names, fence: 'shared-worker' } } }, selector: select, sha, branchDir: '/feature', dir }), /scheduled Worker names/)
    assert.throws(() => createBranchConfigs({ settings: { ...fixtureSettings, internalScheduling: { ...fixtureSettings.internalScheduling, configs: { ...scheduling.configs, probeScheduler: { ...scheduling.configs.probeScheduler, routes: ['example.com/*'] } } } }, selector: select, sha, branchDir: '/feature', dir }), /scheduled Worker configuration/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('subscriber fixtures keep the mail provider and fence in trusted private Workers', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'branch-workers-test-'))
  const app = installation(), ref = 'refs/heads/feat/subscriber', select = `branch-${app.branchKey(ref)}`, stem = app.workerStem(select, sha)
  const scheduling = createFixtureSchedulingConfigs({ ref, selector: select, sha, database: { id: 'id', name: app.schemaStem(ref,sha)+'-upgrade', owned: true }, inventoryDatabase: { id: 'inventory', name: 'inventory' }, sharedDatabaseIds: ['dev','stage','prod'], flagshipAppId: 'flagship', runtimeDir: '/trusted/runtime', probeName: `${stem}-probe`, dir })
  const fixtureSettings = { ...settings, databaseOwned:true, isolatedFixture:{source:'/trusted/fixture.mjs',subscriber:true,wrappers:Object.fromEntries(['api','subscriberFeature','subscriberScheduler','mailer'].map(name=>[name,path.join(dir,`trusted-${name}.mjs`)]))}, internalScheduling:{names:scheduling.names,configs:scheduling.configs}, internalSubscriber:{from:'sender@example.test',to:'owner@example.test',publicUrl:'https://status.example.test'} }
  try {
    const { names,order } = createBranchConfigs({settings:fixtureSettings,selector:select,sha,branchDir:'/feature',dir})
    assert.deepEqual(order.slice(0,3),['fence','mailer','subscriberFeature'])
    assert.ok(order.indexOf('mailer') < order.indexOf('api'))
    assert.equal(order.at(-1), 'subscriberScheduler')
    assert.equal(names.probeScheduler, undefined)
    const mailer=JSON.parse(readFileSync(path.join(dir,'mailer.json')))
    const feature=JSON.parse(readFileSync(path.join(dir,'subscriberFeature.json')))
    const scheduler=JSON.parse(readFileSync(path.join(dir,'subscriberScheduler.json')))
    const api=JSON.parse(readFileSync(path.join(dir,'api.json')))
    assert.deepEqual(mailer.send_email, [{name:'EMAIL',allowed_sender_addresses:['sender@example.test'],allowed_destination_addresses:['owner@example.test']}])
    assert.deepEqual(mailer.services,[{binding:'PREVIEW_FENCE',service:names.fence}])
    assert.equal(mailer.d1_databases,undefined)
    assert.equal(api.send_email,undefined)
    assert.equal(api.services.find(s=>s.binding==='PREVIEW_MAILER').service,names.mailer)
    assert.equal(api.services.some(s=>s.binding==='PREVIEW_FENCE'),false)
    assert.equal(api.main,fixtureSettings.isolatedFixture.wrappers.api)
    assert.equal(api.vars.SUBSCRIBERS_READY,'true')
    assert.equal(api.vars.SUBSCRIBER_PUBLIC_URL,'https://status.example.test')
    assert.equal(feature.d1_databases[0].database_id,'id')
    assert.equal(feature.send_email,undefined)
    assert.deepEqual(feature.services,[{binding:'PREVIEW_MAILER',service:names.mailer}])
    assert.deepEqual(feature.triggers.crons,[])
    assert.deepEqual(scheduler.triggers.crons,['* * * * *'])
    assert.equal(scheduler.d1_databases,undefined)
    assert.equal(scheduler.send_email,undefined)
    assert.deepEqual(scheduler.services,[{binding:'PREVIEW_FENCE',service:names.fence},{binding:'SUBSCRIBER_FEATURE',service:names.subscriberFeature}])
    const installed=[]
    await deployBranchWorkers({settings:fixtureSettings,selector:select,sha,branchDir:'/feature',dir,run:async()=>{},installSecrets:async id=>installed.push(id)})
    assert.equal(installed.includes('fence'),false)
    assert.equal(installed.includes('mailer'),false)
    assert.ok(installed.includes('subscriberFeature') && installed.includes('subscriberScheduler'))
    for (const bad of [
      {...fixtureSettings,internalSubscriber:{...fixtureSettings.internalSubscriber,to:'attacker@example.test\nBCC: x'}},
      {...fixtureSettings,internalSubscriber:{...fixtureSettings.internalSubscriber,publicUrl:'https://status.example.test/'}},
      {...fixtureSettings,internalScheduling:undefined},
      {...fixtureSettings,isolatedFixture:{...fixtureSettings.isolatedFixture,wrappers:{...fixtureSettings.isolatedFixture.wrappers,api:'/branch/untrusted.mjs'}}},
    ]) assert.throws(()=>createBranchConfigs({settings:bad,selector:select,sha,branchDir:'/feature',dir}))
  } finally { rmSync(dir,{recursive:true,force:true}) }
})
