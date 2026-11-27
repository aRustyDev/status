import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { installation } from './installation.mjs'
import { fixtureCatalog } from './fixture-catalog.mjs'

const allowedBindings = new Set(['r2_buckets','kv_namespaces','hyperdrive','analytics_engine_datasets','durable_objects','queues','send_email'])

export function createBranchConfigs({ settings, selector, sha, branchDir, dir, subscriber = null, appId }) {
  if (!/^branch-[0-9a-f]{24}$/.test(selector) || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('Invalid branch release identity')
  const app = installation()
  const { components, compatibilityDate } = app.manifest
  const stem = app.workerStem(selector, sha)
  const names = Object.fromEntries(Object.entries(components).map(([id,c]) => [id, stem + '-' + c.suffix]))
  const order = Object.keys(components)
  const fixture = settings.isolatedFixture
  if (fixture && subscriber) throw new Error('Legacy subscriber approval and isolated fixtures are mutually exclusive')
  if (fixture) {
    if (settings.databaseOwned !== true || !settings.d1DatabaseId || !settings.d1DatabaseName) throw new Error('Isolated fixtures require an owned database')
    if (typeof fixture !== 'object' || Array.isArray(fixture) || Object.keys(fixture).some(key => !['source','casSource','wrappers','subscriber','probe','expiresAt'].includes(key)) || !path.isAbsolute(fixture.source || '') || (fixture.casSource !== undefined && !path.isAbsolute(fixture.casSource)) || (fixture.subscriber !== undefined && typeof fixture.subscriber !== 'boolean') || (fixture.probe !== undefined && typeof fixture.probe !== 'boolean')) throw new Error('Invalid isolated fixture source')
    if (fixture.casSource && path.resolve(fixture.casSource) !== path.resolve(branchDir, 'workers', 'cas.mjs')) throw new Error('CAS source must be the feature artifact')
    if (!Number.isSafeInteger(fixture.expiresAt) || fixture.expiresAt <= Date.now() || fixture.expiresAt > Date.now()+48*3600_000) throw new Error('Invalid fixture approval expiry')
    const wrappers = fixture.wrappers
    const required = ['fixture', ...(fixture.probe ? ['probe','probeScheduler'] : []), ...(fixture.subscriber ? ['api','subscriberFeature','subscriberScheduler','mailer','authorization'] : [])]
    if (!wrappers || typeof wrappers !== 'object' || Array.isArray(wrappers) || Object.keys(wrappers).some(id => !required.includes(id)) || required.some(id => typeof wrappers[id] !== 'string' || path.resolve(wrappers[id]) !== path.resolve(dir, `trusted-${id}.mjs`))) throw new Error('Invalid trusted fixture wrappers')
    if (!settings.internalScheduling) throw new Error('Fixture execution requires a trusted fence')
    if (Object.keys(settings.extraServices || {}).some(key => (settings.extraServices[key] || []).length) || (settings.vpcServices || []).length) throw new Error('Isolated fixtures forbid external services')
    for (const bindings of Object.values(settings.resourceBindings || {})) {
      if (Object.keys(bindings).length) throw new Error('Isolated fixtures forbid shared resources')
    }
    const suffixes = new Set(Object.values(components).map(c => c.suffix))
    if (names.fixture || names.cas || suffixes.has('fixture') || suffixes.has('cas')) throw new Error('Reserved fixture component')
    names.fixture = `${stem}-fixture`
    if (fixture.casSource) names.cas = `${stem}-cas`
    const shared = { compatibility_date: compatibilityDate, workers_dev: false, preview_urls: false, observability: { enabled: true }, d1_databases: [{ binding: 'DB', database_id: settings.d1DatabaseId, database_name: settings.d1DatabaseName }], triggers: { crons: [] } }
    writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify({ ...shared, name: names.fixture, main: fixture.wrappers.fixture, services:[{binding:'PREVIEW_FENCE',service:`${stem}-fence`}] }), { mode: 0o600 })
    // Services must exist before the Workers which consume them.
    order.unshift('fixture')
  }
  for (const key of Object.keys(settings.resourceBindings || {})) if (!Object.hasOwn(names,key)) throw new Error('Unexpected component binding')
  const fixtureService = fixture && { binding: 'PREVIEW_FIXTURE', service: names.fixture }
  const catalog = fixture && fixtureCatalog(names.fixture, sha, Boolean(fixture.casSource))
  const fixtureEndpoints = fixture && JSON.stringify(catalog.endpoints)
  if (fixture?.casSource) {
    const config = { name: names.cas, main: fixture.casSource, compatibility_date: compatibilityDate, workers_dev: false, preview_urls: false, observability: { enabled: true }, d1_databases: [{ binding: 'DB', database_id: settings.d1DatabaseId, database_name: settings.d1DatabaseName }], triggers: { crons: [] }, vars: { ENDPOINTS: fixtureEndpoints, MONITOR_AUTH_READY: 'true', MONITOR_CAS_READY: 'true' }, services: [fixtureService] }
    writeFileSync(path.join(dir, 'cas.json'), JSON.stringify(config), { mode: 0o600 })
    order.splice(1, 0, 'cas')
  }
  const scheduling = settings.internalScheduling
  if (scheduling) {
    if (!fixture || settings.databaseOwned !== true || !scheduling.names || !scheduling.configs) throw new Error('Scheduling requires an isolated fixture')
    const { names: scheduledNames, configs } = scheduling
    if (Object.keys(scheduledNames).sort().join(',') !== 'fence,probeScheduler' || Object.keys(configs).sort().join(',') !== 'fence,probeScheduler' ||
        scheduledNames.fence !== `${stem}-fence` || scheduledNames.probeScheduler !== `${stem}-probe-scheduler`) throw new Error('Invalid scheduled Worker names')
    const fence = configs.fence, scheduler = configs.probeScheduler
    const fields = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key))
    const common = ['name', 'main', 'compatibility_date', 'workers_dev', 'preview_urls', 'observability', 'triggers']
    if (!fields(fence, [...common, 'vars', 'd1_databases', 'flagship']) || !fields(scheduler, [...common, 'services']) ||
        fence.name !== scheduledNames.fence || scheduler.name !== scheduledNames.probeScheduler ||
        !path.isAbsolute(fence.main || '') || !path.isAbsolute(scheduler.main || '') ||
        fence.compatibility_date !== compatibilityDate || scheduler.compatibility_date !== compatibilityDate ||
        fence.workers_dev !== false || fence.preview_urls !== false || scheduler.workers_dev !== false || scheduler.preview_urls !== false ||
        JSON.stringify(fence.triggers?.crons) !== '[]' || JSON.stringify(scheduler.triggers?.crons) !== '["* * * * *"]' ||
        fence.vars?.PREVIEW_SELECTOR !== selector || fence.vars?.PREVIEW_RELEASE !== sha || fence.vars?.PREVIEW_FLAG_PREFIX !== app.flagPrefix || fence.vars?.PREVIEW_FIXTURE_EXPIRES_AT !== String(fixture.expiresAt) ||
        !Array.isArray(fence.d1_databases) || fence.d1_databases.length !== 1 || fence.d1_databases[0].binding !== 'INVENTORY' ||
        !fence.d1_databases[0].database_id || fence.d1_databases[0].database_id === settings.d1DatabaseId ||
        !Array.isArray(fence.flagship) || fence.flagship.length !== 1 || fence.flagship[0].binding !== 'FLAGS' || !fence.flagship[0].app_id ||
        JSON.stringify(scheduler.services) !== JSON.stringify([{ binding: 'PREVIEW_FENCE', service: scheduledNames.fence }, { binding: 'PROBE', service: names.probe }])) throw new Error('Invalid scheduled Worker configuration')
    if (names.fence || names.probeScheduler || Object.values(components).some(c => ['fence', 'probe-scheduler'].includes(c.suffix))) throw new Error('Reserved scheduled component')
    names.fence = scheduledNames.fence
    if (fixture.probe) names.probeScheduler = scheduledNames.probeScheduler
    writeFileSync(path.join(dir, 'fence.json'), JSON.stringify(fence), { mode: 0o600 })
    if (fixture.probe) writeFileSync(path.join(dir, 'probeScheduler.json'), JSON.stringify({ ...scheduler, main: fixture.wrappers.probeScheduler }), { mode: 0o600 })
    // No release can execute until the controller finishes activation.
    order.unshift('fence')
    if (fixture.probe) order.push('probeScheduler')
  }
  let subscriberVars
  if (fixture?.subscriber) {
    const mail = settings.internalSubscriber
    const address = value => typeof value === 'string' && value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value)
    let origin
    try { const url = new URL(mail?.publicUrl); if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.origin !== mail.publicUrl) throw new Error(); origin = url.origin } catch { throw new Error('Invalid trusted subscriber configuration') }
    if (!mail || typeof mail !== 'object' || Array.isArray(mail) || Object.keys(mail).some(key => !['from','to','publicUrl'].includes(key)) || !address(mail.from) || !address(mail.to)) throw new Error('Invalid trusted subscriber configuration')
    const suffixes = new Set(Object.values(components).map(c => c.suffix))
    if (names.mailer || names.subscriberFeature || names.subscriberScheduler || names.authorization || ['mailer','subscriber-feature','subscriber-scheduler','authorization'].some(s => suffixes.has(s))) throw new Error('Reserved subscriber component')
    names.mailer = `${stem}-mailer`
    names.subscriberFeature = `${stem}-subscriber-feature`
    names.subscriberScheduler = `${stem}-subscriber-scheduler`
    names.authorization = `${stem}-authorization`
    subscriberVars = { SUBSCRIBERS_READY:'true', SUBSCRIBER_EMAIL_READY:'true', SUBSCRIBER_EMAIL_FROM:mail.from, SUBSCRIBER_EMAIL_DESTINATIONS:JSON.stringify([{id:'preview',name:'Preview recipient',address:mail.to}]), SUBSCRIBER_PUBLIC_URL:origin, PREVIEW_SUBSCRIBER_REQUIRED:'true', PREVIEW_SUBSCRIBER_SCOPE:createHash('sha256').update(selector).digest('hex'), PREVIEW_SELECTOR:selector, PREVIEW_RELEASE:sha, PREVIEW_DATABASE_ISOLATED:'true' }
    const common = { compatibility_date:compatibilityDate, workers_dev:false, preview_urls:false, observability:{enabled:true} }
    const mailer = { ...common, name:names.mailer, main:fixture.wrappers.mailer, vars:{PREVIEW_MAIL_FROM:mail.from,PREVIEW_MAIL_TO:mail.to,PREVIEW_MAIL_PUBLIC_URL:origin}, services:[{binding:'PREVIEW_FENCE',service:names.fence}], send_email:[{name:'EMAIL',allowed_sender_addresses:[mail.from],allowed_destination_addresses:[mail.to]}], triggers:{crons:[]} }
    const feature = { ...common, name:names.subscriberFeature, main:fixture.wrappers.subscriberFeature, vars:subscriberVars, d1_databases:[{binding:'DB',database_id:settings.d1DatabaseId,database_name:settings.d1DatabaseName}], services:[{binding:'PREVIEW_MAILER',service:names.mailer}], triggers:{crons:[]} }
    const scheduler = { ...common, name:names.subscriberScheduler, main:fixture.wrappers.subscriberScheduler, services:[{binding:'PREVIEW_FENCE',service:names.fence},{binding:'SUBSCRIBER_FEATURE',service:names.subscriberFeature}], triggers:{crons:['* * * * *']} }
    const authorization = { ...common, name:names.authorization, main:fixture.wrappers.authorization, vars:{PREVIEW_SELECTOR:selector,PREVIEW_RELEASE:sha,PREVIEW_SUBSCRIBER_SCOPE:subscriberVars.PREVIEW_SUBSCRIBER_SCOPE,PREVIEW_DATABASE_ISOLATED:'true'}, d1_databases:[{binding:'DB',database_id:settings.d1DatabaseId,database_name:settings.d1DatabaseName}], services:[{binding:'PREVIEW_FENCE',service:names.fence}], triggers:{crons:[]} }
    for (const [id,config] of Object.entries({mailer,subscriberFeature:feature,subscriberScheduler:scheduler,authorization})) writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(config), { mode:0o600 })
    order.splice(order.indexOf('fence')+1, 0, 'mailer', 'subscriberFeature', 'authorization')
    order.push('subscriberScheduler')
  } else if (settings.internalSubscriber) throw new Error('Unexpected subscriber configuration')
  for (const [id, component] of Object.entries(components)) {
    const vars = { ...settings[component.settingsVars], ...component.vars }
    for (const [key,source] of Object.entries(component.fromSettings || {})) {
      if (settings[source] !== undefined) vars[key] = settings[source]
      else if (!(key in vars)) throw new Error('Missing environment setting ' + source)
    }
    if (component.subscriberScope) vars.PREVIEW_SUBSCRIBER_SCOPE = createHash('sha256').update(selector).digest('hex')
    if (settings.previewEnvironment === 'schema' && (!subscriber || id !== 'api')) {
      for (const key of Object.keys(vars)) if (key.startsWith('SUBSCRIBER_')) delete vars[key]
    }
    if (subscriber && id === 'api') Object.assign(vars, { PREVIEW_BRANCH_MODE:'schema', PREVIEW_SELECTOR:selector, PREVIEW_SLOT:'1', PREVIEW_TARGET:'a', SUBSCRIBERS_READY:'true', SUBSCRIBER_EMAIL_READY:'true', SUBSCRIBER_EMAIL_FROM:subscriber.sender, SUBSCRIBER_EMAIL_DESTINATIONS:JSON.stringify([{id:'preview-test',name:'Preview test',address:subscriber.recipient}]), SUBSCRIBER_PUBLIC_URL:subscriber.publicUrl })
    if (component.releaseVar || id === 'gateway') vars.PREVIEW_RELEASE = sha
    if (id === 'gateway') vars.PREVIEW_SELECTOR = selector
    const services = [...(settings.extraServices?.[id] || []), ...Object.entries(component.services || {}).map(([binding,target]) => ({ binding, service:names[target] }))]
    if (fixture && ['api', 'statusApi', 'monitoring', 'probe'].includes(id)) {
      if (services.some(service => ['PREVIEW_FIXTURE', 'CAS_PROBE'].includes(service.binding))) throw new Error('Conflicting fixture service')
      services.push(fixtureService)
      vars.ENDPOINTS = fixtureEndpoints
      vars.CHANNELS_READY = 'false'
      vars.EMAIL_READY = 'false'
      if (id === 'api' || id === 'probe') {
        vars.ACTIONS_READY = 'true'
        vars.ACTION_ENDPOINTS = JSON.stringify(catalog.actions)
      }
      if (id === 'api' && subscriberVars) {
        Object.assign(vars, subscriberVars)
        services.push({ binding:'PREVIEW_MAILER', service:names.mailer })
        services.push({ binding:'PREVIEW_AUTHORIZATION', service:names.authorization })
      }
      if (fixture.casSource) {
        vars.MONITOR_AUTH_READY = 'true'
        vars.MONITOR_CAS_READY = 'true'
        if (id === 'probe') services.push({ binding: 'CAS_PROBE', service: names.cas })
      }
    }
    const config = {name:names[id], main:path.join(branchDir, 'workers', id + '.mjs'), compatibility_date:compatibilityDate, workers_dev:false, preview_urls:false, observability:{enabled:true}, vars, services, triggers:{crons:[]} }
    if (fixture?.wrappers?.[id] && ((id === 'probe' && fixture.probe) || (id === 'api' && fixture.subscriber))) config.main = fixture.wrappers[id]
    if (component.assets) config.assets = {directory:path.join(branchDir,'assets',id), binding:'ASSETS',run_worker_first:true}
    if (component.database) {
      if (!settings.d1DatabaseId || !settings.d1DatabaseName) throw new Error('Missing database identity')
      config.d1_databases = [{ binding:'DB', database_id:settings.d1DatabaseId, database_name:settings.d1DatabaseName }]
    }
    if (component.vpc) config.vpc_services = settings.vpcServices || []
    for (const [key,value] of Object.entries(settings.resourceBindings?.[id] || {})) {
      if (!allowedBindings.has(key) || (key === 'queues' && (!value || Object.keys(value).some(k => k !== 'producers')))) throw new Error('Unsupported resource binding ' + key)
      config[key] = value
    }
    if (settings.previewEnvironment === 'schema' && (!subscriber || id !== 'api') && Array.isArray(config.send_email)) {
      config.send_email = config.send_email.filter(binding => binding?.name !== 'SUBSCRIBER_EMAIL')
      if (!config.send_email.length) delete config.send_email
    }
    if (subscriber && id === 'api') {
      if (!appId) throw new Error('Missing schema authorization service')
      config.send_email = [{name:'SUBSCRIBER_EMAIL', allowed_sender_addresses:[subscriber.sender], allowed_destination_addresses:[subscriber.recipient]}]
      config.flagship = [{binding:'FLAGS',app_id:appId}]
    }
    writeFileSync(path.join(dir,id + '.json'), JSON.stringify(config), {mode:0o600})
  }
  if (subscriber) {
    if (!appId || !settings.d1DatabaseId || !settings.d1DatabaseName) throw new Error('Missing isolated scheduler configuration')
    names.subscriber = stem + '-subscriber'
    order.push('subscriber')
    const vars = { PREVIEW_BRANCH_MODE:'schema', PREVIEW_SELECTOR:selector, PREVIEW_RELEASE:sha, PREVIEW_SLOT:'1', PREVIEW_TARGET:'a', PREVIEW_SUBSCRIBER_REQUIRED:'true', PREVIEW_SUBSCRIBER_SCOPE:createHash('sha256').update(selector).digest('hex'), SUBSCRIBERS_READY:'true', SUBSCRIBER_EMAIL_READY:'true', SUBSCRIBER_EMAIL_FROM:subscriber.sender, SUBSCRIBER_EMAIL_DESTINATIONS:JSON.stringify([{id:'preview-test',name:'Preview test',address:subscriber.recipient}]), SUBSCRIBER_PUBLIC_URL:subscriber.publicUrl }
    const config = {name:names.subscriber, main:path.join(branchDir,'workers/subscriber.mjs'), compatibility_date:compatibilityDate, workers_dev:false, preview_urls:false, observability:{enabled:true}, vars, d1_databases:[{binding:'DB',database_id:settings.d1DatabaseId,database_name:settings.d1DatabaseName}], flagship:[{binding:'FLAGS',app_id:appId}], send_email:[{name:'SUBSCRIBER_EMAIL',allowed_sender_addresses:[subscriber.sender],allowed_destination_addresses:[subscriber.recipient]}], triggers:{crons:['* * * * *']}}
    writeFileSync(path.join(dir,'subscriber.json'), JSON.stringify(config), {mode:0o600})
  }
  return { names, order }
}

export async function deployBranchWorkers({ settings, selector, sha, branchDir, dir, run, installSecrets, subscriber = null, appId }) {
  const {names,order} = createBranchConfigs({settings,selector,sha,branchDir,dir,subscriber,appId})
  for (const dry of [true,false]) {
    for (const id of order) {
      const args = ['deploy','--no-bundle','--config',path.join(dir,id + '.json'),'--experimental-auto-create=false']
      if (dry) args.push('--dry-run')
      await run(args)
      if (!dry && !['fixture','fence','mailer','authorization'].includes(id)) await installSecrets(id,names[id])
    }
  }
  return names
}
