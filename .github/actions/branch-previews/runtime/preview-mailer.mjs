// This controller-owned Worker is reachable only through a private service
// binding. Feature code never receives the provider's send_email binding.
export async function handleBranchPreviewMail(request, env, withActiveExecution) {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/send' || typeof withActiveExecution !== 'function') return new Response(null, { status: 404 })
  const { PREVIEW_MAIL_FROM: from, PREVIEW_MAIL_TO: to, PREVIEW_MAIL_PUBLIC_URL: publicUrl, PREVIEW_SELECTOR: selector, PREVIEW_RELEASE: release, PREVIEW_SUBSCRIBER_SCOPE: scope, DB, EMAIL } = env
  if (typeof from !== 'string' || typeof to !== 'string' || !EMAIL || typeof EMAIL.send !== 'function' || !DB || env.PREVIEW_DATABASE_ISOLATED !== 'true' || !/^branch-[a-f0-9]{24}$/.test(selector || '') || !/^[a-f0-9]{40}$/.test(release || '') || !/^[a-f0-9]{64}$/.test(scope || '')) return new Response(null, { status: 503 })
  const fixtureExpiresAt = Number(env.PREVIEW_FIXTURE_EXPIRES_AT)
  if (!Number.isSafeInteger(fixtureExpiresAt) || fixtureExpiresAt <= Date.now()) return new Response(null, { status: 503 })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(selector))
  if ([...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('') !== scope) return new Response(null, { status: 503 })
  let origin
  try {
    const u = new URL(publicUrl)
    if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error()
    origin = u.origin
  } catch { return new Response(null, { status: 503 }) }
  let message
  try {
    const length = request.headers.get('content-length')
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > 2048)) throw new Error()
    if (!request.body) throw new Error()
    const reader = request.body.getReader()
    const chunks = []
    let size = 0
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 2048) { void reader.cancel().catch(() => {}); throw new Error() }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!message || typeof message !== 'object' || Array.isArray(message) || Object.keys(message).some(k => !['from','to','subject','text','previewDelivery','previewConfirmation'].includes(k))) throw new Error()
    if (message.from !== from || message.to !== to || typeof message.text !== 'string') throw new Error()
  } catch { return new Response(null, { status: 400 }) }
  let text, reservationKind, reservationKey, validationSql, validationArgs
  const nowSql = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)"
  if (message.subject === 'Confirm your status subscription') {
    const prefix = `Confirm your subscription: ${origin}/#subscription=confirm&token=`
    if (!message.text.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(message.text.slice(prefix.length))) return new Response(null, { status: 400 })
    const confirmation = message.previewConfirmation
    if (message.previewDelivery !== undefined || !confirmation || typeof confirmation !== 'object' || Array.isArray(confirmation) || Object.keys(confirmation).sort().join(',') !== 'scope,userId' || confirmation.scope !== scope || typeof confirmation.userId !== 'string' || confirmation.userId.length < 1 || confirmation.userId.length > 256) return new Response(null, { status: 400 })
    const token = message.text.slice(prefix.length)
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
    reservationKind = 'confirmation'
    reservationKey = [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, '0')).join('')
    validationSql = `SELECT l.expires_at AS lease_expires_at,s.confirmation_expires_at AS item_expires_at FROM preview_subscriber_leases l JOIN preview_subscribers s ON s.scope=l.scope JOIN users u ON u.id=s.user_id JOIN preview_subscription_settings cfg ON cfg.scope=s.scope
      WHERE l.scope=? AND l.slot=1 AND l.target='a' AND l.release=? AND l.expires_at>${nowSql} AND s.user_id=? AND s.status='pending' AND s.confirmation_hash=? AND s.confirmation_expires_at>${nowSql} AND lower(s.email)=lower(u.email) AND lower(s.email)=lower(?) AND cfg.enabled=1 AND cfg.allow_email=1`
    validationArgs = [scope, release, confirmation.userId, reservationKey, to]
    text = prefix + token
  } else if (message.subject === 'Status page update') {
    text = `A status update has been published. Visit ${origin} to view it or manage your subscription.`
    if (message.text !== text) return new Response(null, { status: 400 })
    const delivery = message.previewDelivery
    if (message.previewConfirmation !== undefined || !delivery || typeof delivery !== 'object' || Array.isArray(delivery) || Object.keys(delivery).sort().join(',') !== 'id,leaseToken,scope' || delivery.scope !== scope || typeof delivery.id !== 'string' || delivery.id.length < 1 || delivery.id.length > 256 || typeof delivery.leaseToken !== 'string' || delivery.leaseToken.length < 1 || delivery.leaseToken.length > 256) return new Response(null, { status: 400 })
    reservationKind = 'delivery'
    reservationKey = delivery.id
    validationSql = `SELECT l.expires_at AS lease_expires_at,d.lease_until AS item_expires_at FROM preview_subscriber_deliveries d JOIN preview_subscribers s ON s.id=d.subscriber_id AND s.scope=d.scope JOIN users u ON u.id=s.user_id JOIN preview_subscription_settings cfg ON cfg.scope=d.scope JOIN preview_subscriber_leases l ON l.scope=d.scope AND l.slot=1 AND l.target='a' AND l.release=?
      WHERE d.scope=? AND d.id=? AND d.state='sending' AND d.lease_token=? AND d.lease_until>${nowSql} AND l.expires_at>${nowSql} AND s.status='active' AND cfg.enabled=1 AND cfg.allow_email=1 AND lower(s.email)=lower(u.email) AND lower(s.email)=lower(?) AND d.created_at>=cfg.updated_at AND d.created_at>=s.updated_at
      AND EXISTS (SELECT 1 FROM json_each(cfg.allowed_events) WHERE value=d.event_type) AND EXISTS (SELECT 1 FROM json_each(s.events) WHERE value=d.event_type)
      AND (json_array_length(d.component_ids)=0 OR json_array_length(s.monitor_ids)=0 OR EXISTS (SELECT 1 FROM json_each(s.monitor_ids) m JOIN json_each(d.component_ids) c ON m.value=c.value))`
    validationArgs = [release, scope, delivery.id, delivery.leaseToken, to]
  } else return new Response(null, { status: 400 })

  let sent = false
  try {
    // A trusted scheduler can pass its existing execution capability. The
    // fence validates it; ordinary enrollment acquires its own capability.
    const inherited = request.headers.get('x-preview-execution-lease')
    await withActiveExecution(env, async (isCurrent, claimEmail, _token, claimReservation) => {
      if (typeof isCurrent !== 'function' || typeof claimEmail !== 'function' || typeof claimReservation !== 'function' || !await isCurrent() || !await claimEmail() || !await isCurrent()) return
      // Reservations live in the trusted control database, inaccessible to
      // feature code. A failed or ambiguous attempt stays consumed forever.
      if (!await claimReservation(reservationKind,reservationKey) || !await isCurrent()) return
      // This is the final awaited operation before the provider invocation.
      // The held central lease prevents another release activating meanwhile.
      const eligible = await DB.prepare(validationSql).bind(...validationArgs).first()
      const checkedAt = Date.now()
      if (!eligible || !Number.isSafeInteger(eligible.lease_expires_at) || eligible.lease_expires_at <= checkedAt || !Number.isSafeInteger(eligible.item_expires_at) || eligible.item_expires_at <= checkedAt || fixtureExpiresAt <= checkedAt) return
      await EMAIL.send({ from, to, subject: message.subject, text })
      sent = true
    }, inherited ? { leaseToken: inherited } : undefined)
  } catch { return new Response(null, { status: 503 }) }
  return new Response(null, { status: sent ? 204 : 503 })
}

// Inject this narrowly scoped adapter into an individual feature request.
export function branchPreviewEmailProxy(service, leaseToken) {
  return { async send(message) {
    if (!service || typeof service.fetch !== 'function') throw new Error('Preview mailer unavailable')
    const headers = { 'content-type': 'application/json' }
    if (leaseToken) headers['x-preview-execution-lease'] = leaseToken
    const response = await service.fetch('https://preview-mailer.invalid/send', {
      method: 'POST', headers, body: JSON.stringify(message),
    })
    if (response.status !== 204) throw new Error('Preview mail delivery unavailable')
  } }
}
