import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { installation } from './installation.mjs'

const files = ['preview-subscriber-scheduler.ts', 'subscriber-delivery.ts', 'subscribers.ts', 'email-channel.ts', 'idempotency.ts', 'index.ts']
const digest = value => createHash('sha256').update(value).digest('hex')

// Only this explicitly approved schema branch and reviewed source can receive
// the restricted email binding. Missing or malformed configuration fails closed.
export function schemaSubscriberSettings({ value, environment, branch, sha, branchDir, previewUrl, now = Date.now() }) {
  if (!value?.enabled || environment !== 'schema' || value.branch !== branch) return null
  if (!installation().legacy || value.enabled !== true || !/^schema\/[A-Za-z0-9._/-]+$/.test(branch) ||
      !/^[a-f0-9]{40}$/.test(sha || '') || !/^[a-f0-9]{40}$/.test(value.release || '') ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0 || value.expiresAt > now + 48 * 3600_000 ||
      typeof value.sender !== 'string' || typeof value.recipient !== 'string' ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.sender) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.recipient)) throw new Error('Invalid schema subscriber email restrictions')
  const url = new URL(value.publicUrl)
  const expected = new URL(previewUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.origin !== expected.origin) throw new Error('Invalid schema subscriber URL')
  const manifest = value.approvedSourceManifest
  const artifactHashes = value.approvedArtifactHashes
  const approved = value.approvedMigrationHashes
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || Object.keys(manifest).length !== files.length || !files.every(name => /^[a-f0-9]{64}$/.test(manifest[name] || '')) ||
      !artifactHashes || typeof artifactHashes !== 'object' || Array.isArray(artifactHashes) || Object.keys(artifactHashes).sort().join(',') !== 'api,subscriber' || !['api','subscriber'].every(name => /^[a-f0-9]{64}$/.test(artifactHashes[name] || '')) ||
      !approved || typeof approved !== 'object' || Array.isArray(approved) || !Object.keys(approved).length || !Object.entries(approved).every(([name,hash]) => /^[a-zA-Z0-9_-]+\.sql$/.test(name) && /^[a-f0-9]{64}$/.test(hash || ''))) throw new Error('Invalid schema subscriber approval')
  if (value.release !== sha || value.expiresAt <= now) return null
  const artifactManifest = JSON.parse(readFileSync(path.join(branchDir, 'workers/subscriber-source.json'), 'utf8'))
  if (Object.keys(artifactManifest).length !== files.length || !files.every(name => manifest[name] === artifactManifest[name])) throw new Error('Schema subscriber source is not approved')
  for (const name of ['api', 'subscriber']) {
    if (!/^[a-f0-9]{64}$/.test(value.approvedArtifactHashes?.[name] || '') || value.approvedArtifactHashes[name] !== digest(readFileSync(path.join(branchDir, `workers/${name}.mjs`)))) throw new Error('Schema subscriber artifact is not approved')
  }
  const migrationNames = readdirSync(path.join(branchDir, 'migrations')).sort()
  if (Object.keys(approved).sort().join('\n') !== migrationNames.join('\n') ||
      !migrationNames.every(name => /^[a-zA-Z0-9_-]+\.sql$/.test(name) && /^[a-f0-9]{64}$/.test(approved[name] || '') && approved[name] === digest(readFileSync(path.join(branchDir, 'migrations', name))))) throw new Error('Schema subscriber migrations are not approved')
  return { sender: value.sender, recipient: value.recipient, publicUrl: url.href, expiresAt: value.expiresAt }
}

export function subscriberScope(selector) { return digest(selector) }

// Reject every database except the owned schema upgrade DB belonging to this
// exact branch/release; never issue fence writes to shared Dev, Stage or Prod.
export function schemaDatabaseForRelease({ ref, release, config }) {
  if (!release?.resources?.workers?.subscriber) return null
  const database = release.resources.database
  const prefix = `${installation().schemaStem(ref, release.sha)}-upgrade`
  if (!/^refs\/heads\/schema\//.test(ref) || !/^[a-f0-9]{40}$/.test(release.sha || '') ||
      !database?.owned || database.name !== prefix || !database.id || !config.inventoryDatabaseId || config.inventoryDatabaseId === database.id || ['dev', 'stage', 'prod'].some(k => !config[k]?.id || config[k].id === database.id)) throw new Error('Invalid subscriber schema database')
  return database
}

export function createSchemaFence({ query, findDatabase, config }) {
  if (typeof query !== 'function' || typeof findDatabase !== 'function') throw new Error('Missing schema fence database verifier')
  async function verified(ref, release) {
    const database = schemaDatabaseForRelease({ref,release,config})
    if (!database) return null
    const actual = await findDatabase(database.name)
    if (!actual || actual.name !== database.name || actual.id !== database.id) throw new Error('Schema subscriber database identity changed')
    return database
  }
  return {
    async revoke({ ref, selector, release }) {
      const database = await verified(ref, release)
      if (database) await query(database, "DELETE FROM preview_subscriber_leases WHERE scope=? AND slot=1 AND target='a' AND release=?", [subscriberScope(selector), release.sha])
    },
    async activate({ ref, selector, release }) {
      const database = await verified(ref, release)
      if (database) {
        const expiresAt = release.resources.subscriberExpiresAt
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 48 * 3600_000) throw new Error('Invalid schema subscriber lease expiry')
        await query(database, "INSERT INTO preview_subscriber_leases (scope,slot,target,release,expires_at) VALUES (?,1,'a',?,?) ON CONFLICT(slot) DO UPDATE SET scope=excluded.scope,target=excluded.target,release=excluded.release,expires_at=excluded.expires_at", [subscriberScope(selector), release.sha, expiresAt])
      }
    },
  }
}
