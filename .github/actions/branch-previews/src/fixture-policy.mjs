import { branchPolicy } from './release-contract.mjs'
import { createHmac } from 'node:crypto'

// Fixture privileges are granted by protected controller configuration, not
// feature-branch files. Pin each eligible ref to the exact reviewed commit.
export function fixturePolicy(config, ref, sha) {
  const policy = branchPolicy(ref)
  if (!policy || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid fixture branch identity')
  if (config === undefined) return { enabled: false, environment: policy.environment }
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      !config.branches || typeof config.branches !== 'object' || Array.isArray(config.branches)) {
    throw new Error('Invalid isolated fixture configuration')
  }
  for (const [branch, approval] of Object.entries(config.branches)) {
    if (!branchPolicy(branch) || !approval || typeof approval !== 'object' || Array.isArray(approval) ||
        Object.keys(approval).some(key => !['sha', 'cas', 'subscriber', 'probe'].includes(key)) ||
        !/^[a-f0-9]{40}$/.test(approval.sha) || ['cas', 'subscriber', 'probe'].some(key => typeof approval[key] !== 'boolean')) throw new Error('Invalid fixture approval')
  }
  if (!Object.hasOwn(config.branches, ref)) return { enabled: false, environment: policy.environment }
  const approval = config.branches[ref]
  if (approval.sha !== sha) throw new Error('Fixture approval does not match branch commit')
  return { enabled: true, environment: 'schema', cas: approval.cas, subscriber: approval.subscriber, probe: approval.probe }
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
