// This controller-owned Worker is reachable only through a private service
// binding. Feature code never receives the provider's send_email binding.
export async function handleBranchPreviewMail(request, env, withActiveExecution) {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/send' || typeof withActiveExecution !== 'function') return new Response(null, { status: 404 })
  const { PREVIEW_MAIL_FROM: from, PREVIEW_MAIL_TO: to, PREVIEW_MAIL_PUBLIC_URL: publicUrl, EMAIL } = env
  if (typeof from !== 'string' || typeof to !== 'string' || !EMAIL || typeof EMAIL.send !== 'function') return new Response(null, { status: 503 })
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
    if (!message || typeof message !== 'object' || Array.isArray(message) || Object.keys(message).some(k => !['from','to','subject','text'].includes(k))) throw new Error()
    if (message.from !== from || message.to !== to || typeof message.text !== 'string') throw new Error()
  } catch { return new Response(null, { status: 400 }) }
  let text
  if (message.subject === 'Confirm your status subscription') {
    const prefix = `Confirm your subscription: ${origin}/#subscription=confirm&token=`
    if (!message.text.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(message.text.slice(prefix.length))) return new Response(null, { status: 400 })
    text = prefix + message.text.slice(prefix.length)
  } else if (message.subject === 'Status page update') {
    text = `A status update has been published. Visit ${origin} to view it or manage your subscription.`
    if (message.text !== text) return new Response(null, { status: 400 })
  } else return new Response(null, { status: 400 })

  let sent = false
  try {
    // A trusted scheduler can pass its existing execution capability. The
    // fence validates it; ordinary enrollment acquires its own capability.
    const inherited = request.headers.get('x-preview-execution-lease')
    await withActiveExecution(env, async (isCurrent, claimEmail) => {
      if (typeof isCurrent !== 'function' || typeof claimEmail !== 'function' || !await isCurrent() || !await claimEmail() || !await isCurrent()) return
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
