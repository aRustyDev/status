import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = process.cwd()
const branchDir = path.resolve(root, 'feature')
const action = process.env.PREVIEW_ACTION
const slot = process.env.PREVIEW_SLOT
const branch = process.env.PREVIEW_BRANCH
const app = process.env.FLAGSHIP_APP_ID
const token = process.env.CLOUDFLARE_API_TOKEN
const account = process.env.CLOUDFLARE_ACCOUNT_ID
const wrangler = path.join(root, 'node_modules/.bin/wrangler')
const key = `status-preview-slot-${slot}`
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' }

function run(args, options = {}) {
  return execFileSync(wrangler, args, { cwd: root, env, encoding: 'utf8', ...options })
}
function fail(message) { throw new Error(message) }
function flagValue() {
  const flag = JSON.parse(run(['flagship', 'flags', 'get', app, key, '--json']))
  if (!flag.enabled || flag.default_variation !== 'current' || flag.rules?.length || !flag.variations || typeof flag.variations.current !== 'object' || !flag.variations.current) fail('Unexpected Flagship slot configuration')
  return flag.variations.current
}
function publish(value) {
  run(['flagship', 'flags', 'update', app, key, '--type', 'json', '--set-variation', `current=${JSON.stringify(value)}`, '--default-variation', 'current', '--clear-rules', '--enable'], { stdio: 'inherit' })
}
function validCurrent(value) {
  return typeof value.selector === 'string' && /^[1-6]\.[a-f0-9]{32}$/.test(value.selector) && ['a', 'b'].includes(value.target) && /^[a-f0-9]{40}$/.test(value.release) && Number.isSafeInteger(value.expiresAt) && typeof value.branch === 'string'
}
function report(value) {
  const message = JSON.stringify(value, null, 2)
  console.log(message)
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `\n\`\`\`json\n${message}\n\`\`\`\n`, { flag: 'a' })
}
const schedulerFiles = [
  'preview-subscriber-scheduler.ts', 'subscriber-delivery.ts', 'subscribers.ts',
  'email-channel.ts', 'idempotency.ts', 'index.ts',
]
function scopeFor(selector) { return createHash('sha256').update(selector).digest('hex') }
function schedulerSupported(settings, release) {
  if (settings.subscriberSchedulingEnabled !== true) return false
  const approved = settings.approvedSubscriberSchedulers?.[release]
  if (!approved || typeof approved !== 'object' || Array.isArray(approved)) return false
  return schedulerFiles.every(name => {
    const file = path.join(branchDir, 'apps/worker/src', name)
    if (!existsSync(file) || !/^[a-f0-9]{64}$/.test(approved[name] || '')) return false
    return createHash('sha256').update(readFileSync(file)).digest('hex') === approved[name]
  })
}
async function setSchedulerFence(settings, value) {
  if (!settings.d1DatabaseId || typeof settings.d1DatabaseId !== 'string') fail('Missing D1 database for subscriber scheduler fence')
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/d1/database/${encodeURIComponent(settings.d1DatabaseId)}/query`
  const sql = value?.subscriberScheduler
    ? 'INSERT INTO preview_subscriber_leases (scope,slot,target,release,expires_at) VALUES (?,?,?,?,?) ON CONFLICT(slot) DO UPDATE SET scope=excluded.scope,target=excluded.target,release=excluded.release,expires_at=excluded.expires_at'
    : 'DELETE FROM preview_subscriber_leases WHERE slot=?'
  const params = value?.subscriberScheduler ? [scopeFor(value.selector), Number(slot), value.target, value.release, value.expiresAt] : [Number(slot)]
  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ sql, params }) })
  const result = await response.json()
  if (!response.ok || !result.success || !Array.isArray(result.result) || result.result.length !== 1 || result.result[0].success !== true) fail('Unable to update subscriber scheduler fence')
}
// Fence first so a partially completed change fails closed. If either request
// fails or its outcome is ambiguous, reconcile to the management API's current
// route; never claim success for the requested change after an error.
async function publishWithFence(settings, value) {
  try {
    await setSchedulerFence(settings, value)
    publish(value)
  } catch (error) {
    try {
      const observed = flagValue()
      if (Object.keys(observed).length === 0 || (validCurrent(observed) && observed.expiresAt <= Date.now())) {
        await setSchedulerFence(settings, null)
      } else if (validCurrent(observed) && observed.selector.startsWith(`${slot}.`)) {
        await setSchedulerFence(settings, observed)
      } else {
        fail('Unexpected Flagship route during reconciliation')
      }
    } catch {
      fail(`${error.message}; subscriber scheduler fence reconciliation failed`)
    }
    fail(`${error.message}; subscriber scheduler fence reconciled to the observed Flagship route`)
  }
}
async function checkMigrations(settings) {
  const approved = path.join(root, 'apps/worker/migrations')
  const candidate = path.join(branchDir, 'apps/worker/migrations')
  const approvedHashes = settings.approvedMigrationHashes ?? {}
  if (!approvedHashes || typeof approvedHashes !== 'object' || Array.isArray(approvedHashes)) fail('Invalid approved migration hashes')
  for (const [name, hash] of Object.entries(approvedHashes)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.sql$/.test(name) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) fail(`Invalid approved migration hash for ${name}`)
  }
  const files = readdirSync(candidate).filter(name => name.endsWith('.sql'))
  for (const file of files) {
    const content = readFileSync(path.join(candidate, file))
    const mainFile = path.join(approved, file)
    if (existsSync(mainFile)) {
      if (!content.equals(readFileSync(mainFile))) fail(`Migration ${file} differs from main`)
    } else {
      const hash = createHash('sha256').update(content).digest('hex')
      if (approvedHashes[file] !== hash) fail(`Migration ${file} is absent from main and lacks an approved matching hash`)
    }
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/d1/database/${encodeURIComponent(settings.d1DatabaseId)}/query`
  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ sql: 'SELECT name FROM d1_migrations' }) })
  const result = await response.json()
  if (!response.ok || !result.success || !Array.isArray(result.result?.[0]?.results)) fail('Unable to read staging migration state')
  const applied = new Set(result.result[0].results.map(row => row.name))
  const missing = files.filter(file => !applied.has(file))
  if (missing.length) fail(`Staging is missing migrations: ${missing.join(', ')}`)
}
function createConfigs(settings, target, selector, sha, dir, subscriberScheduler) {
  const stem = `status-preview-${slot}-${target}`
  const names = { gateway: `${stem}-gateway`, api: `${stem}-operations`, statusApi: `${stem}-status-api`, monitoring: `${stem}-monitoring-api`, status: `${stem}-status-ui`, admin: `${stem}-admin-ui`, probe: `${stem}-probe` }
  const shared = { workers_dev: false, preview_urls: false, observability: { enabled: true }, compatibility_date: '2026-11-23' }
  const database = [{ binding: 'DB', database_id: settings.d1DatabaseId, database_name: settings.d1DatabaseName }]
  const scope = scopeFor(selector)
  const vars = { ACCESS_TEAM_DOMAIN: settings.accessTeamDomain, ACCESS_AUD: settings.accessAud, ENDPOINTS: settings.endpoints, PREVIEW_SUBSCRIBER_REQUIRED: 'true', PREVIEW_SUBSCRIBER_SCOPE: scope, PREVIEW_SLOT: slot, PREVIEW_TARGET: target, PREVIEW_RELEASE: sha, ...(subscriberScheduler ? {} : { SUBSCRIBERS_READY: 'false', SUBSCRIBER_EMAIL_READY: 'false' }) }
  const assets = directory => ({ directory: path.join(branchDir, directory), binding: 'ASSETS', run_worker_first: true })
  const source = name => path.join(branchDir, name)
  const extra = settings.extraServices || {}
  const services = name => extra[name] || []
  const wrapper = path.join(dir, 'preview-gateway.ts')
  writeFileSync(wrapper, `import gateway from ${JSON.stringify(source('apps/gateway/index.ts'))}\nexport default {\n  async fetch(request, env, ctx) {\n    if (request.headers.get('X-Status-Preview') !== env.PREVIEW_SELECTOR || request.headers.get('X-Status-Preview-Release') !== env.PREVIEW_RELEASE) return new Response('Preview unavailable', { status: 503 })\n    const headers = new Headers(request.headers)\n    headers.delete('X-Status-Preview')\n    headers.delete('X-Status-Preview-Release')\n    return gateway.fetch(new Request(request, { headers }), { ...env, PREVIEW_SELECTOR: undefined, PREVIEW_RELEASE: undefined }, ctx)\n  }\n}\n`, { mode: 0o600 })
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
  if (subscriberScheduler) {
    const email = (settings.resourceBindings?.api?.send_email || []).filter(x => x.name === 'SUBSCRIBER_EMAIL')
    if (email.length !== 1 || !Array.isArray(email[0].allowed_sender_addresses) || email[0].allowed_sender_addresses.length !== 1 || !Array.isArray(email[0].allowed_destination_addresses) || email[0].allowed_destination_addresses.length !== 1) fail('Subscriber scheduler requires a restricted email binding')
    const scheduler = path.join(dir, 'preview-subscriber.ts')
    writeFileSync(scheduler, `import { runPreviewSubscriberScheduler } from ${JSON.stringify(path.join(root, 'apps/gateway/preview-subscriber-scheduler.mjs'))}\nimport { PREVIEW_SUBSCRIBER_SCHEDULER_CONTRACT, flushPreviewSubscriberDeliveries } from ${JSON.stringify(source('apps/worker/src/preview-subscriber-scheduler.ts'))}\nexport default { async scheduled(_controller, env) { if (PREVIEW_SUBSCRIBER_SCHEDULER_CONTRACT === 1) await runPreviewSubscriberScheduler(env, flushPreviewSubscriberDeliveries) } }\n`, { mode: 0o600 })
    const subscriberVars = Object.fromEntries(Object.entries(settings.apiVars || {}).filter(([name]) => name.startsWith('SUBSCRIBER_') || name === 'SUBSCRIBERS_READY'))
    configs.subscriber = { ...shared, main: scheduler, name: `${stem}-subscriber`, d1_databases: database, flagship: [{ binding: 'FLAGS', app_id: app }], send_email: email, vars: { ...subscriberVars, ...vars, PREVIEW_SELECTOR: selector }, triggers: { crons: ['* * * * *'] } }
  }
  for (const [name, config] of Object.entries(configs)) writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(config), { mode: 0o600 })
  return Object.keys(configs)
}

if (!['deploy', 'release', 'rollback', 'list'].includes(action)) fail('Unknown action')
if (!/^[1-6]$/.test(slot || '')) fail('Slot must be 1 through 6')
if (!app || !token || !account) fail('Cloudflare account, token, and Flagship app are required')
const current = flagValue()
const occupied = validCurrent(current) && current.expiresAt > Date.now()
if (action === 'list') { report(current); process.exit(0) }
if (!branch) fail('Branch is required')
const settings = JSON.parse(process.env.PREVIEW_STAGING_CONFIG || '{}')
const fenceRequired = settings.subscriberSchedulingEnabled === true || current.subscriberScheduler === true || current.previous?.subscriberScheduler === true
if (action === 'release') {
  if (!occupied || current.branch !== branch) fail('Slot is not assigned to this branch')
  if (fenceRequired) await publishWithFence(settings, {})
  else publish({})
  report({ slot, released: true })
  process.exit(0)
}
if (action === 'rollback') {
  if (!occupied || current.branch !== branch || !validCurrent(current.previous) || current.previous.selector !== current.selector) fail('No rollback build is available for this branch')
  const restored = { ...current.previous, expiresAt: Date.now() + 48 * 3600_000 }
  if (fenceRequired) await publishWithFence(settings, restored)
  else publish(restored)
  report(current.previous)
  process.exit(0)
}
if (occupied && current.branch !== branch) fail(`Slot is assigned to ${current.branch} until ${new Date(current.expiresAt).toISOString()}`)
for (const name of ['d1DatabaseId', 'd1DatabaseName', 'accessTeamDomain', 'accessAud', 'endpoints']) if (typeof settings[name] !== 'string' || !settings[name] || settings[name].startsWith('REPLACE_')) fail(`Missing staging setting ${name}`)
const sha = readFileSync(path.join(branchDir, '.preview-commit'), 'utf8').trim()
if (!/^[a-f0-9]{40}$/.test(sha)) fail('Could not resolve branch commit')
await checkMigrations(settings)
const selector = occupied ? current.selector : `${slot}.${randomBytes(16).toString('hex')}`
const target = occupied && current.target === 'a' ? 'b' : 'a'
const subscriberScheduler = schedulerSupported(settings, sha)
const directory = mkdtempSync(path.join(tmpdir(), 'status-preview-'))
try {
  const configs = createConfigs(settings, target, selector, sha, directory, subscriberScheduler)
  if (occupied && current.previous) {
    const active = { ...current }
    delete active.previous
    publish(active)
  }
  for (const name of configs) {
    try { run(['deploy', '--dry-run', '--config', path.join(directory, `${name}.json`), '--experimental-auto-create=false'], { stdio: 'pipe' }) }
    catch { fail(`Dry run failed for ${name}; inspect the staging configuration and Worker bundle`) }
  }
  for (const name of configs) {
    try { run(['deploy', '--config', path.join(directory, `${name}.json`), '--experimental-auto-create=false'], { stdio: 'pipe' }) }
    catch { fail(`Deployment failed for ${name}; the active slot was not changed`) }
  }
  const value = { selector, target, release: sha, expiresAt: Date.now() + 48 * 3600_000, branch, subscriberScheduler, ...(occupied ? { previous: { selector: current.selector, target: current.target, release: current.release, expiresAt: current.expiresAt, branch: current.branch, subscriberScheduler: current.subscriberScheduler === true } } : {}) }
  if (fenceRequired || subscriberScheduler) await publishWithFence(settings, value)
  else publish(value)
  report({ slot, branch, selector, sha, target, subscriberScheduler, expiresAt: new Date(value.expiresAt).toISOString() })
} finally { rmSync(directory, { recursive: true, force: true }) }
