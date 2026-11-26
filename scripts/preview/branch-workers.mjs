import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

function fail(message) { throw new Error(message) }
function scopeFor(selector) { return createHash('sha256').update(selector).digest('hex') }

export function createBranchConfigs({ settings, selector, sha, branchDir, dir }) {
  if (!/^branch-[0-9a-f]{24}$/.test(selector) || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('Invalid branch release identity')
  for (const key of ['d1DatabaseId', 'd1DatabaseName', 'accessTeamDomain', 'accessAud', 'endpoints']) {
    if (typeof settings[key] !== 'string' || !settings[key] || settings[key].startsWith('REPLACE_')) fail(`Missing preview setting ${key}`)
  }
  const stem = `status-p-${createHash('sha256').update(selector + ':' + sha).digest('hex').slice(0, 24)}`
  const names = { gateway: `${stem}-gateway`, api: `${stem}-operations`, statusApi: `${stem}-status-api`, monitoring: `${stem}-monitoring-api`, status: `${stem}-status-ui`, admin: `${stem}-admin-ui`, probe: `${stem}-probe` }
  const shared = { workers_dev: false, preview_urls: false, observability: { enabled: true }, compatibility_date: '2026-11-23' }
  const database = [{ binding: 'DB', database_id: settings.d1DatabaseId, database_name: settings.d1DatabaseName }]
  const scope = scopeFor(selector)
  const vars = { ACCESS_TEAM_DOMAIN: settings.accessTeamDomain, ACCESS_AUD: settings.accessAud, ENDPOINTS: settings.endpoints, PREVIEW_SUBSCRIBER_REQUIRED: 'true', PREVIEW_SUBSCRIBER_SCOPE: scope, PREVIEW_RELEASE: sha, SUBSCRIBERS_READY: 'false', SUBSCRIBER_EMAIL_READY: 'false' }
  const assets = directory => ({ directory: path.join(branchDir, directory), binding: 'ASSETS', run_worker_first: true })
  const source = name => path.join(branchDir, name)
  const extra = settings.extraServices || {}
  const services = name => extra[name] || []
  const wrapper = path.join(dir, 'preview-gateway.ts')
  writeFileSync(wrapper, `import gateway from ${JSON.stringify(source('apps/gateway/index.ts'))}\nexport default {\n  async fetch(request, env, ctx) {\n    if (request.headers.get('X-Status-Preview') !== env.PREVIEW_SELECTOR || request.headers.get('X-Status-Preview-Release') !== env.PREVIEW_RELEASE) return new Response('Preview unavailable', { status: 503 })\n    if (request.method === 'GET' && new URL(request.url).pathname === '/__preview/verify' && request.headers.get('X-Status-Preview-Probe') === '1') return new Response(null, { status: 204 })\n    const headers = new Headers(request.headers)\n    headers.delete('X-Status-Preview')\n    headers.delete('X-Status-Preview-Release')\n    headers.delete('X-Status-Preview-Probe')\n    return gateway.fetch(new Request(request, { headers }), { ...env, PREVIEW_SELECTOR: undefined, PREVIEW_RELEASE: undefined }, ctx)\n  }\n}\n`, { mode: 0o600 })
  const configs = {
    probe: { ...shared, main: source('apps/probe/src/index.ts'), name: names.probe, vars: { ...settings.probeVars, ENDPOINTS: settings.endpoints }, d1_databases: database, vpc_services: settings.vpcServices || [], triggers: { crons: [] }, services: services('probe') },
    api: { ...shared, main: source('apps/gateway/api.ts'), name: names.api, assets: assets('apps/board/dist'), vars: { ...settings.apiVars, ...vars, API_SCOPE: 'operations' }, d1_databases: database, services: services('api') },
    statusApi: { ...shared, main: source('apps/gateway/api.ts'), name: names.statusApi, assets: assets('apps/board/dist'), vars: { ...settings.statusApiVars, ...vars, API_SCOPE: 'status' }, d1_databases: database, services: services('statusApi') },
    monitoring: { ...shared, main: source('apps/gateway/api.ts'), name: names.monitoring, assets: assets('apps/board/dist'), vars: { ...settings.monitoringVars, ...vars, API_SCOPE: 'monitoring' }, d1_databases: database, services: [...services('monitoring'), { binding: 'PROBE', service: names.probe }] },
    status: { ...shared, main: source('apps/gateway/assets.ts'), name: names.status, assets: assets('apps/status/dist') },
    admin: { ...shared, main: source('apps/gateway/assets.ts'), name: names.admin, assets: assets('apps/admin/dist') },
    gateway: { ...shared, main: wrapper, name: names.gateway, vars: { UI_MODE: settings.uiMode || 'upstream', PREVIEW_SELECTOR: selector, PREVIEW_RELEASE: sha }, services: [{ binding: 'API', service: names.api }, { binding: 'STATUS_API', service: names.statusApi }, { binding: 'MONITORING_API', service: names.monitoring }, { binding: 'STATUS_UI', service: names.status }, { binding: 'ADMIN_UI', service: names.admin }] },
  }
  const allowedBindings = new Set(['r2_buckets', 'kv_namespaces', 'hyperdrive', 'analytics_engine_datasets', 'durable_objects', 'queues', 'send_email'])
  for (const [name, bindings] of Object.entries(settings.resourceBindings || {})) {
    if (!configs[name] || !bindings || typeof bindings !== 'object' || Array.isArray(bindings)) fail(`Invalid resource bindings for ${name}`)
    for (const [type, value] of Object.entries(bindings)) {
      if (!allowedBindings.has(type)) fail(`Unsupported resource binding type ${type}`)
      if (type === 'queues' && (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'producers'))) fail('Preview queues may only configure producers')
      configs[name][type] = value
    }
  }
  for (const [name, config] of Object.entries(configs)) writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(config), { mode: 0o600 })
  return { names, order: Object.keys(configs) }
}

// The caller supplies the secret installer and owns the inventory and activation.
// No Flagship route is changed here, so a partial upload never selects this release.
export async function deployBranchWorkers({ settings, selector, sha, branchDir, dir, run, installSecrets }) {
  if (typeof run !== 'function' || typeof installSecrets !== 'function') fail('Deployment and secret installation callbacks are required')
  const { names, order } = createBranchConfigs({ settings, selector, sha, branchDir, dir })
  for (const name of order) {
    await run(['deploy', '--dry-run', '--config', path.join(dir, `${name}.json`), '--experimental-auto-create=false'])
  }
  for (const name of order) {
    await run(['deploy', '--config', path.join(dir, `${name}.json`), '--experimental-auto-create=false'])
    await installSecrets(name, names[name])
  }
  return names
}
