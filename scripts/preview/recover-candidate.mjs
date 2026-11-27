// The caller holds the deployment workflow concurrency group. Activation must
// accept both the previous flag value and the same already-published candidate.
export async function recoverCandidate({ ref, sha, store, readRemoteHead, activate, allowStaleIfPublished = false, isPublishedCandidate, now = Date.now }) {
  const head = await readRemoteHead(ref)
  const stale = head !== sha
  if (stale && (!allowStaleIfPublished || head === null || typeof isPublishedCandidate !== 'function')) throw new Error('Branch head changed before recovery')
  let snapshot = await store.read(ref)
  let record = snapshot?.record
  if (!record || record.retirement || record.candidate?.sha !== sha || !['ready', 'activating'].includes(record.candidate.phase)) throw new Error('Candidate is not recoverable')
  if (stale && (record.candidate.phase !== 'activating' || !await isPublishedCandidate({ ref, sha, selector: record.selector }))) throw new Error('Outdated activation is not confirmed published')
  async function save(updated) {
    if (!await store.compareAndSwap(ref, snapshot.revision, updated)) throw new Error('Inventory changed concurrently')
    snapshot = { revision: snapshot.revision + 1, record: updated }
    record = updated
  }
  if (record.candidate.phase === 'ready') await save({ ...record, candidate: { ...record.candidate, phase: 'activating' } })
  if (await readRemoteHead(ref) !== head) throw new Error('Branch head changed before recovered activation')
  await activate({ ref, sha, generation: record.candidate.generation, selector: record.selector, resources: record.candidate.resources, active: record.active, previous: record.previous })
  const active = { ...record.candidate }
  delete active.phase
  const retained = [...(record.retained || []), ...(record.previous ? [{ ...record.previous, retainedAt: now() }] : [])]
  await save({ ...record, previous: record.active, active, retained, candidate: null })
  return record
}
