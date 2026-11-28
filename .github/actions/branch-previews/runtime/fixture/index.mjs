// This Worker must only be deployed without routes or workers.dev and reached
// through preview-owned service bindings. All fixture data is synthetic.
const host = 'preview-fixture.invalid'
const username = 'preview-fixture-user'
const password = 'preview-fixture-password'
const token = 'preview-fixture-token'
const ticket = 'ST-preview-fixture'
const cookie = 'preview-fixture-session=fixture'

async function boundedText(request) {
  const reader = request.body?.getReader()
  if (!reader) return null
  const parts = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 8192) { await reader.cancel(); return null }
      parts.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength }
    return new TextDecoder().decode(bytes)
  } catch { return null }
}

async function boundedJson(request) {
  const value = await boundedText(request)
  try { return value === null ? null : JSON.parse(value) } catch { return null }
}

async function boundedForm(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/x-www-form-urlencoded')) return null
  const value = await boundedText(request)
  return value === null ? null : new URLSearchParams(value)
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.protocol !== 'https:' || url.hostname !== host || url.port) return new Response(null, { status: 404 })
    if (url.pathname === '/monitor' && ['GET', 'HEAD'].includes(request.method)) {
      const control = await env.DB.prepare('SELECT monitor_status FROM preview_fixture_control WHERE id=1').first()
      if (!control || !['up', 'down'].includes(control.monitor_status)) return new Response(null, { status: 503 })
      return new Response(null, { status: control.monitor_status === 'up' ? 200 : 503 })
    }
    if (['/actions/success', '/actions/failure'].includes(url.pathname) && request.method === 'POST') {
      const key = request.headers.get('idempotency-key')
      const authorization = request.headers.get('authorization') ?? ''
      if (!/^Bearer [A-Za-z0-9._~+/-]+=*$/.test(authorization) || !key || key.length > 200) return new Response(null, { status: 401 })
      const body = await boundedJson(request)
      if (!body || !['up', 'down', 'degraded'].includes(body.status) || !Number.isSafeInteger(body.scheduledAt)) return new Response(null, { status: 400 })
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
      const now = Date.now()
      await env.DB.prepare(`INSERT INTO preview_fixture_receipts (key_hash, destination, status, scheduled_at, first_seen_at, last_seen_at, attempts)
        VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT(key_hash) DO UPDATE SET attempts=preview_fixture_receipts.attempts+1, last_seen_at=excluded.last_seen_at`)
        .bind(hash, url.pathname, body.status, body.scheduledAt, now, now).run()
      return new Response(null, { status: url.pathname === '/actions/success' ? 204 : 503 })
    }
    if (url.pathname === '/oauth/token' && request.method === 'POST') {
      const data = await boundedForm(request)
      if (data?.get('grant_type') !== 'client_credentials' || data.get('client_id') !== username || data.get('client_secret') !== password) return new Response(null, { status: 401 })
      return Response.json({ access_token: token, token_type: 'Bearer' })
    }
    if (url.pathname === '/cas/v1/tickets' && request.method === 'POST') {
      const data = await boundedForm(request)
      if (data?.get('username') !== username || data.get('password') !== password) return new Response(null, { status: 401 })
      return new Response(null, { status: 201, headers: { location: `https://${host}/cas/v1/tickets/TGT-preview-fixture` } })
    }
    if (url.pathname === '/cas/v1/tickets/TGT-preview-fixture' && request.method === 'POST') {
      const data = await boundedForm(request)
      if (data?.get('service') !== `https://${host}/cas-health`) return new Response(null, { status: 400 })
      return new Response(ticket)
    }
    if (url.pathname === '/cas-health' && request.method === 'GET' && url.searchParams.get('ticket') === ticket) return new Response(null, { status: 302, headers: { location: `https://${host}/cas-health`, 'set-cookie': `${cookie}; Secure; Path=/` } })
    if (url.pathname === '/cas-health' && request.method === 'GET') return new Response('ready', { status: request.headers.get('cookie') === cookie ? 200 : 401 })
    if (url.pathname === '/oauth-health' && request.method === 'GET') return new Response('ready', { status: request.headers.get('authorization') === `Bearer ${token}` ? 200 : 401 })
    return new Response(null, { status: 404 })
  },
}
