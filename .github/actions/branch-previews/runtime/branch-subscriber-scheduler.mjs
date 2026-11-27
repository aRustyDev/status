// Trusted schema-preview wrapper: fail closed on every send when the selected
// branch route or the release-local durable fence is unavailable or stale.
export function createBranchSubscriberAuthorization(env) {
  const { PREVIEW_SELECTOR: selector, PREVIEW_RELEASE: release, PREVIEW_SUBSCRIBER_SCOPE: scope, FLAGS, DB } = env
  return async () => {
    try {
      if (env.PREVIEW_BRANCH_MODE !== 'schema' || !/^branch-[a-f0-9]{24}$/.test(selector || '') ||
          !/^[a-f0-9]{40}$/.test(release || '') || !/^[a-f0-9]{64}$/.test(scope || '') || !FLAGS || !DB) return false
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(selector))
      if (Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('') !== scope) return false
      const global = await FLAGS.getBooleanDetails('status-preview-enabled', false)
      if (global.errorCode || global.value !== true) return false
      const result = await FLAGS.getObjectDetails(`status-preview-branch-${selector.slice(7)}`, {})
      if (result.errorCode || result.value?.selector !== selector || result.value?.release !== release) return false
      const now = Date.now()
      const row = await DB.prepare("SELECT expires_at FROM preview_subscriber_leases WHERE scope=? AND slot=1 AND target='a' AND release=? AND expires_at>?")
        .bind(scope, release, now).first()
      return !!row && Number.isSafeInteger(row.expires_at) && row.expires_at > Date.now()
    } catch { return false }
  }
}

export async function runBranchSubscriberScheduler(env, dispatch) {
  const authorize = createBranchSubscriberAuthorization(env)
  if (!await authorize()) return
  await dispatch(env, authorize)
}
