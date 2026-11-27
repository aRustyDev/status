import { installation } from './installation.mjs'
import { assertDatabaseIsolation } from './isolation.mjs'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { ownedPath } from './manifest.mjs'
import { execFileSync } from 'node:child_process'
import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { githubBranches } from './branch-github.mjs'
import { cloudflareDatabaseAdapter } from './database-cloudflare.mjs'
import { prepareDatabase } from './database.mjs'
import { createBranchConfigs, deployBranchWorkers } from './branch-workers.mjs'
import { branchPolicy, selectorForBranch } from './release-contract.mjs'
import { deployRelease } from './release-coordinator.mjs'
import { createInventoryStore } from './release-inventory.mjs'
import { createActivationAdapter } from './release-activation.mjs'
import { reconcile } from './reconcile-cli.mjs'
import { createSchemaFence, schemaSubscriberSettings } from './schema-subscriber.mjs'
import { fixturePolicy, preserveIsolatedHistory, isolatedWorkerSecrets, settingsForFixture } from './fixture-policy.mjs'
import { fixtureRegistryStatements } from './fixture-catalog.mjs'
import { createCloudflareExecutionFence, executionFenceFor, initializeExecutionFenceIfNeeded } from './execution-fence.mjs'
import { createFixtureSchedulingConfigs } from './fixture-scheduling-config.mjs'
import { buildTrustedPreviewWrappers } from './trusted-wrappers.mjs'
import { validateFixtureArtifactApproval } from './fixture-artifact-approval.mjs'

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Missing or invalid ${name}`)
  return value
}
function parse(value, name) {
  try { return object(JSON.parse(value), name) } catch { throw new Error(`Missing or invalid ${name}`) }
}
function text(value, name) {
  if (typeof value !== 'string' || !value) throw new Error(`Missing ${name}`)
  return value
}

export function redactSubscriberAddresses(value, subscriber) {
  let text = String(value || '')
  for (const address of [subscriber?.sender, subscriber?.recipient].filter(Boolean)) {
    const escaped = address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    text = text.replace(new RegExp(escaped, 'gi'), '[redacted]')
  }
  return text
}



export function selectWorkerSecrets(secrets, environment) {
  const workerComponents = Object.keys(installation().manifest.components)
  if (!['dev', 'stage', 'schema'].includes(environment)) throw new Error('Invalid Worker secret environment')
  const environments = object(secrets?.environments, 'Worker secret environments')
  const workersByEnvironment = {}
  for (const name of ['dev', 'stage', 'schema']) {
    const selected = object(environments[name], `${name} Worker secret environment`)
    const workers = object(selected.workers, `${name} Worker secrets`)
    if (Object.keys(workers).some(component => !workerComponents.includes(component))) throw new Error(`Invalid ${name} Worker component`)
    for (const component of workerComponents) {
      const values = object(workers[component], `${name} ${component} Worker secrets`)
      if (Object.entries(values).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || !value)) throw new Error(`Invalid ${name} ${component} Worker secrets`)
    }
    workersByEnvironment[name] = workers
  }
  return workersByEnvironment[environment]
}

// The probe enters through the shared staging gateway, regardless of which
// database the preview selects, so authenticate it against staging Access.
export function activationIdentity(config, access) {
  const stage = object(object(config.environments, 'environment configuration').stage, 'staging environment')
  const headers = new Headers(access)
  return {
    accessTeamDomain: text(stage.accessTeamDomain, 'staging Access team domain'),
    accessAud: text(stage.accessAud, 'staging Access audience'),
    serviceTokenId: text(headers.get('CF-Access-Client-Id'), 'Access service token client ID'),
  }
}

export async function main(env = process.env) {
  const action = text(env.PREVIEW_ACTION, 'preview action')
  if (action === 'reconcile') return reconcile(env)
  if (action !== 'deploy') throw new Error('Unsupported preview action')
  const ref = `refs/heads/${text(env.PREVIEW_BRANCH, 'branch')}`
  const policy = branchPolicy(ref)
  const sha = text(env.PREVIEW_SHA, 'commit')
  if (!policy || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid branch or commit')
  const config = parse(env.PREVIEW_BRANCH_CONFIG, 'PREVIEW_BRANCH_CONFIG')
  const secrets = parse(env.PREVIEW_WORKER_SECRETS, 'PREVIEW_WORKER_SECRETS')
  const fixtureConfig = env.PREVIEW_ISOLATED_FIXTURE_CONFIG ? parse(env.PREVIEW_ISOLATED_FIXTURE_CONFIG, 'PREVIEW_ISOLATED_FIXTURE_CONFIG') : config.isolatedFixtures
  const databaseConfig = object(config.databases, 'database configuration')
  assertDatabaseIsolation(config)
  const accountId = text(env.CLOUDFLARE_ACCOUNT_ID, 'Cloudflare account')
  const token = text(env.CLOUDFLARE_API_TOKEN, 'Cloudflare token')
  const appId = text(env.FLAGSHIP_APP_ID, 'Flagship app')
  const store = createInventoryStore({ accountId, databaseId: text(config.inventoryDatabaseId, 'inventory database'), token })
  // If inventory is unavailable or malformed, do not guess whether this ref
  // previously held an isolated fixture and accidentally target shared D1.
  const fixture = preserveIsolatedHistory({ ref, fixture:fixturePolicy(fixtureConfig, ref, sha), snapshot:await store.read(ref), sharedDatabaseIds:['dev','stage'].map(name => databaseConfig[name].id) })
  let workerSecrets = selectWorkerSecrets(secrets, fixture.environment)
  let fixtureRoot
  if (fixture.enabled || fixture.isolatedFallback) {
    // No shared environment secrets reach opted-in feature code. A unique
    // per-release Vault key is derived from a controller-only root.
    fixtureRoot = env.PREVIEW_ISOLATED_FIXTURE_ROOT || object(secrets.isolatedFixtures, 'isolated fixture secrets').vaultRoot
    workerSecrets = isolatedWorkerSecrets(workerSecrets, fixtureRoot, selectorForBranch(ref), sha, fixture)
  }
  const verifySecret = text(secrets.verificationSecret, 'candidate verification secret')
  if (verifySecret.length < 32) throw new Error('Candidate verification secret is too short')
  const access = object(secrets.accessHeaders, 'Access headers')
  if (Object.keys(access).length === 0 || Object.values(access).some(value => typeof value !== 'string' || !value)) throw new Error('Invalid Access headers')
  const selectedSettings = object(object(config.environments, 'environment configuration')[fixture.environment], 'selected preview environment')
  const settings = settingsForFixture(selectedSettings, fixture)
  const previewUrl = new URL(text(config.previewUrl, 'preview URL'))
  if (previewUrl.protocol !== 'https:' || previewUrl.username || previewUrl.password) throw new Error('Invalid preview URL')
  const executionFence = await initializeExecutionFenceIfNeeded({ store, ref, fixtureEnabled:fixture.enabled || fixture.isolatedFallback, createFence:() => createCloudflareExecutionFence({ accountId, databaseId: text(config.inventoryDatabaseId, 'inventory database'), token }) })
  const branches = githubBranches({ repository: text(env.PREVIEW_SOURCE_REPOSITORY || env.GITHUB_REPOSITORY, 'GitHub repository'), defaultBranch: env.PREVIEW_DEFAULT_BRANCH || 'main', dispatchRepository: env.GITHUB_REPOSITORY, dispatchToken: env.GH_TOKEN, dispatchBranch: env.PREVIEW_HOST_BRANCH || 'main', token: text(env.PREVIEW_SOURCE_TOKEN || env.GH_TOKEN, 'GitHub token'), apiUrl: env.GITHUB_API_URL })
  const root = fileURLToPath(new URL('../', import.meta.url))
  const control = env.PREVIEW_CONTROL_DIR
  const manifest = installation().manifest
  const branchDir = env.PREVIEW_ARTIFACT_DIR
  const approval = env.PREVIEW_SCHEMA_SUBSCRIBER_CONFIG ? parse(env.PREVIEW_SCHEMA_SUBSCRIBER_CONFIG, 'PREVIEW_SCHEMA_SUBSCRIBER_CONFIG') : null
  const subscriber = fixture.isolatedFallback ? null : schemaSubscriberSettings({ value:approval, environment:policy.environment, branch:policy.name, sha, branchDir, previewUrl:previewUrl.href })
  if (subscriber && fixture.enabled) throw new Error('Legacy subscriber approval and isolated fixtures are mutually exclusive')
  if (fixture.enabled) validateFixtureArtifactApproval({ approval:{...fixtureConfig.branches[ref],enabled:true}, sha, branchDir, manifest })
  const fixtureSource = fixture.enabled ? ownedPath(control, 'apps/preview-fixture/index.mjs') : null
  const fixtureSql = fixture.enabled ? ownedPath(control, 'apps/preview-fixture/schema.sql') : null
  const casSource = fixture.cas ? path.join(branchDir, 'workers', 'cas.mjs') : null
  if (fixture.cas && !existsSync(casSource)) throw new Error('Approved CAS fixture requires the feature CAS Worker')
  const wrangler = path.join(root, 'node_modules', '.bin', 'wrangler')
  const temp = await mkdtemp(path.join(tmpdir(), 'status-branch-release-'))
  const redactMail = subscriber || (fixture.subscriber ? { sender:fixtureConfig.mail?.from, recipient:fixtureConfig.mail?.to } : null)
  const run = async args => {
    if (!redactMail) return execFileSync(wrangler, args, { cwd: root, env: { ...env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'inherit' })
    try {
      // Wrangler displays binding values and addresses on successful deployment.
      return execFileSync(wrangler, args, { cwd: root, env: { ...env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore','pipe','pipe'], maxBuffer:16*1024*1024 })
    } catch (error) {
      const detail = redactSubscriberAddresses(error.stderr || '', redactMail).slice(0, 4000)
      // The original error may contain raw Wrangler output with private addresses.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`Wrangler ${args[0]} failed (exit ${error.status ?? 'unknown'})${detail ? ': ' + detail : ''}`)
    }
  }
  function install(name, values) {
    const selected = object(values, `${name} secrets`)
    if (Object.entries(selected).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || !value)) throw new Error(`Invalid ${name} secrets`)
    if (Object.keys(selected).length) {
      try {
        execFileSync(wrangler, ['secret', 'bulk', '--name', name], { cwd: root, env: { ...env, WRANGLER_SEND_METRICS: 'false' }, input: JSON.stringify(selected), stdio: ['pipe', 'ignore', 'pipe'] })
      } catch { throw new Error(`Secret installation failed for ${name}`) }
    }
  }
  try {
    const fenceAdapter = cloudflareDatabaseAdapter({ accountId, token, wrangler, seedSql: '', recordDatabase: async () => {} })
    const subscriberFence = createSchemaFence({ query:fenceAdapter.query, findDatabase:fenceAdapter.findDatabase, config:{...databaseConfig, inventoryDatabaseId:config.inventoryDatabaseId} })
    const activate = createActivationAdapter({
      store, appId, accountId, token, dispatcherName: text(config.dispatcherName, 'dispatcher name'),
      dispatcherSource: path.join(root, 'runtime/dispatcher.ts'), directory: temp, run,
      verificationSecret: verifySecret, previewUrl: previewUrl.href, accessHeaders: access,
      executionFenceFor: executionFence ? executionFenceFor(executionFence) : undefined,
      ...activationIdentity(config, access),
      subscriberFence,
    })
    const record = await deployRelease({
      ref, sha, store, readRemoteHead: branches.head,
      async prepare({ recordResources, recordedResources }) {
        if (fixture.enabled || fixture.isolatedFallback) await recordResources({ isolatedPreview:true })
        const adapter = cloudflareDatabaseAdapter({ accountId, token, wrangler, seedSql: readFileSync(ownedPath(control,manifest.database.seed),'utf8'),
          recordDatabase: async (database, purpose) => recordResources({ [purpose === 'clean' ? 'validationDatabase' : 'database']: database }),
          recordIntent: async (name, purpose) => recordResources({ [purpose === 'clean' ? 'validationDatabaseIntent' : 'databaseIntent']: { name } }),
          recordProgress: recordResources,
        })
        const database = await prepareDatabase({ kind: fixture.environment, ref, sha, config: databaseConfig,
          mainMigrations: ownedPath(control, manifest.database.migrations), candidateMigrations: path.join(branchDir, 'migrations'), adapter, recordedResources })
        await recordResources({ database })
        if (fixture.enabled) await adapter.initializeFixture(database, fixtureSql)
        const selector = selectorForBranch(ref)
        let fixtureSettings = {}
        if (fixture.enabled) {
          const wrappers = await buildTrustedPreviewWrappers({ control, branchDir, dir: temp, fixtureSource, probe: fixture.probe, subscriber: fixture.subscriber })
          const isolatedFixture = { source: fixtureSource, ...(casSource ? { casSource } : {}), probe: fixture.probe, subscriber: fixture.subscriber, expiresAt:fixture.expiresAt, wrappers }
          fixtureSettings = { databaseOwned: database.owned === true, isolatedFixture }
          {
            const probeName = installation().workerStem(selector, sha) + '-' + manifest.components.probe.suffix
            fixtureSettings.internalScheduling = createFixtureSchedulingConfigs({ ref, selector, sha, database,
              inventoryDatabase: { id: config.inventoryDatabaseId, name: text(fixtureConfig.inventoryDatabaseName, 'inventory database name') },
              sharedDatabaseIds: ['dev', 'stage', 'prod'].map(name => databaseConfig[name].id), flagshipAppId: appId,
              runtimeDir: path.join(root, 'runtime'), probeName, dir: temp, expiresAt:fixture.expiresAt })
          }
          if (fixture.subscriber) {
            const mail = object(fixtureConfig.mail, 'isolated subscriber mail configuration')
            fixtureSettings.internalSubscriber = { from: text(mail.from, 'preview sender'), to: text(mail.to, 'preview recipient'), publicUrl: previewUrl.origin }
          }
        }
        const workerSettings = { ...settings, d1DatabaseId: database.id, d1DatabaseName: database.name, previewEnvironment:fixture.environment, ...fixtureSettings }
        const { names } = createBranchConfigs({ settings: workerSettings, selector, sha, branchDir, dir: temp, subscriber, appId })
        if (fixture.enabled) await adapter.initializeFixtureRegistry(database, fixtureRegistryStatements(names.fixture, sha, Boolean(casSource)))
        await recordResources({ workers: names, gateway: names.gateway, ...(subscriber ? {subscriberExpiresAt:subscriber.expiresAt} : {}) })
        await deployBranchWorkers({ settings: workerSettings, selector, sha, branchDir, dir: temp, run, subscriber, appId,
          installSecrets: async (component, name) => install(name, component === 'subscriber' ? {} : workerSecrets[component]) })
        return { database, workers: names, gateway: names.gateway, ...(subscriber ? {subscriberExpiresAt:subscriber.expiresAt} : {}) }
      },
      async activate(candidate) {
        install(config.dispatcherName, { PREVIEW_VERIFY_SECRET: verifySecret })
        await activate(candidate)
      },
    })
    const result = { url: previewUrl.origin, header_name: installation().header, selector: record.selector, sha: record.active.sha, environment: record.environment, database_environment: fixture.environment }
    console.log(JSON.stringify(result))
    if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, Object.entries(result).map(([k,v]) => k + '=' + v).join('\n') + '\n')
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `### Branch preview\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`)
    if (env.GITHUB_STEP_SUMMARY) {
      const launch = manifest.launcher ? 'node ' + manifest.launcher + ' ' + previewUrl.origin + ' ' + record.selector : 'curl -H "' + installation().header + ': ' + record.selector + '" ' + previewUrl.origin + manifest.smokePath
      await appendFile(env.GITHUB_STEP_SUMMARY, '\n```sh\n' + launch + '\n```\n')
    }
  } finally { await rm(temp, { recursive: true, force: true }) }
}
