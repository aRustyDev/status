// A preview scheduler is permitted to run only for its selected, unexpired
// Flagship generation and the matching durable D1 fence. Flagship failures
// and malformed configuration fail closed.
export async function runPreviewSubscriberScheduler(env, dispatch) {
  const { PREVIEW_SLOT: slot, PREVIEW_TARGET: target, PREVIEW_SELECTOR: selector,
    PREVIEW_RELEASE: release, PREVIEW_SUBSCRIBER_SCOPE: scope, FLAGS, DB } = env
  const authorize = async () => {
    try {
      if (!/^[1-6]$/.test(slot || '') || !['a', 'b'].includes(target) ||
          typeof selector !== 'string' || !new RegExp(`^${slot}\\.[a-f0-9]{32}$`).test(selector) ||
          !/^[a-f0-9]{40}$/.test(release || '') || !/^[a-f0-9]{64}$/.test(scope || '') || !FLAGS || !DB) return false
      const digest = await globalThis.crypto.subtle.digest('SHA-256', new globalThis.TextEncoder().encode(selector))
      if (Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('') !== scope) return false
      const enabled = await FLAGS.getBooleanDetails('status-preview-enabled', false)
      if (enabled.errorCode || enabled.value !== true) return false
      const result = await FLAGS.getObjectDetails(`status-preview-slot-${slot}`, {})
      const route = result.value
      if (result.errorCode || !route || route.selector !== selector || route.target !== target ||
          route.release !== release || route.subscriberScheduler !== true ||
          !Number.isSafeInteger(route.expiresAt) || route.expiresAt <= Date.now()) return false
      const fence = await DB.prepare('SELECT expires_at FROM preview_subscriber_leases WHERE scope=? AND slot=? AND target=? AND release=? AND expires_at>?')
        .bind(scope, Number(slot), target, release, Date.now()).first()
      return !!fence && Number.isSafeInteger(fence.expires_at) && fence.expires_at > Date.now() && route.expiresAt > Date.now()
    } catch {
      return false
    }
  }
  if (!await authorize()) return
  // Dispatcher performs atomic D1 fencing for mutations and reauthorizes each send.
  await dispatch(env, authorize)
}
