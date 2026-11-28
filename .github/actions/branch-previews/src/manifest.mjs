import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'

export function relativePath(value) {
  if (typeof value !== 'string' || !value || value.split('/').some(s => !s || s === '.' || s === '..' || !/^[a-zA-Z0-9_.@-]+$/.test(s))) throw new Error('Invalid repository-relative path')
  return value
}
export function ownedPath(root, value) {
  const base = realpathSync(root)
  const result = realpathSync(path.join(base, relativePath(value)))
  if (!result.startsWith(base + path.sep)) throw new Error('Path escapes repository')
  return result
}
function map(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid ' + name)
  return value
}
export function validateManifest(m) {
  if (m?.version !== 1) throw new Error('Unsupported preview manifest version')
  for (const name of ['ci','preview']) {
    if (!/^[a-zA-Z0-9_-]+\.ya?ml$/.test(m.workflows?.[name] || '')) throw new Error('Invalid workflow filename')
  }
  const branches = Object.entries(map(m.branches, 'branch policy'))
  if (!branches.length || branches.some(([key,value]) => !/^[a-z][a-z0-9-]*$/.test(key) || !['dev','stage','schema'].includes(value))) throw new Error('Invalid branch policy')
  relativePath(m.database?.migrations)
  relativePath(m.database?.seed)
  if (m.fixtures?.casEntry) relativePath(m.fixtures.casEntry)
  if (m.fixtures?.subscriberEntry) relativePath(m.fixtures.subscriberEntry)
  if (!Array.isArray(m.build) || m.build.some(cmd => !Array.isArray(cmd) || !cmd.length || cmd.some(arg => typeof arg !== 'string' || !arg))) throw new Error('Invalid build commands')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(m.compatibilityDate || '')) throw new Error('Invalid compatibility date')
  if (m.retirementDelaySeconds !== undefined &&
      (!Number.isSafeInteger(m.retirementDelaySeconds) || m.retirementDelaySeconds < 0 || m.retirementDelaySeconds > Math.floor(Number.MAX_SAFE_INTEGER / 1000))) {
    throw new Error('Invalid preview retirement delay')
  }
  const seen = new Set(), suffixes = new Set()
  for (const [key, component] of Object.entries(map(m.components, 'components'))) {
    if (!/^[a-z][a-zA-Z0-9]{0,24}$/.test(key) || !/^[a-z][a-z0-9-]{0,24}$/.test(component.suffix) || suffixes.has(component.suffix)) throw new Error('Invalid or duplicate component')
    relativePath(component.entry)
    if (component.assets) relativePath(component.assets)
    for (const [binding,target] of Object.entries(component.services || {})) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(binding) || !seen.has(target)) throw new Error('Service must reference an earlier component')
    }
    seen.add(key)
    suffixes.add(component.suffix)
  }
  if (Array.from(seen).at(-1) !== 'gateway' || m.components.gateway.suffix !== 'gateway') throw new Error('The gateway must be the last component')
  if (!/^\/(?!\/)[A-Za-z0-9_/.~-]*$/.test(m.smokePath || '')) throw new Error('Invalid application smoke path')
  if (m.launcher) relativePath(m.launcher)
  if (m.schemaSubscriber) relativePath(m.schemaSubscriber.entry)
  return m
}
export function loadManifest(root, filename) {
  return validateManifest(parse(readFileSync(ownedPath(root, filename), 'utf8'), { maxAliasCount: 0 }))
}
