// This wrapper is trusted controller code, not feature-branch code.
export async function withActiveBranchExecution(env, run, { leaseToken } = {}) {
  if (!env.PREVIEW_FENCE || typeof run !== 'function') return false
  const call = (path, body) => env.PREVIEW_FENCE.fetch(`https://preview-fence.internal/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  let token = leaseToken
  const inherited = token !== undefined
  if (!inherited) {
    let acquired
    try { acquired = await call('acquire', {}) } catch { return false }
    if (!acquired.ok) return false
    try { token = (await acquired.json()).token } catch { return false }
  }
  if (!/^[a-f0-9-]{36}$/.test(token || '')) return false
  try {
    const isCurrent = async () => {
      try { return (await call('check', { token })).status === 204 } catch { return false }
    }
    const claimEmail = async () => {
      try { return (await call('claim-email', { token })).status === 204 } catch { return false }
    }
    if (!await isCurrent()) return false
    await run(isCurrent, claimEmail, token)
    return true
  } finally {
    // If release cannot be confirmed, the control plane must fail closed.
    if (!inherited) {
      const response = await call('release', { token })
      if (response.status !== 204) throw new Error('Preview execution lease could not be released')
    }
  }
}
