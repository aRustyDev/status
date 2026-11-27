import { createHash } from 'node:crypto'

const PREFIXES = Object.freeze({ feat: 'dev', fix: 'dev', stage: 'stage', schema: 'schema' })
const SHA = /^[a-f0-9]{40}$/

// Full refs keep branch names unambiguous across push, deletion, and reconciliation events.
export function branchPolicy(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('refs/heads/')) return null
  const name = ref.slice('refs/heads/'.length)
  // Git ref names cannot contain ASCII control characters or these punctuation characters.
  // eslint-disable-next-line no-control-regex
  if (!name || name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.includes('..') || name.includes('@{') || /[\x00-\x20\x7f~^:?*\\[]/.test(name) || name.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) return null
  const slash = name.indexOf('/')
  const environment = PREFIXES[name.slice(0, slash)]
  return slash > 0 && environment ? { ref, name, environment } : null
}

export function branchKey(ref) {
  if (!branchPolicy(ref)) throw new Error('Ref is not an eligible branch')
  return createHash('sha256').update(ref).digest('hex').slice(0, 24)
}

export function selectorForBranch(ref) {
  return `branch-${branchKey(ref)}`
}

export function newRelease({ ref, sha }) {
  const policy = branchPolicy(ref)
  if (!policy || !SHA.test(sha)) throw new Error('Invalid branch or commit SHA')
  return { ref, key: branchKey(ref), selector: selectorForBranch(ref), environment: policy.environment, desiredSha: sha, generation: 1, active: null, previous: null, candidate: null }
}

export function nextGeneration(record, sha) {
  validateInventory(record)
  if (!SHA.test(sha)) throw new Error('Invalid commit SHA')
  if (sha === record.desiredSha) return record
  return { ...record, desiredSha: sha, generation: record.generation + 1, candidate: null }
}

export function validateInventory(record) {
  const policy = record && branchPolicy(record.ref)
  if (!policy || record.key !== branchKey(record.ref) || record.selector !== selectorForBranch(record.ref) || record.environment !== policy.environment || !SHA.test(record.desiredSha) || !Number.isSafeInteger(record.generation) || record.generation < 1) throw new Error('Invalid release inventory')
  if (record.retained !== undefined && !Array.isArray(record.retained)) throw new Error('Invalid retained releases')
  const releases = ['active', 'previous', 'candidate'].map(name => [name, record[name]])
  releases.push(...(record.retained || []).map(release => ['retained', release]))
  for (const [name, release] of releases) {
    if (release !== null && (!release || !SHA.test(release.sha) || !Number.isSafeInteger(release.generation) || release.generation < 1 || release.generation > record.generation || typeof release.resources !== 'object' || release.resources === null || Array.isArray(release.resources))) throw new Error(`Invalid ${name} release`)
  }
  return record
}
