// The caller must hold the same non-preemptive lock used by deployment for the
// entire operation. All adapters must be idempotent and fail on ambiguity.
export async function retireDeletedBranch({ ref, store, readRemoteHead, disableFlag, resolveDisable, removeBindings, deleteOwnedResources, propagationElapsed, now = Date.now }) {
  if (await readRemoteHead(ref) !== null) throw new Error('Branch still exists')
  let snapshot = await store.read(ref)
  if (!snapshot) return { status: 'absent' }
  let record = snapshot.record
  if (record.abandonedCleanup) throw new Error('Abandoned resource cleanup requires reconciliation before retirement')
  if (record.retainedCleanup) throw new Error('Retained resource cleanup requires reconciliation before retirement')
  if (record.candidate) throw new Error('Candidate requires reconciliation before retirement')
  async function save(updated) {
    if (!await store.compareAndSwap(ref, snapshot.revision, updated)) throw new Error('Inventory changed concurrently')
    snapshot = { revision: snapshot.revision + 1, record: updated }
    record = updated
  }
  const pendingDisable = record.retirement?.phase === 'disabling'
  if (!record.retirement) {
    await save({ ...record, retirement: { phase: 'disabling' } })
  }
  if (record.retirement.phase === 'disabling') {
    // A previous timeout can leave a write in flight. The resolver must ensure
    // any retry has the same tombstone and finish before the drain begins.
    if (pendingDisable) {
      if (typeof resolveDisable !== 'function' || !await resolveDisable({ ref, selector: record.selector })) throw new Error('Flag disable requires reconciliation')
    } else {
      await disableFlag({ ref, selector: record.selector })
    }
    await save({ ...record, retirement: { phase: 'draining', disabledAt: now() } })
  }
  if (record.retirement.phase === 'draining') {
    if (!await propagationElapsed(record.retirement.disabledAt, ref)) return { status: 'draining' }
    if (await readRemoteHead(ref) !== null) throw new Error('Branch was recreated during retirement')
    const releases = [record.active, record.previous, ...(record.retained || [])].filter(Boolean)
    await removeBindings({ ref, releases })
    await save({ ...record, retirement: { ...record.retirement, phase: 'deleting' } })
  }
  if (record.retirement.phase === 'deleting') {
    if (await readRemoteHead(ref) !== null) throw new Error('Branch was recreated during retirement')
    const releases = [record.active, record.previous, ...(record.retained || [])].filter(Boolean)
    const seen = new Set()
    for (const release of releases) {
      const key = JSON.stringify({ sha: release.sha, resources: release.resources })
      if (seen.has(key)) continue
      seen.add(key)
      await deleteOwnedResources({ ref, environment: record.environment, release })
    }
    await save({ ...record, active: null, previous: null, retained: [], retirement: { ...record.retirement, phase: 'deleted' } })
  }
  if (record.retirement.phase !== 'deleted') throw new Error('Unknown retirement phase')
  return { status: 'deleted' }
}
