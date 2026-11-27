import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const obj = value => value && typeof value === 'object' && !Array.isArray(value)
function exactKeys(value, expected) {
  return obj(value) && Object.keys(value).sort().join('\n') === [...expected].sort().join('\n')
}
function regular(filename) {
  const stat = lstatSync(filename)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Fixture artifact must be a regular file')
  return readFileSync(filename)
}
function directory(dirname) {
  const stat = lstatSync(dirname)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid fixture artifact directory')
}
function tree(directory) {
  const files = []
  function visit(root, relative = '') {
    const stat = lstatSync(root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid fixture asset directory')
    for (const name of readdirSync(root).sort()) {
      if (!name || name === '.' || name === '..' || /[\0\r\n]/.test(name)) throw new Error('Invalid fixture asset path')
      const file = path.join(root, name), rel = relative ? `${relative}/${name}` : name, child = lstatSync(file)
      if (child.isSymbolicLink()) throw new Error('Fixture asset symlink is forbidden')
      if (child.isDirectory()) visit(file, rel)
      else if (child.isFile()) files.push([rel, hash(regular(file))])
      else throw new Error('Invalid fixture asset file')
    }
  }
  visit(directory)
  if (!files.length) throw new Error('Fixture assets are empty')
  files.sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)
  const digest = createHash('sha256')
  for (const [name, fileHash] of files) digest.update(name).update('\0').update(fileHash).update('\n')
  return digest.digest('hex')
}

// Useful for offline review; the returned values must be installed through
// protected operator configuration, never accepted from the feature artifact.
export function describeFixtureArtifact({ branchDir, manifest, cas = false, subscriber = false }) {
  if (!path.isAbsolute(branchDir || '') || !obj(manifest?.components) || typeof cas !== 'boolean' || typeof subscriber !== 'boolean') throw new Error('Invalid fixture artifact description')
  const componentIds = Object.keys(manifest.components)
  if (!componentIds.length || componentIds.some(id => !/^[a-z][a-zA-Z0-9]{0,24}$/.test(id))) throw new Error('Invalid fixture components')
  const workerIds = [...componentIds, ...(cas ? ['cas'] : []), ...(subscriber ? ['api-feature', 'subscriber-feature'] : [])]
  if (new Set(workerIds).size !== workerIds.length) throw new Error('Duplicate fixture component')
  directory(branchDir)
  directory(path.join(branchDir,'workers'))
  const workers = Object.fromEntries(workerIds.map(id => [id,hash(regular(path.join(branchDir,'workers',`${id}.mjs`)))]))
  if (Object.values(manifest.components).some(c => c.assets)) directory(path.join(branchDir,'assets'))
  const assets = Object.fromEntries(Object.entries(manifest.components).filter(([,c])=>c.assets).map(([id])=>[id,tree(path.join(branchDir,'assets',id))]))
  const migrationsDir = path.join(branchDir,'migrations')
  directory(migrationsDir)
  const names = readdirSync(migrationsDir).sort()
  if (!names.length || names.some(name => !/^[A-Za-z0-9_-]+\.sql$/.test(name))) throw new Error('Invalid fixture migration list')
  const migrations = Object.fromEntries(names.map(name => [name,hash(regular(path.join(migrationsDir,name)))]))
  return { workers, assets, migrations }
}

export function validateFixtureArtifactApproval({ approval, sha, branchDir, manifest, now = Date.now() }) {
  if (!obj(approval) || approval.enabled !== true || !/^[a-f0-9]{40}$/.test(sha || '') || approval.sha !== sha ||
      !Number.isSafeInteger(now) || !Number.isSafeInteger(approval.expiresAt) || approval.expiresAt <= now || approval.expiresAt > now + 48 * 3600_000 ||
      typeof approval.cas !== 'boolean' || typeof approval.subscriber !== 'boolean' || typeof approval.probe !== 'boolean' ||
      !exactKeys(approval.artifacts, ['workers','assets','migrations'])) throw new Error('Invalid or expired isolated fixture approval')
  const actual = describeFixtureArtifact({branchDir,manifest,cas:approval.cas,subscriber:approval.subscriber})
  for (const name of ['workers','assets','migrations']) {
    if (!exactKeys(approval.artifacts[name], Object.keys(actual[name])) || Object.values(approval.artifacts[name]).some(value => !hex(value)) ||
        Object.entries(actual[name]).some(([key,value]) => approval.artifacts[name][key] !== value)) throw new Error(`Fixture ${name} approval does not match artifact`)
  }
  return { expiresAt:approval.expiresAt }
}
