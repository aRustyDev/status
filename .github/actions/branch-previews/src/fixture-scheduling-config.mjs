import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { installation } from './installation.mjs'

// This generator receives controller-owned paths and the recorded D1 identity,
// never content from the feature artifact. No branch Worker receives INVENTORY.
export function createFixtureSchedulingConfigs({ref, selector, sha, database, inventoryDatabase, sharedDatabaseIds, flagshipAppId, runtimeDir, probeName, dir, expiresAt, now = Date.now()}) {
  const app=installation()
  if (!/^branch-[a-f0-9]{24}$/.test(selector || '') || selector !== `branch-${app.branchKey(ref)}` || !/^[a-f0-9]{40}$/.test(sha || '')) throw new Error('Invalid fixture release identity')
  if (database?.owned !== true || typeof database.id !== 'string' || !database.id || database.name !== app.schemaStem(ref,sha)+'-upgrade') throw new Error('Fixture database must be owned by this release')
  if (!inventoryDatabase || typeof inventoryDatabase.id !== 'string' || !inventoryDatabase.id || typeof inventoryDatabase.name !== 'string' || !inventoryDatabase.name) throw new Error('Missing inventory database identity')
  if (!Array.isArray(sharedDatabaseIds) || sharedDatabaseIds.length < 3 || new Set(sharedDatabaseIds).size !== sharedDatabaseIds.length || sharedDatabaseIds.some(id=>typeof id !== 'string' || !id)) throw new Error('Missing shared database isolation list')
  if (database.id === inventoryDatabase.id || sharedDatabaseIds.includes(database.id) || sharedDatabaseIds.includes(inventoryDatabase.id)) throw new Error('Fixture databases are not isolated')
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 48*3600_000) throw new Error('Fixture approval is expired or invalid')
  if (typeof flagshipAppId !== 'string' || !flagshipAppId || !path.isAbsolute(runtimeDir || '') || !path.isAbsolute(dir || '')) throw new Error('Missing trusted fixture configuration')
  const stem=app.workerStem(selector,sha)
  if (probeName !== `${stem}-${app.manifest.components.probe?.suffix}` || !app.manifest.components.probe) throw new Error('Probe is not owned by this release')
  const names = {fence:`${stem}-fence`,probeScheduler:`${stem}-probe-scheduler`}
  const shared = { compatibility_date:app.manifest.compatibilityDate, workers_dev:false, preview_urls:false, observability:{enabled:true} }
  const configs = {
    fence:{...shared,name:names.fence,main:path.join(runtimeDir,'preview-fence.mjs'),vars:{PREVIEW_SELECTOR:selector,PREVIEW_RELEASE:sha,PREVIEW_FLAG_PREFIX:app.flagPrefix,PREVIEW_FIXTURE_EXPIRES_AT:String(expiresAt)},d1_databases:[{binding:'INVENTORY',database_id:inventoryDatabase.id,database_name:inventoryDatabase.name}],flagship:[{binding:'FLAGS',app_id:flagshipAppId}],triggers:{crons:[]}},
    probeScheduler:{...shared,name:names.probeScheduler,main:path.join(runtimeDir,'preview-probe-scheduler.mjs'),services:[{binding:'PREVIEW_FENCE',service:names.fence},{binding:'PROBE',service:probeName}],triggers:{crons:['* * * * *']}},
  }
  for (const [id, config] of Object.entries(configs)) writeFileSync(path.join(dir, id+'.json'),JSON.stringify(config),{mode:0o600})
  return { names, configs, order:['fence','probeScheduler'] }
}
