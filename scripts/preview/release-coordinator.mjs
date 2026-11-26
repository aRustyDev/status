import { newRelease, nextGeneration, validateInventory } from './release-contract.mjs'

// All callers must hold the same external, non-preemptive deployment lock for the
// entire operation, including calls to Cloudflare. D1 CAS protects inventory only.
// An interrupted activation is deliberately left for explicit reconciliation.
export async function deployRelease({ ref, sha, store, readRemoteHead, prepare, activate }) {
  if (await readRemoteHead(ref) !== sha) throw new Error('Branch head changed before deployment')
  let snapshot = await store.read(ref)
  if (!snapshot) {
    const record = newRelease({ ref, sha })
    if (!await store.create(record)) throw new Error('Inventory changed concurrently')
    snapshot = await store.read(ref)
    if (!snapshot) throw new Error('Created inventory is unavailable')
  }
  if (snapshot.record.retirement) throw new Error('Retirement requires reconciliation before deployment')
  if (snapshot.record.abandonedCleanup) throw new Error('Abandoned resource cleanup requires reconciliation before deployment')
  const candidate = snapshot.record.candidate
  if (candidate && (candidate.sha !== sha || candidate.phase !== 'preparing')) throw new Error('Candidate requires reconciliation before deployment')
  let record = candidate ? snapshot.record : nextGeneration(snapshot.record, sha)
  const generation = record.generation
  if (!candidate) record = { ...record, candidate: { sha, generation, phase: 'preparing', resources: {} } }
  async function save(updated) {
    validateInventory(updated)
    if (!await store.compareAndSwap(ref, snapshot.revision, updated)) throw new Error('Inventory changed concurrently')
    snapshot = { revision: snapshot.revision + 1, record: updated }
    record = updated
  }
  if (!candidate) await save(record)
  async function recordResources(resources) {
    if (!resources || typeof resources !== 'object' || Array.isArray(resources)) throw new Error('Invalid candidate resources')
    await save({ ...record, candidate: { ...record.candidate, resources: { ...record.candidate.resources, ...resources } } })
  }
  const resources = await prepare({ ref, sha, generation, recordResources, recordedResources: record.candidate.resources })
  await recordResources(resources)
  await save({ ...record, candidate: { ...record.candidate, phase: 'ready' } })
  if (await readRemoteHead(ref) !== sha) throw new Error('Branch head changed before activation')
  // Save intent before the remote write. A timeout could still mean the write
  // succeeded, so no automatic retry or cleanup is safe on ambiguous failure.
  await save({ ...record, candidate: { ...record.candidate, phase: 'activating' } })
  await activate({ ref, sha, generation, selector: record.selector, resources: record.candidate.resources, active: record.active, previous: record.previous })
  const active = { ...record.candidate }
  delete active.phase
  const retained = [...(record.retained || []), ...(record.previous ? [record.previous] : [])]
  await save({ ...record, previous: record.active, active, candidate: null, retained })
  return record
}
