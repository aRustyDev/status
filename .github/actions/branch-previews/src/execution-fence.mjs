import { readFileSync } from 'node:fs'

// Inventory is already authoritative for every release operation. Avoid
// adding fence-table DDL/read dependencies until a current or retained Worker
// or isolated-preview history requires it, or a new fixture is deployed.
export function inventoryHasFencedResources(snapshots) {
  if (!Array.isArray(snapshots)) throw new Error('Invalid preview inventory')
  for (const snapshot of snapshots) {
    const record = snapshot?.record
    if (!record || typeof record !== 'object' || Array.isArray(record) || (record.retained !== undefined && !Array.isArray(record.retained))) throw new Error('Invalid preview inventory')
    for (const release of [record.active, record.previous, record.candidate, ...(record.retained || [])]) {
      if (release == null) continue
      // Fallback releases retain this marker after the fixture Workers are
      // removed. The authoritative row must still advance during recovery.
      if (release.resources?.isolatedPreview === true) return true
      const workers = release.resources?.workers
      if (workers == null) continue
      if (typeof workers !== 'object' || Array.isArray(workers)) throw new Error('Invalid preview Worker inventory')
      // A malformed name is still a recorded fence and must not silently skip
      // the fail-closed dependency.
      if (Object.hasOwn(workers, 'fence')) return true
    }
  }
  return false
}

export async function initializeExecutionFenceIfNeeded({ store, fixtureEnabled = false, createFence, ref }) {
  if (!store || typeof createFence !== 'function' || typeof fixtureEnabled !== 'boolean' ||
      (ref === undefined ? typeof store.list !== 'function' : typeof ref !== 'string' || !ref.startsWith('refs/heads/') || typeof store.read !== 'function')) throw new Error('Invalid execution fence initialization')
  // Deployments inspect only their own branch; another branch's fixtures
  // cannot make an ordinary deployment depend on the fence tables.
  // Reconciliation omits ref and checks every record before cleanup.
  const current = ref === undefined ? null : await store.read(ref)
  const snapshots = ref === undefined ? await store.list() : (current ? [current] : [])
  if (!fixtureEnabled && !inventoryHasFencedResources(snapshots)) return null
  // Validate the inventory even when the requested release itself is a fixture.
  if (fixtureEnabled) inventoryHasFencedResources(snapshots)
  const fence = createFence()
  if (!fence || typeof fence.initialize !== 'function') throw new Error('Invalid execution fence controller')
  await fence.initialize()
  return fence
}

// Only the dedicated controller inventory database may receive these tables.
// Statements are additive and rerunnable; incompatible existing tables fail
// before any branch can be activated or retired.
export async function ensureExecutionFenceSchema(query) {
  if (typeof query !== 'function') throw new Error('Invalid execution fence query')
  const sql = readFileSync(new URL('./preview-execution-fence.sql', import.meta.url), 'utf8')
  for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await query(statement, [])
  for (const [table, names] of Object.entries({
    preview_execution_fences: ['selector','active_release','state'],
    preview_execution_leases: ['lease_id','selector','release'],
    preview_email_quota: ['selector','sent_at'],
  })) {
    const columns = await query(`PRAGMA table_info(${table})`, [])
    if (!Array.isArray(columns) || names.some(name => !columns.some(column => column.name === name))) throw new Error('Incompatible execution fence schema')
    if (table === 'preview_execution_fences' && columns.some(column => column.name === 'lease_id')) {
      if ((await query('SELECT selector FROM preview_execution_fences WHERE lease_id IS NOT NULL LIMIT 1', [])).length) throw new Error('Legacy execution lease requires manual recovery')
    }
  }
}

// Once a branch has had a fence, retain and advance it even through an
// unfenced release. This prevents an old scheduler from being overlooked
// when that branch later opts back into fixtures.
export function executionFenceFor(controller) {
  if (!controller || typeof controller.readState !== 'function') throw new Error('Missing execution fence controller')
  return async ({ selector, sha, resources, active, previous: prior, retained = [] }) => {
    assertSelector(selector); assertRelease(sha)
    const incomingFenced = Boolean(resources?.workers?.fence)
    const previousFenced = Boolean(active?.resources?.workers?.fence)
    const retainedFenced = [prior, ...retained].some(release => Boolean(release?.resources?.workers?.fence))
    const state = await controller.readState(selector)
    if (!state) {
      if (previousFenced || retainedFenced) throw new Error('Recorded fixture release has no execution fence')
      return incomingFenced ? { controller, previousRelease: null } : null
    }
    const previous = active?.sha ?? null
    assertRelease(previous, true)
    if (state.activeRelease === sha && state.state === 'active') return { controller, previousRelease: previous }
    // A deleted branch can be drained after its candidate was published but
    // before inventory promotion. If recreated, recovery must revalidate the
    // route before reactivating that already-published candidate.
    if (state.activeRelease === sha && state.state === 'draining') return { controller, previousRelease: sha }
    if (state.activeRelease === previous) return { controller, previousRelease: previous }
    // A first fenced candidate can be interrupted after creating its empty
    // row while the previously active release was an unfenced one.
    if (state.activeRelease === null && !previousFenced) return { controller, previousRelease: null }
    // Once all older fenced Workers have been retired from inventory, an
    // unfenced branch can advance without touching this table. On later
    // re-opt-in, drain the obsolete state (including any last in-flight
    // lease) before switching to the new approved release.
    if (incomingFenced && !previousFenced && !retainedFenced) return { controller, previousRelease: state.activeRelease }
    throw new Error('Execution fence does not match preview inventory')
  }
}

function assertSelector(selector) {
  if (!/^branch-[a-f0-9]{24}$/.test(selector || '')) throw new Error('Invalid execution fence selector')
}
function assertRelease(release, nullable = false) {
  if (nullable && release === null) return
  if (!/^[a-f0-9]{40}$/.test(release || '')) throw new Error('Invalid execution fence release')
}

// All methods require the controller's non-preemptive branch deployment lock.
// An ambiguous/stuck holder is NEVER stolen, including after a long timeout.
export function createExecutionFenceController({ query, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 60 }) {
  if (typeof query !== 'function' || typeof wait !== 'function' || !Number.isSafeInteger(attempts) || attempts < 1) throw new Error('Invalid execution fence configuration')
  async function row(selector) {
    const rows = await query('SELECT active_release, state, EXISTS (SELECT 1 FROM preview_execution_leases l WHERE l.selector=preview_execution_fences.selector) AS leased FROM preview_execution_fences WHERE selector=?', [selector])
    if (rows.length > 1) throw new Error('Ambiguous execution fence')
    return rows[0] || null
  }
  async function drain(selector, expected) {
    const rows = await query("UPDATE preview_execution_fences SET state='draining' WHERE selector=? AND active_release IS ? RETURNING selector", [selector, expected])
    if (rows.length !== 1) throw new Error('Execution fence changed before drain')
    for (let i = 0; i < attempts; i++) {
      const current = await row(selector)
      if (!current || current.state !== 'draining' || current.active_release !== expected) throw new Error('Execution fence changed during drain')
      if (current.leased === 0) return
      if (i + 1 < attempts) await wait(1000)
    }
    throw new Error('Preview execution is still leased; manual recovery may be required')
  }
  return {
    async readState(selector) {
      assertSelector(selector)
      const current = await row(selector)
      if (!current) return null
      assertRelease(current.active_release, true)
      if (!['active', 'draining'].includes(current.state) || (current.state === 'active' && current.active_release === null)) throw new Error('Invalid execution fence state')
      return { activeRelease: current.active_release, state: current.state, leased: current.leased === 1 }
    },
    async beginActivation({ selector, previousRelease, release }) {
      assertSelector(selector); assertRelease(previousRelease, true); assertRelease(release)
      await query("INSERT INTO preview_execution_fences(selector,active_release,state) VALUES (?,NULL,'draining') ON CONFLICT(selector) DO NOTHING RETURNING selector", [selector])
      const current = await row(selector)
      if (current?.state === 'active' && current.active_release === release) return 'already-active'
      if (!current || current.active_release !== previousRelease) throw new Error('Unexpected active execution release')
      await drain(selector, previousRelease)
      return 'drained'
    },
    async finishActivation({ selector, previousRelease, release }) {
      assertSelector(selector); assertRelease(previousRelease, true); assertRelease(release)
      const result = await query("UPDATE preview_execution_fences SET active_release=?, state='active' WHERE selector=? AND state='draining' AND active_release IS ? AND NOT EXISTS (SELECT 1 FROM preview_execution_leases l WHERE l.selector=preview_execution_fences.selector) RETURNING selector", [release, selector, previousRelease])
      if (result.length === 1) return
      const current = await row(selector)
      if (current?.state === 'active' && current.active_release === release) return
      throw new Error('Execution fence could not activate')
    },
    async beginRetirement(selector) {
      assertSelector(selector)
      const current = await row(selector)
      if (!current) return null
      assertRelease(current.active_release, true)
      await drain(selector, current.active_release)
      return current.active_release
    },
    async finishRetirement(selector, previousRelease) {
      assertSelector(selector); assertRelease(previousRelease, true)
      const result = await query("UPDATE preview_execution_fences SET active_release=NULL,state='draining' WHERE selector=? AND active_release IS ? AND state='draining' AND NOT EXISTS (SELECT 1 FROM preview_execution_leases l WHERE l.selector=preview_execution_fences.selector) RETURNING selector", [selector, previousRelease])
      if (result.length === 1) return
      const current = await row(selector)
      if (!current || (current.state === 'draining' && current.active_release === null && current.leased === 0)) return
      throw new Error('Execution fence could not retire')
    },
  }
}

export function createCloudflareExecutionFence({ accountId, databaseId, token, fetchImpl = fetch, ...options }) {
  if (!accountId || !databaseId || !token || typeof fetchImpl !== 'function') throw new Error('Missing execution fence database credentials')
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`
  const query = async (sql, params) => {
    const response = await fetchImpl(url, { method:'POST', headers:{authorization:`Bearer ${token}`,'content-type':'application/json'}, body:JSON.stringify({sql,params}) })
    const result = await response.json()
    if (!response.ok || result.success !== true || !Array.isArray(result.result) || result.result.length !== 1 || result.result[0].success !== true || !Array.isArray(result.result[0].results)) throw new Error('Execution fence query failed')
    return result.result[0].results
  }
  return { ...createExecutionFenceController({ query, ...options }), initialize: () => ensureExecutionFenceSchema(query) }
}
