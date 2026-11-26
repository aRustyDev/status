// The caller holds the deployment workflow concurrency group. Activation must
// accept both the previous flag value and the same already-published candidate.
export async function recoverCandidate({ ref, sha, store, readRemoteHead, activate }) {
  if (await readRemoteHead(ref) !== sha) throw new Error('Branch head changed before recovery')
  let snapshot = await store.read(ref)
  let record = snapshot?.record
  if (!record || record.retirement || record.candidate?.sha !== sha || !['ready', 'activating'].includes(record.candidate.phase)) throw new Error('Candidate is not recoverable')
  async function save(updated) {
    if (!await store.compareAndSwap(ref, snapshot.revision, updated)) throw new Error('Inventory changed concurrently')
    snapshot = { revision: snapshot.revision + 1, record: updated }
    record = updated
  }
  if (record.candidate.phase === 'ready') await save({ ...record, candidate: { ...record.candidate, phase: 'activating' } })
  if (await readRemoteHead(ref) !== sha) throw new Error('Branch head changed before recovered activation')
  await activate({ ref, sha, generation: record.candidate.generation, selector: record.selector, resources: record.candidate.resources, active: record.active, previous: record.previous })
  const active = { ...record.candidate }
  delete active.phase
  const retained = [...(record.retained || []), ...(record.previous ? [record.previous] : [])]
  await save({ ...record, previous: record.active, active, retained, candidate: null })
  return record
}
