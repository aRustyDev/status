// A preview scheduler is permitted to run only for its selected, unexpired
// Flagship generation and the matching durable D1 fence. Flagship failures
// and malformed configuration fail closed.
export async function runPreviewSubscriberScheduler(env, dispatch) {
  try {
    const { PREVIEW_SLOT: slot, PREVIEW_TARGET: target, PREVIEW_SELECTOR: selector,
      PREVIEW_RELEASE: release, PREVIEW_SUBSCRIBER_SCOPE: scope, FLAGS, DB } = env
    if (!/^[1-6]$/.test(slot || '') || !['a', 'b'].includes(target) ||
        typeof selector !== 'string' || !new RegExp(`^${slot}\\.[a-f0-9]{32}$`).test(selector) ||
        !/^[a-f0-9]{40}$/.test(release || '') || !/^[a-f0-9]{64}$/.test(scope || '') || !FLAGS || !DB) return
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new globalThis.TextEncoder().encode(selector))
    if (Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('') !== scope) return
    const enabled = await FLAGS.getBooleanDetails('status-preview-enabled', false)
    if (enabled.errorCode || !enabled.value) return
    const result = await FLAGS.getObjectDetails(`status-preview-slot-${slot}`, {})
    const route = result.value
    if (result.errorCode || !route || route.selector !== selector || route.target !== target ||
        route.release !== release || route.subscriberScheduler !== true ||
        !Number.isSafeInteger(route.expiresAt) || route.expiresAt <= Date.now()) return
    const fence = await DB.prepare('SELECT 1 FROM preview_subscriber_leases WHERE scope=? AND slot=? AND target=? AND release=? AND expires_at>?')
      .bind(scope, Number(slot), target, release, Date.now()).first()
    if (!fence) return
  } catch {
    return
  }
  // Dispatcher rechecks the fence atomically when it mutates and claims jobs.
  await dispatch(env)
}
