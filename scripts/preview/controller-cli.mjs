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

const workerComponents = ['gateway', 'api', 'statusApi', 'monitoring', 'status', 'admin', 'probe']

export function selectWorkerSecrets(secrets, environment) {
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
  const workerSecrets = selectWorkerSecrets(secrets, policy.environment)
  const verifySecret = text(secrets.verificationSecret, 'candidate verification secret')
  if (verifySecret.length < 32) throw new Error('Candidate verification secret is too short')
  const access = object(secrets.accessHeaders, 'Access headers')
  if (Object.keys(access).length === 0 || Object.values(access).some(value => typeof value !== 'string' || !value)) throw new Error('Invalid Access headers')
  const databaseConfig = object(config.databases, 'database configuration')
  const settings = object(object(config.environments, 'environment configuration')[policy.environment], 'selected preview environment')
  const previewUrl = new URL(text(config.previewUrl, 'preview URL'))
  if (previewUrl.protocol !== 'https:' || previewUrl.username || previewUrl.password) throw new Error('Invalid preview URL')
  const accountId = text(env.CLOUDFLARE_ACCOUNT_ID, 'Cloudflare account')
  const token = text(env.CLOUDFLARE_API_TOKEN, 'Cloudflare token')
  const appId = text(env.FLAGSHIP_APP_ID, 'Flagship app')
  const store = createInventoryStore({ accountId, databaseId: text(config.inventoryDatabaseId, 'inventory database'), token })
  const branches = githubBranches({ repository: text(env.GITHUB_REPOSITORY, 'GitHub repository'), token: text(env.GH_TOKEN, 'GitHub token'), apiUrl: env.GITHUB_API_URL })
  const root = process.cwd()
  const branchDir = path.join(root, 'feature')
  const wrangler = path.join(root, 'node_modules', '.bin', 'wrangler')
  const temp = await mkdtemp(path.join(tmpdir(), 'status-branch-release-'))
  const run = async args => execFileSync(wrangler, args, { cwd: root, env: { ...env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'inherit' })
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
    const activate = createActivationAdapter({
      store, appId, accountId, token, dispatcherName: text(config.dispatcherName, 'dispatcher name'),
      dispatcherSource: path.join(root, 'apps/gateway/preview-dispatcher.ts'), directory: temp, run,
      verificationSecret: verifySecret, previewUrl: previewUrl.href, accessHeaders: access,
      ...activationIdentity(config, access),
    })
    const record = await deployRelease({
      ref, sha, store, readRemoteHead: branches.head,
      async prepare({ recordResources, recordedResources }) {
        const adapter = cloudflareDatabaseAdapter({ accountId, token, wrangler,
          recordDatabase: async (database, purpose) => recordResources({ [purpose === 'clean' ? 'validationDatabase' : 'database']: database }),
          recordIntent: async (name, purpose) => recordResources({ [purpose === 'clean' ? 'validationDatabaseIntent' : 'databaseIntent']: { name } }),
          recordProgress: recordResources,
        })
        const database = await prepareDatabase({ kind: policy.environment, ref, sha, config: databaseConfig,
          mainMigrations: path.join(root, 'apps/worker/migrations'), candidateMigrations: path.join(branchDir, 'apps/worker/migrations'), adapter, recordedResources })
        await recordResources({ database })
        const workerSettings = { ...settings, d1DatabaseId: database.id, d1DatabaseName: database.name }
        const selector = selectorForBranch(ref)
        const { names } = createBranchConfigs({ settings: workerSettings, selector, sha, branchDir, dir: temp })
        await recordResources({ workers: names, gateway: names.gateway })
        await deployBranchWorkers({ settings: workerSettings, selector, sha, branchDir, dir: temp, run,
          installSecrets: async (component, name) => install(name, workerSecrets[component]) })
        return { database, workers: names, gateway: names.gateway }
      },
      async activate(candidate) {
        install(config.dispatcherName, { PREVIEW_VERIFY_SECRET: verifySecret })
        await activate(candidate)
      },
    })
    const result = { url: config.previewUrl, selector: record.selector, sha: record.active.sha, environment: record.environment }
    console.log(JSON.stringify(result))
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `### Branch preview\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`)
  } finally { await rm(temp, { recursive: true, force: true }) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
