import { createHash } from 'node:crypto'

const digest = value => createHash('sha256').update(value).digest('hex')
let installed

export function defineInstallation(repositoryId, manifest) {
  if (!/^[1-9][0-9]{0,19}$/.test(repositoryId)) throw new Error('Missing GitHub repository ID')
  const legacy = repositoryId === '1468279539'
  const namespace = legacy ? 'status' : 'bp-' + repositoryId
  return {
    manifest, namespace, legacy,
    header: legacy ? 'X-Status-Preview' : 'X-Branch-Preview',
    branchKey(ref) { return digest(legacy ? ref : repositoryId + '\n' + ref).slice(0, 24) },
    workerStem(selector, sha) { return namespace + '-p-' + digest(selector + ':' + sha).slice(0, 24) },
    schemaStem(ref, sha) { return namespace + '-schema-' + digest(ref).slice(0, 12) + '-' + sha.slice(0, 12) },
    flagPrefix: namespace + '-preview-',
  }
}

// Each action step starts a fresh process with the caller's repository ID.
export function configure(repositoryId, manifest) {
  if (installed) throw new Error('Preview installation is already configured')
  installed = defineInstallation(repositoryId, manifest)
  return installed
}
export function installation() {
  if (!installed) throw new Error('Preview installation was not initialized')
  return installed
}
