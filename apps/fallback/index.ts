import { createRemoteJWKSet, jwtVerify } from 'jose'

interface Env {
  GATEWAY: Fetcher
  ASSETS: Fetcher
  FALLBACK_BUCKET: R2Bucket
  ACCESS_TEAM_DOMAIN: string
  ACCESS_AUD: string
}

type SavedCopy = { enabled: boolean; snapshot: { schemaVersion: number; generatedAt: number } | null }
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>()
const prefix = '/__fallback/'
const unavailable = () => new Response('Status page unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } })

async function authorized(request: Request, env: Env): Promise<boolean> {
  const token = request.headers.get('Cf-Access-Jwt-Assertion')
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return false
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '')}`
  try {
    let keys = keySets.get(issuer)
    if (!keys) {
      keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`))
      keySets.set(issuer, keys)
    }
    const { payload } = await jwtVerify(token, keys, { issuer, audience: env.ACCESS_AUD })
    return typeof payload.sub === 'string' && typeof payload.email === 'string' && payload.email.length > 0
  } catch {
    return false
  }
}

async function savedCopy(env: Env): Promise<SavedCopy | null> {
  try {
    const object = await env.FALLBACK_BUCKET.get('fallback/current.json')
    if (!object) return null
    const value = await object.json<SavedCopy>()
    if (!value.enabled || value.snapshot?.schemaVersion !== 1 || typeof value.snapshot.generatedAt !== 'number') return null
    return value
  } catch {
    return null
  }
}

async function protectedCopy(request: Request, env: Env, path: string): Promise<Response> {
  if (!await authorized(request, env)) return new Response('Access authentication required', { status: 401, headers: { 'Cache-Control': 'no-store' } })
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 })
  const copy = await savedCopy(env)
  if (!copy) return unavailable()
  if (path === `${prefix}snapshot.json`) return Response.json(copy.snapshot, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })

  const url = new URL(request.url)
  url.pathname = path === '/' ? '/' : path.slice(prefix.length - 1)
  const asset = await env.ASSETS.fetch(new Request(url, { method: request.method, headers: request.headers }))
  if (!asset.ok) return asset
  const headers = new Headers(asset.headers)
  headers.set('Cache-Control', 'no-store')
  headers.set('X-Content-Type-Options', 'nosniff')
  if (path !== '/') return new Response(asset.body, { status: asset.status, headers })
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
  const html = await asset.text()
  if (!html.includes('</head>')) return unavailable()
  headers.delete('content-length')
  return new Response(html.replace('</head>', `<meta name="bsp-snapshot" content="${prefix}snapshot.json" /></head>`), { headers })
}

async function withDeadline(fetcher: Fetcher, request: Request): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const timeout = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('Gateway timed out')), { once: true })
    })
    return await Promise.race([fetcher.fetch(new Request(request, { signal: controller.signal })), timeout])
  } finally {
    clearTimeout(timer)
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Preview requests must never fall back to the shared environment snapshot.
    // Forward even empty or invalid selectors so the gateway can reject them.
    if (request.headers.has('X-Status-Preview')) return env.GATEWAY.fetch(request)
    const url = new URL(request.url)
    if (url.pathname.startsWith(prefix)) return protectedCopy(request, env, url.pathname)
    if (request.method !== 'GET' || url.pathname !== '/' || !request.headers.get('accept')?.includes('text/html')) return env.GATEWAY.fetch(request)

    let live: Response | undefined
    try {
      live = await withDeadline(env.GATEWAY, request)
      if (live.status < 500) {
        if (!live.ok) return live
        const statusUrl = new URL('/api/v1/bsp/public/status', url)
        const status = await withDeadline(env.GATEWAY, new Request(statusUrl, { headers: request.headers }))
        if (status.status < 500) return status.ok ? live : status
      }
    } catch {
      // The independently stored copy is available when the primary service times out or throws.
    }
    return protectedCopy(request, env, '/')
  },
}
