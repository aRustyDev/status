import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { githubBranches } from './branch-github.mjs'
import { cloudflareDatabaseAdapter } from './database-cloudflare.mjs'
import { createInventoryStore } from './release-inventory.mjs'
import { retireDeletedBranch } from './release-lifecycle.mjs'
import { createRetirementAdapter } from './retirement-cloudflare.mjs'
import { reconcilePreviews } from './reconcile.mjs'
import { createActivationAdapter } from './release-activation.mjs'
import { recoverCandidate } from './recover-candidate.mjs'
import { branchKey } from './release-contract.mjs'
import { cleanupAbandoned } from './cleanup-abandoned.mjs'
import { cleanupRetained } from './cleanup-retained.mjs'

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Missing ${name}`)
  return value
}
function text(value, name) {
  if (typeof value !== 'string' || !value) throw new Error(`Missing ${name}`)
  return value
}

export async function reconcile(env = process.env) {
  let config, secrets
  try { config = object(JSON.parse(env.PREVIEW_BRANCH_CONFIG), 'configuration'); secrets = object(JSON.parse(env.PREVIEW_WORKER_SECRETS), 'secrets') } catch { throw new Error('Invalid preview reconciliation configuration') }
  const accountId = text(env.CLOUDFLARE_ACCOUNT_ID, 'Cloudflare account')
  const token = text(env.CLOUDFLARE_API_TOKEN, 'Cloudflare token')
  const appId = text(env.FLAGSHIP_APP_ID, 'Flagship app')
  const databaseConfig = object(config.databases, 'database configuration')
  const stage = object(object(config.environments, 'environments').stage, 'stage settings')
  const access = new Headers(object(secrets.accessHeaders, 'Access headers'))
  const dispatcherVars = { ACCESS_TEAM_DOMAIN: text(stage.accessTeamDomain, 'Access team domain'), ACCESS_AUD: text(stage.accessAud, 'Access audience'), PREVIEW_SERVICE_TOKEN_ID: text(access.get('CF-Access-Client-Id'), 'Access service token ID') }
  const store = createInventoryStore({ accountId, databaseId: text(config.inventoryDatabaseId, 'inventory database'), token })
  const branches = githubBranches({ repository: text(env.GITHUB_REPOSITORY, 'GitHub repository'), token: text(env.GH_TOKEN, 'GitHub token'), apiUrl: env.GITHUB_API_URL })
  const root = process.cwd()
  const wrangler = path.join(root, 'node_modules', '.bin', 'wrangler')
  const temp = await mkdtemp(path.join(tmpdir(), 'status-preview-reconcile-'))
  try {
    const databaseAdapter = cloudflareDatabaseAdapter({ accountId, token, wrangler, recordDatabase: async () => {} })
    const run = async args => execFileSync(wrangler, args, { cwd: root, env: { ...env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'inherit' })
    const dispatcherName = text(config.dispatcherName, 'dispatcher name')
    const dispatcherSource = path.join(root, 'apps/gateway/preview-dispatcher.ts')
    const adapter = createRetirementAdapter({ accountId, appId, token, store, dispatcherName, dispatcherSource, dispatcherVars, directory: temp, databaseConfig, databaseAdapter, run })
    const activate = createActivationAdapter({ store, appId, accountId, token, dispatcherName, dispatcherSource, directory: temp, run, verificationSecret: text(secrets.verificationSecret, 'verification secret'), previewUrl: text(config.previewUrl, 'preview URL'), accessHeaders: object(secrets.accessHeaders, 'Access headers'), accessTeamDomain: dispatcherVars.ACCESS_TEAM_DOMAIN, accessAud: dispatcherVars.ACCESS_AUD, serviceTokenId: dispatcherVars.PREVIEW_SERVICE_TOKEN_ID })
    async function isPublishedCandidate({ ref, sha, selector }) {
      const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/flagship/apps/${encodeURIComponent(appId)}/flags/status-preview-branch-${branchKey(ref)}`
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      if (response.status === 404) return false
      if (!response.ok) throw new Error('Unable to inspect Flagship candidate')
      const body = await response.json()
      const flag = body.result
      if (!body.success || !flag) throw new Error('Invalid Flagship candidate response')
      return flag.enabled === true && flag.default_variation === 'current' && !flag.rules?.length && flag.variations?.current?.selector === selector && flag.variations.current.release === sha
    }
    const result = await reconcilePreviews({ branches, store,
      retire: ref => retireDeletedBranch({ ref, store, readRemoteHead: branches.head, ...adapter }),
      recoverCandidate: (ref, sha, options) => recoverCandidate({ ref, sha, store, readRemoteHead: branches.head, activate, isPublishedCandidate, ...options }),
      cleanupAbandoned: ref => cleanupAbandoned({ ref, store, deleteResources: input => adapter.deleteAbandonedResources(input) }),
      cleanupRetained: ref => cleanupRetained({ ref, store, removeBindings: input => adapter.removeBindings(input), deleteResources: input => adapter.deleteOwnedResources(input) }),
      ciStatus: branches.ciStatus, dispatchCi: branches.dispatchCi, dispatchPreview: branches.dispatchPreview })
    console.log(JSON.stringify(result, null, 2))
    if (result.errors.length) throw new Error('Some branches need reconciliation')
    return result
  } finally { await rm(temp, { recursive: true, force: true }) }
}
