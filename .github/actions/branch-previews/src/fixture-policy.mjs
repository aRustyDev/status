import { branchPolicy, validateInventory } from './release-contract.mjs'
import { createHmac } from 'node:crypto'

function validApprovalArtifacts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'assets,migrations,workers') return false
  for (const name of ['workers','assets','migrations']) {
    const entries=value[name]
    if (!entries || typeof entries !== 'object' || Array.isArray(entries) || (name !== 'assets' && !Object.keys(entries).length)) return false
    if (Object.entries(entries).some(([key,hash]) => !/^[A-Za-z0-9_.-]+$/.test(key) || !/^[a-f0-9]{64}$/.test(hash || ''))) return false
  }
  return true
}

// Fixture privileges are granted by protected controller configuration, not
// feature-branch files. Pin each eligible ref to the exact reviewed commit.
export function fixturePolicy(config, ref, sha, now = Date.now()) {
  const policy = branchPolicy(ref)
  if (!policy || !/^[a-f0-9]{40}$/.test(sha) || !Number.isSafeInteger(now)) throw new Error('Invalid fixture branch identity')
  if (config === undefined) return { enabled: false, environment: policy.environment }
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      !config.branches || typeof config.branches !== 'object' || Array.isArray(config.branches)) {
    throw new Error('Invalid isolated fixture configuration')
  }
  for (const [branch, approval] of Object.entries(config.branches)) {
    if (!branchPolicy(branch) || !approval || typeof approval !== 'object' || Array.isArray(approval) ||
        Object.keys(approval).some(key => !['sha', 'cas', 'subscriber', 'probe', 'expiresAt', 'artifacts'].includes(key)) ||
        !/^[a-f0-9]{40}$/.test(approval.sha) || ['cas', 'subscriber', 'probe'].some(key => typeof approval[key] !== 'boolean') ||
        !Number.isSafeInteger(approval.expiresAt) || approval.expiresAt <= 0 || approval.expiresAt > now + 48 * 3600_000 || !validApprovalArtifacts(approval.artifacts)) throw new Error('Invalid fixture approval')
  }
  if (!Object.hasOwn(config.branches, ref)) return { enabled: false, environment: policy.environment }
  const approval = config.branches[ref]
  // Keep later commits isolated without granting them the old release's
  // fixture privileges. Existing active Workers are not changed here.
  if (approval.sha !== sha || approval.expiresAt <= now) return { enabled: false, environment: 'schema', isolatedFallback: true }
  return { enabled: true, environment: 'schema', cas: approval.cas, subscriber: approval.subscriber, probe: approval.probe, expiresAt:approval.expiresAt }
}

// Once a ref has used an isolated fixture, later unapproved commits stay on
// owned schema resources even if the protected opt-in is removed. Incomplete
// resource records are treated as isolated rather than risking shared D1.
export function preserveIsolatedHistory({ ref, fixture, snapshot, sharedDatabaseIds }) {
  if (!branchPolicy(ref) || !fixture || typeof fixture !== 'object' || Array.isArray(fixture)) throw new Error('Invalid preview isolation history')
  if (snapshot === null) return fixture
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.record || snapshot.record.ref !== ref) throw new Error('Invalid preview isolation inventory')
  const record = validateInventory(snapshot.record)
  if (fixture.enabled || fixture.isolatedFallback) return fixture
  const releases = [record.active, record.previous, record.candidate, ...(record.retained || [])].filter(Boolean)
  const isolated = releases.some(release => {
    const resources = release.resources
    if (Object.hasOwn(resources,'isolatedPreview') && resources.isolatedPreview !== true) throw new Error('Invalid isolated preview history marker')
    if (Object.hasOwn(resources,'workers') && (!resources.workers || typeof resources.workers !== 'object' || Array.isArray(resources.workers))) throw new Error('Invalid preview Worker history')
    if (resources.isolatedPreview === true || resources.workers?.fixture || resources.workers?.fence) return true
    if (record.environment !== 'schema' && (resources.database?.owned === true || resources.validationDatabase?.owned === true || Object.hasOwn(resources,'databaseIntent') || Object.hasOwn(resources,'validationDatabaseIntent'))) return true
    // Ordinary schema previews already have owned databases; without fixture
    // markers their established configuration remains unchanged.
    if (record.environment === 'schema' && release !== record.candidate && resources.database?.owned === true) return false
    // A deployment can be interrupted between recording its candidate and
    // recording the database. Its intended sharing cannot be inferred safely.
    const expectedShared = Array.isArray(sharedDatabaseIds) ? sharedDatabaseIds[record.environment === 'dev' ? 0 : 1] : undefined
    if (!resources.database || resources.database.owned !== false || typeof resources.database.id !== 'string' || !resources.database.id || typeof resources.database.name !== 'string' || !resources.database.name || !expectedShared || resources.database.id !== expectedShared) return true
    return false
  })
  return isolated ? { enabled:false, environment:'schema', isolatedFallback:true } : fixture
}

// A previously approved ref must never fall back to shared integrations when
// its approval expires or a new, unreviewed commit is pushed.
export function isolatedFallbackSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid isolated fallback settings')
  return { ...settings, endpoints:'[]', extraServices:{}, resourceBindings:{}, vpcServices:[],
    apiVars:{}, statusApiVars:{}, monitoringVars:{}, probeVars:{} }
}

// The derivation root remains in the controller. Feature Workers receive only
// their own release key, never a staging key or another release's key.
function derive(root, selector, sha, purpose) {
  if (typeof root !== 'string' || !/^[a-f0-9]{64}$/i.test(root) ||
      !/^branch-[a-f0-9]{24}$/.test(selector) || !/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error('Invalid isolated fixture key configuration')
  }
  return createHmac('sha256', Buffer.from(root, 'hex')).update(purpose + '\0').update(selector).update('\0').update(sha).digest('hex')
}
export const fixtureVaultKey = (root, selector, sha) => derive(root, selector, sha, 'status-preview-vault-v1')
export const fixtureScheduleKey = (root, selector, sha) => derive(root, selector, sha, 'status-preview-schedule-v1')

export function isolatedWorkerSecrets(original, root, selector, sha, fixture) {
  if (!original || typeof original !== 'object' || Array.isArray(original) || !fixture || typeof fixture !== 'object') throw new Error('Invalid isolated Worker secrets')
  const vault = fixtureVaultKey(root,selector,sha)
  const result = Object.fromEntries(Object.keys(original).map(component => [component, {}]))
  for (const component of ['api','monitoring','probe','cas']) result[component] = { VAULT_ENCRYPTION_KEY:vault }
  if (fixture.probe || fixture.subscriber) {
    const schedule = fixtureScheduleKey(root,selector,sha)
    if (fixture.probe) { result.probe.PREVIEW_SCHEDULE_SECRET=schedule; result.probeScheduler={PREVIEW_SCHEDULE_SECRET:schedule} }
    if (fixture.subscriber) for (const name of ['subscriberFeature','subscriberScheduler']) result[name]={PREVIEW_SCHEDULE_SECRET:schedule}
  }
  return result
}
