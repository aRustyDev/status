import { installation } from './installation.mjs'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { branchKey, validateInventory } from './release-contract.mjs'
import { deleteOwnedDatabase } from './database.mjs'

// All callers share the deployment workflow's concurrency group. A timed-out
// flag update stays in the inventory's disabling phase for operator recovery.
export function createRetirementAdapter({ accountId, appId, token, store, dispatcherName, dispatcherSource, dispatcherVars = {}, directory, run, databaseConfig, databaseAdapter, fetcher = fetch, now = Date.now, drainMs = 3600_000, executionFence }) {
  if (!accountId || !appId || !token || !store || !dispatcherName || !dispatcherSource || !directory || typeof run !== 'function' || !databaseConfig || !databaseAdapter || !Number.isSafeInteger(drainMs) || drainMs < 3600_000) throw new Error('Invalid retirement configuration')
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}`
  async function request(url, method = 'GET', body) {
    const response = await fetcher(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`Cloudflare retirement request failed (${response.status})`)
    if (response.status === 204) return true
    const payload = await response.json()
    if (!payload.success) throw new Error('Cloudflare retirement request failed')
    return payload.result ?? true
  }
  const flagUrl = ref => `${base}/flagship/apps/${encodeURIComponent(appId)}/flags/${installation().flagPrefix}branch-${branchKey(ref)}`
  async function disableFlag({ ref, selector }) {
    if (executionFence) {
      const snapshot = await store.read(ref)
      if (!snapshot?.record || snapshot.record.selector !== selector) throw new Error('Preview inventory changed before retirement')
      const active = snapshot.record.active
      const state = await executionFence.readState(selector)
      if ([active, snapshot.record.previous, ...(snapshot.record.retained || [])].some(release => release?.resources?.workers?.fence) && !state) throw new Error('Recorded fixture release has no execution fence')
      if (state && state.activeRelease !== (active?.sha ?? null) && !(state.state === 'draining' && state.activeRelease === null)) throw new Error('Execution fence does not match preview inventory')
    }
    const retiringRelease = executionFence ? await executionFence.beginRetirement(selector) : null
    const flag = await request(flagUrl(ref))
    if (!flag) {
      if (executionFence) await executionFence.finishRetirement(selector, retiringRelease)
      return
    }
    if (flag.default_variation !== 'current' || flag.rules?.length || !flag.variations?.current || (flag.variations.current.selector !== selector && Object.keys(flag.variations.current).length !== 0)) throw new Error('Unexpected Flagship state before retirement')
    await request(flagUrl(ref), 'PUT', { key: installation().flagPrefix + 'branch-' + branchKey(ref), enabled: true, default_variation: 'current', rules: [], variations: { current: {} } })
    if (executionFence) await executionFence.finishRetirement(selector, retiringRelease)
  }
  return {
    disableFlag,
    // Retry the identical tombstone after an interrupted write. Both writes
    // have the same result, and the drain starts only after this one returns.
    async resolveDisable(candidate) {
      await disableFlag(candidate)
      return true
    },
    async propagationElapsed(disabledAt, ref) {
      if (!Number.isSafeInteger(disabledAt) || now() - disabledAt < drainMs) return false
      const flag = await request(flagUrl(ref))
      return !flag || (flag.enabled === true && flag.default_variation === 'current' && !flag.rules?.length && flag.variations?.current && Object.keys(flag.variations.current).length === 0)
    },
    async removeBindings({ ref, releases = [], keepBranch = false }) {
      const snapshots = await store.list()
      const services = new Map()
      const removedShas = new Set(releases.map(release => release.sha))
      for (const { record } of snapshots) {
        validateInventory(record)
        if (record.ref === ref && !keepBranch) continue
        if (record.retainedCleanup?.sha && (record.active?.sha === record.retainedCleanup.sha || record.previous?.sha === record.retainedCleanup.sha)) throw new Error('Retained cleanup conflicts with active routing')
        for (const release of [record.active, record.previous, ...(record.retained || []), ...(['ready', 'activating'].includes(record.candidate?.phase) ? [record.candidate] : [])]) {
          if (!release) continue
          if (record.retainedCleanup?.sha === release.sha) continue
          if (record.ref === ref && removedShas.has(release.sha)) continue
          const expected = installation().workerStem(record.selector, release.sha) + '-gateway'
          if (release.resources?.gateway !== expected) throw new Error('Invalid retained Worker binding')
          services.set(`PREVIEW_BRANCH_${record.key.toUpperCase()}_${release.sha.toUpperCase()}`, expected)
        }
      }
      const config = { name: dispatcherName, main: path.resolve(dispatcherSource), compatibility_date: '2026-11-23', workers_dev: false, preview_urls: false, flagship: [{ binding: 'FLAGS', app_id: appId }], vars: { ...dispatcherVars, PREVIEW_HEADER: installation().header, FLAG_PREFIX: installation().flagPrefix }, services: [...services].map(([binding, service]) => ({ binding, service })) }
      const configPath = path.join(directory, 'retirement-dispatcher.json')
      writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 })
      await run(['deploy', '--dry-run', '--config', configPath])
      await run(['deploy', '--config', configPath])
    },
    async deleteOwnedResources({ ref, release }) {
      const selector = `branch-${branchKey(ref)}`
      if (!/^[a-f0-9]{40}$/.test(release.sha)) throw new Error('Invalid release SHA')
      const stem = installation().workerStem(selector, release.sha)
      const suffixes = Object.fromEntries(Object.entries(installation().manifest.components).map(([key, component]) => [key, component.suffix]))
      const workers = release.resources?.workers
      // Optional private fixtures are owned only when their deterministic names
      // were recorded as part of this release. Never accept arbitrary extras.
      if (workers?.fixture) suffixes.fixture = 'fixture'
      if (workers?.cas && workers?.fixture) suffixes.cas = 'cas'
      if (workers?.fence && workers?.fixture) suffixes.fence = 'fence'
      if (workers?.probeScheduler && workers?.fence && workers?.fixture) suffixes.probeScheduler = 'probe-scheduler'
      if (workers?.mailer && workers?.fence && workers?.fixture) suffixes.mailer = 'mailer'
      if (workers?.subscriberFeature && workers?.mailer && workers?.fence && workers?.fixture) suffixes.subscriberFeature = 'subscriber-feature'
      if (workers?.subscriberScheduler && workers?.subscriberFeature && workers?.mailer && workers?.fence && workers?.fixture) suffixes.subscriberScheduler = 'subscriber-scheduler'
      if (!workers || Object.keys(workers).length !== Object.keys(suffixes).length || Object.entries(suffixes).some(([key, suffix]) => workers[key] !== `${stem}-${suffix}`) || release.resources.gateway !== workers.gateway) throw new Error('Worker ownership verification failed')
      // Delete in reverse service dependency order. Never use force.
      const order = (workers.subscriberScheduler ? ['subscriberScheduler'] : []).concat(workers.probeScheduler ? ['probeScheduler'] : [], Object.keys(installation().manifest.components).reverse(), workers.subscriberFeature ? ['subscriberFeature'] : [], workers.mailer ? ['mailer'] : [], workers.cas ? ['cas'] : [], workers.fixture ? ['fixture'] : [], workers.fence ? ['fence'] : [])
      for (const key of order) await request(`${base}/workers/scripts/${encodeURIComponent(workers[key])}`, 'DELETE')
      for (const database of [release.resources.database, release.resources.validationDatabase]) {
        if (database?.owned) await deleteOwnedDatabase({ database, config: databaseConfig, adapter: databaseAdapter, ref, sha: release.sha })
      }
    },
    async deleteAbandonedResources({ ref, release }) {
      const resources = release.resources || {}
      if (resources.workers) await this.deleteOwnedResources({ ref, release: { ...release, resources: { ...resources, database: null, validationDatabase: null } } })
      for (const database of [resources.database, resources.validationDatabase]) {
        if (database?.owned) await deleteOwnedDatabase({ database, config: databaseConfig, adapter: databaseAdapter, ref, sha: release.sha })
      }
      // Intent alone is not proof of a database's identity. Keep the record
      // for an operator rather than deleting a potentially unrelated D1.
      return { unresolved: Boolean((resources.databaseIntent && !resources.database) || (resources.validationDatabaseIntent && !resources.validationDatabase)) }
    },
  }
}
