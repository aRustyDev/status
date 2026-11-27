// Releases move to retained only after two later versions have been selected.
// The dispatcher is redeployed before their resources are deleted.
export async function cleanupRetained({ ref, store, removeBindings, deleteResources, now = Date.now, graceMs = 3600_000 }) {
  let snapshot = await store.read(ref)
  if (!snapshot) return { status: 'absent' }
  let record = snapshot.record
  async function save(updated) {
    if (!await store.compareAndSwap(ref, snapshot.revision, updated)) throw new Error('Inventory changed during retained cleanup')
    snapshot = { revision: snapshot.revision + 1, record: updated }
    record = updated
  }
  const retained = record.retained || []
  if (!retained.length) return { status: 'empty' }
  if (record.candidate || record.retirement || record.abandonedCleanup) return { status: 'busy' }
  if (!Number.isSafeInteger(graceMs) || graceMs < 3600_000) throw new Error('Invalid retained cleanup grace period')
  if (retained.some(item => !Number.isSafeInteger(item.retainedAt))) {
    await save({ ...record, retained: retained.map(item => Number.isSafeInteger(item.retainedAt) ? item : { ...item, retainedAt: now() }) })
    return { status: 'draining' }
  }
  const eligible = item => item.sha !== record.active?.sha && item.sha !== record.previous?.sha && now() - item.retainedAt >= graceMs
  const sha = record.retainedCleanup?.sha || retained.find(item => eligible(item) && retained.filter(other => other.sha === item.sha).every(eligible))?.sha
  if (!sha) return { status: 'draining' }
  const releases = retained.filter(item => item.sha === sha)
  if (!releases.length || releases.some(item => !eligible(item))) throw new Error('Retained cleanup no longer matches safe releases')
  if (!record.retainedCleanup) await save({ ...record, retainedCleanup: { sha } })
  await removeBindings({ ref, releases, keepBranch: true })
  const seen = new Set()
  for (const release of releases) {
    const key = JSON.stringify(release.resources)
    if (seen.has(key)) continue
    seen.add(key)
    await deleteResources({ ref, release })
  }
  await save({ ...record, retained: record.retained.filter(item => item.sha !== sha), retainedCleanup: null })
  return { status: 'deleted' }
}
