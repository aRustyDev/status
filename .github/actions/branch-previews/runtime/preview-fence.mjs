// Trusted per-release service. Only this Worker receives the control DB binding;
// preview code can call its private service binding but cannot choose an identity.
function identity(env) {
  const selector = env.PREVIEW_SELECTOR
  const release = env.PREVIEW_RELEASE
  if (!/^branch-[a-f0-9]{24}$/.test(selector || '') || !/^[a-f0-9]{40}$/.test(release || '') || !/^[a-z0-9-]+-preview-$/.test(env.PREVIEW_FLAG_PREFIX || '') || !env.INVENTORY || !env.FLAGS) return null
  return { selector, release }
}

async function flagshipActive(env, { selector, release }) {
  const enabled = await env.FLAGS.getBooleanDetails(`${env.PREVIEW_FLAG_PREFIX}enabled`, false)
  const route = await env.FLAGS.getObjectDetails(`${env.PREVIEW_FLAG_PREFIX}branch-${selector.slice(7)}`, {})
  return !enabled.errorCode && enabled.value === true && !route.errorCode && route.value?.selector === selector && route.value?.release === release
}

async function current(env, id, token) {
  if (!/^[a-f0-9-]{36}$/.test(token || '') || !await flagshipActive(env, id)) return false
  return !!await env.INVENTORY.prepare(`SELECT f.selector FROM preview_execution_fences f
    JOIN preview_execution_leases l ON l.selector=f.selector AND l.release=f.active_release
    WHERE f.selector=? AND f.active_release=? AND f.state='active' AND l.lease_id=?`)
    .bind(id.selector, id.release, token).first()
}

async function readSmallJson(request) {
  const length = request.headers.get('content-length')
  if (length && (!/^\d+$/.test(length) || Number(length) > 256)) return null
  if (!request.body) return null
  const reader = request.body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > 256) { await reader.cancel(); return null }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal:true }).decode(bytes)) } catch { return null }
}

export default {
  async fetch(request, env) {
    const id = identity(env)
    if (!id || request.method !== 'POST') return new Response(null, { status: 403 })
    const path = new URL(request.url).pathname
    try {
      if (path === '/acquire') {
        if (!await flagshipActive(env, id)) return new Response(null, { status: 409 })
        const token = crypto.randomUUID()
        // No expiry or automatic takeover: if a Worker dies while holding the
        // lease, activation must remain blocked until an operator recovers it.
        const row = await env.INVENTORY.prepare(`INSERT INTO preview_execution_leases (lease_id,selector,release)
          SELECT ?,selector,active_release FROM preview_execution_fences
          WHERE selector=? AND active_release=? AND state='active' RETURNING lease_id`)
          .bind(token, id.selector, id.release).first()
        if (!row) return new Response(null, { status: 409 })
        return Response.json({ token })
      }
      if (!['/check', '/release', '/claim-email'].includes(path)) return new Response(null, { status: 404 })
      const body = await readSmallJson(request)
      if (!body || !/^[a-f0-9-]{36}$/.test(body.token || '')) return new Response(null, { status: 400 })
      if (path === '/release') {
        const row = await env.INVENTORY.prepare(`DELETE FROM preview_execution_leases
          WHERE selector=? AND release=? AND lease_id=? RETURNING selector`)
          .bind(id.selector, id.release, body.token).first()
        return new Response(null, { status: row ? 204 : 409 })
      }
      if (!await current(env, id, body.token)) return new Response(null, { status: 409 })
      if (path === '/check') return new Response(null, { status: 204 })
      const now = Date.now()
      const row = await env.INVENTORY.prepare(`INSERT INTO preview_email_quota (selector, sent_at)
        SELECT ?, ? WHERE (SELECT count(*) FROM preview_email_quota WHERE selector=? AND sent_at>?) < 4
        AND EXISTS (SELECT 1 FROM preview_execution_fences f JOIN preview_execution_leases l ON l.selector=f.selector AND l.release=f.active_release
          WHERE f.selector=? AND f.active_release=? AND f.state='active' AND l.lease_id=?)
        RETURNING selector`)
        .bind(id.selector, now, id.selector, now-3600000, id.selector, id.release, body.token).first()
      return new Response(null, { status: row ? 204 : 429 })
    } catch {
      return new Response(null, { status: 503 })
    }
  },
}
