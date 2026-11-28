import { branchPolicy } from './release-contract.mjs'

// Run under the same non-preemptive workflow concurrency group as deployments.
// A failed or ambiguous candidate is reported instead of being overwritten.
export async function reconcilePreviews({ branches, store, retire, recoverCandidate, cleanupAbandoned, cleanupDeletedAbandoned, cleanupRetained, revokeAmbiguousSubscribers, drainAmbiguousExecution, ciStatus, dispatchCi, dispatchPreview, now = Date.now }) {
  const [remote, initialInventory] = await Promise.all([branches.list(), store.list()])
  let inventory = initialInventory
  const result = { retired: [], scheduled: [], pending: [], errors: [] }
  if (typeof cleanupAbandoned === 'function') {
    for (const { record } of inventory) {
      try {
        const outcome = await cleanupAbandoned(record.ref)
        if (outcome?.status === 'unresolved') result.pending.push({ ref: record.ref, reason: 'database creation intent has no recorded identity' })
      } catch (error) { result.errors.push({ ref: record.ref, message: error.message }) }
    }
    inventory = await store.list()
  }
  if (typeof cleanupRetained === 'function') {
    for (const { record } of inventory) {
      try { await cleanupRetained(record.ref) } catch (error) { result.errors.push({ ref: record.ref, message: error.message }) }
    }
    inventory = await store.list()
  }
  const records = new Map(inventory.map(({ record }) => [record.ref, record]))
  const remoteRefs = new Set(remote.map(branch => branch.ref))

  for (const snapshot of inventory) {
    const { record } = snapshot
    if (remoteRefs.has(record.ref)) continue
    try {
      if (await branches.head(record.ref) !== null) continue
      if (record.candidate && ['preparing', 'ready'].includes(record.candidate.phase)) {
        const updated = { ...record, candidate: null, abandoned: [...(record.abandoned || []), { ...record.candidate, abandonedAt: now() }] }
        if (await branches.head(record.ref) !== null || !await store.compareAndSwap(record.ref, snapshot.revision, updated)) throw new Error('Branch or inventory changed during candidate abandonment')
      } else if (record.candidate?.phase === 'activating') {
        // The candidate flag write may have succeeded before an interruption.
        // Revoke both possible senders while leaving routing for reconciliation.
        const releases = [record.active, record.previous, ...(record.retained || []), record.candidate].filter(Boolean)
        const errors = []
        if (releases.some(release => release.resources?.workers?.fence)) {
          try {
            if (typeof drainAmbiguousExecution !== 'function') throw new Error('Execution fence drain requires operator reconciliation')
            if (await branches.head(record.ref) !== null) throw new Error('Branch was recreated before execution fence drain')
            // Preserve the release identity and route for operator recovery. A
            // draining fence blocks new execution and waits for existing leases.
            await drainAmbiguousExecution(record, releases)
          } catch (error) { errors.push(error.message) }
        }
        if (releases.some(release => release.resources?.workers?.subscriber)) {
          try {
            if (typeof revokeAmbiguousSubscribers !== 'function') throw new Error('Subscriber fence revocation requires operator reconciliation')
            if (await branches.head(record.ref) !== null) throw new Error('Branch was recreated before subscriber revocation')
            await revokeAmbiguousSubscribers(record, releases)
          } catch (error) { errors.push(error.message) }
        }
        if (errors.length) throw new Error(errors.join('; '))
        throw new Error('Deleted branch activation requires operator reconciliation')
      }
      const outcome = await retire(record.ref)
      result.retired.push({ ref: record.ref, status: outcome.status })
      if (outcome.status === 'deleted' && typeof cleanupDeletedAbandoned === 'function') {
        const cleanup = await cleanupDeletedAbandoned(record.ref)
        if (cleanup?.status === 'unresolved') result.pending.push({ ref: record.ref, reason: 'database creation intent has no recorded identity' })
      }
    } catch (error) {
      result.errors.push({ ref: record.ref, message: error.message })
    }
  }

  for (const { ref, sha } of remote) {
    if (!branchPolicy(ref) || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid remote branch list')
    let record = records.get(ref)
    if (record?.retirement?.phase === 'deleted') {
      const snapshot = inventory.find(item => item.record.ref === ref)
      if (await branches.head(ref) !== sha || !await store.compareAndSwap(ref, snapshot.revision, { ...record, retirement: null })) {
        result.pending.push({ ref, reason: 'recreated branch changed during recovery' })
        continue
      }
      record = { ...record, retirement: null }
    }
    if (record?.candidate && record.candidate.sha !== sha && ['preparing', 'ready'].includes(record.candidate.phase)) {
      // Neither phase can have issued a Flagship write. Keep all recorded
      // resources for later cleanup while freeing the branch for its new SHA.
      const snapshot = inventory.find(item => item.record.ref === ref)
      const updated = { ...record, candidate: null, abandoned: [...(record.abandoned || []), { ...record.candidate, abandonedAt: now() }] }
      if (await branches.head(ref) !== sha || !await store.compareAndSwap(ref, snapshot.revision, updated)) {
        result.pending.push({ ref, reason: 'branch changed during candidate abandonment' })
        continue
      }
      record = updated
    }
    if (record?.candidate?.phase === 'activating' && record.candidate.sha !== sha && typeof recoverCandidate === 'function') {
      try {
        await recoverCandidate(ref, record.candidate.sha, { allowStaleIfPublished: true })
        result.scheduled.push({ ref, sha: record.candidate.sha, action: 'published-activation-recovered' })
      } catch (error) {
        result.pending.push({ ref, reason: error.message })
      }
      continue
    }
    if (record?.candidate && ['ready', 'activating'].includes(record.candidate.phase) && record.candidate.sha === sha && typeof recoverCandidate === 'function') {
      try {
        await recoverCandidate(ref, sha)
        result.scheduled.push({ ref, sha, action: 'activation-recovered' })
      } catch (error) {
        result.errors.push({ ref, message: error.message })
      }
      continue
    }
    if (record?.retirement || record?.abandonedCleanup || record?.retainedCleanup || (record?.candidate && (record.candidate.phase !== 'preparing' || record.candidate.sha !== sha))) {
      result.pending.push({ ref, reason: 'release or retirement needs reconciliation' })
      continue
    }
    if (!record?.candidate && record?.active?.sha === sha) continue
    try {
      if (await branches.head(ref) !== sha) continue
      const status = await ciStatus(ref, sha)
      if (status === 'success') {
        await dispatchPreview(ref, sha)
        result.scheduled.push({ ref, sha, action: 'preview' })
      } else if (status === 'missing') {
        if (await dispatchCi(ref) === false) result.pending.push({ ref, reason: 'Waiting for source repository CI' })
        else result.scheduled.push({ ref, sha, action: 'ci' })
      } else {
        result.pending.push({ ref, reason: `CI ${status}` })
      }
    } catch (error) {
      result.errors.push({ ref, message: error.message })
    }
  }
  return result
}
