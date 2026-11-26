import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const migrationName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.sql$/
const digest = value => createHash('sha256').update(value).digest('hex')

async function migrations(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const names = entries.filter(entry => entry.name.endsWith('.sql')).map(entry => {
    if (!entry.isFile() || !migrationName.test(entry.name)) throw new Error(`Invalid migration: ${entry.name}`)
    return entry.name
  }).sort()
  if (!names.length) throw new Error('Migration directory is empty')
  return new Map(await Promise.all(names.map(async name => [name, await readFile(path.join(directory, name))])))
}

function sharedDatabase(config, kind) {
  const database = config[kind]
  if (!database || typeof database.id !== 'string' || !database.id || typeof database.name !== 'string' || !database.name) {
    throw new Error(`Missing ${kind} database configuration`)
  }
  const prod = config.prod
  if (!prod || typeof prod.id !== 'string' || !prod.id) throw new Error('Missing production database identity')
  if (database.id === prod.id) throw new Error('Preview database must not be production')
  return { id: database.id, name: database.name, owned: false }
}

/**
 * Adapter methods: migrationLedger(database), createDatabase(name), applyMigrations(database, directory),
 * seed(database), deleteDatabase(database), and recordDatabase(database, purpose).
 * recordDatabase must persist the returned resource before any subsequent operation.
 */
export async function prepareDatabase({ kind, ref, sha, config, mainMigrations, candidateMigrations, adapter }) {
  if (!['dev', 'stage', 'schema'].includes(kind)) throw new Error('Invalid preview database kind')
  if (typeof ref !== 'string' || !ref || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid branch identity')
  const main = await migrations(mainMigrations)
  const candidate = await migrations(candidateMigrations)

  if (kind !== 'schema') {
    const database = sharedDatabase(config, kind)
    const approved = config.approvedMigrationHashes ?? {}
    if (!approved || typeof approved !== 'object' || Array.isArray(approved)) throw new Error('Invalid approved migration hashes')
    for (const [name, content] of candidate) {
      const source = main.get(name)
      if (source ? !source.equals(content) : approved[name] !== digest(content)) {
        throw new Error(`Unapproved migration: ${name}`)
      }
    }
    const applied = new Set(await adapter.migrationLedger(database))
    const missing = [...candidate.keys()].filter(name => !applied.has(name))
    if (missing.length) throw new Error(`Database is missing migrations: ${missing.join(', ')}`)
    return database
  }

  // Wrangler runs filenames in order; an upgrade must preserve the complete main history.
  const mainNames = [...main.keys()]
  const candidateNames = [...candidate.keys()]
  for (let i = 0; i < mainNames.length; i++) {
    const name = mainNames[i]
    if (candidateNames[i] !== name || !candidate.get(name)?.equals(main.get(name))) {
      throw new Error(`Schema branch changes or reorders existing migration: ${name}`)
    }
  }
  for (const environment of ['dev', 'stage', 'prod']) {
    if (typeof config[environment]?.id !== 'string' || !config[environment].id) throw new Error(`Missing ${environment} database identity`)
  }
  const prefix = `status-schema-${digest(ref).slice(0, 12)}-${sha.slice(0, 12)}`
  const create = async purpose => {
    const name = `${prefix}-${purpose}`
    const resource = await adapter.createDatabase(name)
    if (!resource || resource.name !== name || typeof resource.id !== 'string' || !resource.id || resource.id === config.prod?.id || resource.id === config.dev?.id || resource.id === config.stage?.id) {
      throw new Error(`Invalid newly created database for ${purpose}`)
    }
    const database = { id: resource.id, name, owned: true }
    await adapter.recordDatabase(database, purpose)
    return database
  }
  const upgrade = await create('upgrade')
  await adapter.applyMigrations(upgrade, mainMigrations)
  await adapter.seed(upgrade)
  await adapter.applyMigrations(upgrade, candidateMigrations)
  const clean = await create('clean')
  await adapter.applyMigrations(clean, candidateMigrations)
  await adapter.deleteDatabase(clean)
  return upgrade
}

export async function deleteOwnedDatabase({ database, config, adapter }) {
  if (!database || database.owned !== true || typeof database.id !== 'string' || !database.id ||
      typeof database.name !== 'string' || !/^status-schema-[a-f0-9]{12}-[a-f0-9]{12}-(upgrade|clean)$/.test(database.name)) {
    throw new Error('Database is not a recorded preview-owned schema database')
  }
  if (['dev', 'stage', 'prod'].some(kind => !config[kind]?.id || config[kind].id === database.id)) {
    throw new Error('Database identity is shared or shared identities are missing')
  }
  await adapter.deleteDatabase(database)
}
