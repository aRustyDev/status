import { branchPolicy } from './release-contract.mjs'

// Run under the same non-preemptive workflow concurrency group as deployments.
// A failed or ambiguous candidate is reported instead of being overwritten.
export async function reconcilePreviews({ branches, store, retire, recoverCandidate, ciStatus, dispatchCi, dispatchPreview }) {
  const [remote, inventory] = await Promise.all([branches.list(), store.list()])
  const records = new Map(inventory.map(({ record }) => [record.ref, record]))
  const remoteRefs = new Set(remote.map(branch => branch.ref))
  const result = { retired: [], scheduled: [], pending: [], errors: [] }

  for (const { record } of inventory) {
    if (remoteRefs.has(record.ref)) continue
    try {
      if (await branches.head(record.ref) !== null) continue
      const outcome = await retire(record.ref)
      result.retired.push({ ref: record.ref, status: outcome.status })
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
    if (record?.candidate && ['ready', 'activating'].includes(record.candidate.phase) && record.candidate.sha === sha && typeof recoverCandidate === 'function') {
      try {
        await recoverCandidate(ref, sha)
        result.scheduled.push({ ref, sha, action: 'activation-recovered' })
      } catch (error) {
        result.errors.push({ ref, message: error.message })
      }
      continue
    }
    if (record?.retirement || (record?.candidate && (record.candidate.phase !== 'preparing' || record.candidate.sha !== sha))) {
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
        await dispatchCi(ref)
        result.scheduled.push({ ref, sha, action: 'ci' })
      } else {
        result.pending.push({ ref, reason: `CI ${status}` })
      }
    } catch (error) {
      result.errors.push({ ref, message: error.message })
    }
  }
  return result
}
