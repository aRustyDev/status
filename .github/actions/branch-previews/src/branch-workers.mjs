import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { installation } from './installation.mjs'

const allowedBindings = new Set(['r2_buckets','kv_namespaces','hyperdrive','analytics_engine_datasets','durable_objects','queues','send_email'])

export function createBranchConfigs({ settings, selector, sha, branchDir, dir }) {
  if (!/^branch-[0-9a-f]{24}$/.test(selector) || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('Invalid branch release identity')
  const app = installation()
  const { components, compatibilityDate } = app.manifest
  const stem = app.workerStem(selector, sha)
  const names = Object.fromEntries(Object.entries(components).map(([id,c]) => [id, stem + '-' + c.suffix]))
  const order = Object.keys(components)
  for (const key of Object.keys(settings.resourceBindings || {})) if (!Object.hasOwn(names,key)) throw new Error('Unexpected component binding')
  for (const [id, component] of Object.entries(components)) {
    const vars = { ...settings[component.settingsVars], ...component.vars }
    for (const [key,source] of Object.entries(component.fromSettings || {})) {
      if (settings[source] !== undefined) vars[key] = settings[source]
      else if (!(key in vars)) throw new Error('Missing environment setting ' + source)
    }
    if (component.subscriberScope) vars.PREVIEW_SUBSCRIBER_SCOPE = createHash('sha256').update(selector).digest('hex')
    if (component.releaseVar || id === 'gateway') vars.PREVIEW_RELEASE = sha
    if (id === 'gateway') vars.PREVIEW_SELECTOR = selector
    const services = [...(settings.extraServices?.[id] || []), ...Object.entries(component.services || {}).map(([binding,target]) => ({ binding, service:names[target] }))]
    const config = {name:names[id], main:path.join(branchDir, 'workers', id + '.mjs'), compatibility_date:compatibilityDate, workers_dev:false, preview_urls:false, observability:{enabled:true}, vars, services, triggers:{crons:[]} }
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
    writeFileSync(path.join(dir,id + '.json'), JSON.stringify(config), {mode:0o600})
  }
  return { names, order }
}

export async function deployBranchWorkers({ settings, selector, sha, branchDir, dir, run, installSecrets }) {
  const {names,order} = createBranchConfigs({settings,selector,sha,branchDir,dir})
  for (const dry of [true,false]) {
    for (const id of order) {
      const args = ['deploy','--no-bundle','--config',path.join(dir,id + '.json'),'--experimental-auto-create=false']
      if (dry) args.push('--dry-run')
      await run(args)
      if (!dry) await installSecrets(id,names[id])
    }
  }
  return names
}
