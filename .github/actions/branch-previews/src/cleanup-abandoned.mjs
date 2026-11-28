// Run under the deployment workflow's shared concurrency group. A durable
// cleanup marker blocks reuse of this branch while a partial deletion is retried.
export async function cleanupAbandoned({ ref, store, deleteResources, now = Date.now, graceMs = 3600_000 }) {
  let snapshot = await store.read(ref)
  if (!snapshot) return { status: 'absent' }
  let record = snapshot.record
  async function save(updated) {
    if (!await store.compareAndSwap(ref, snapshot.revision, updated)) throw new Error('Inventory changed during abandoned cleanup')
    snapshot = { revision: snapshot.revision + 1, record: updated }
    record = updated
  }
  const abandoned = record.abandoned || []
  if (!abandoned.length) return { status: 'empty' }
  if (record.candidate) return { status: 'busy' }
  if (!Number.isSafeInteger(graceMs) || graceMs < 0) throw new Error('Invalid abandoned cleanup grace period')
  const unmarked = abandoned.find(item => !Number.isSafeInteger(item.abandonedAt))
  if (unmarked) {
    await save({ ...record, abandoned: abandoned.map(item => item === unmarked ? { ...item, abandonedAt: now() } : item) })
    return { status: 'draining' }
  }
  const current = record.abandonedCleanup
  const candidate = current ? abandoned.find(item => item.sha === current.sha && item.generation === current.generation) : abandoned.find(item => now() - item.abandonedAt >= graceMs && item.sha !== record.active?.sha && item.sha !== record.previous?.sha)
  if (!candidate) {
    if (current) throw new Error('Abandoned cleanup record is missing')
    return { status: 'draining' }
  }
  if (!current) await save({ ...record, abandonedCleanup: { sha: candidate.sha, generation: candidate.generation } })
  const outcome = await deleteResources({ ref, release: candidate })
  if (outcome?.unresolved) {
    await save({ ...record, abandonedCleanup: null })
    return { status: 'unresolved' }
  }
  let removed = false
  const remaining = record.abandoned.filter(item => {
    if (!removed && item.sha === candidate.sha && item.generation === candidate.generation) { removed = true; return false }
    return true
  })
  await save({ ...record, abandoned: remaining, abandonedCleanup: null })
  return { status: 'deleted' }
}
