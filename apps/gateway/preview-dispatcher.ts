import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'

interface Env {
  FLAGS: Flagship
  PREVIEW_VERIFY_SECRET?: string
  ACCESS_TEAM_DOMAIN?: string
  ACCESS_AUD?: string
  PREVIEW_SERVICE_TOKEN_ID?: string
  [binding: `PREVIEW_BRANCH_${string}`]: Fetcher
}

interface BranchRoute {
  selector?: string
  release?: string
}

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

export async function verifyServiceToken(request: Request, env: Env, keys?: JWTVerifyGetKey): Promise<boolean> {
  const token = request.headers.get('Cf-Access-Jwt-Assertion')
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.PREVIEW_SERVICE_TOKEN_ID) return false
  const domain = env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '')
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(domain)) return false
  const issuer = `https://${domain}`
  if (!keys) {
    if (!keySets.has(issuer)) keySets.set(issuer, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)))
    keys = keySets.get(issuer)!
  }
  try {
    const { payload } = await jwtVerify(token, keys, { issuer, audience: env.ACCESS_AUD, algorithms: ['RS256'] })
    return payload.common_name === env.PREVIEW_SERVICE_TOKEN_ID
  } catch { return false }
}

async function verifyCandidate(request: Request, selector: string, secret: string | undefined): Promise<{ release: string, mode: string } | undefined> {
  const value = request.headers.get('X-Status-Preview-Verify')
  const match = /^([0-9a-f]{40})\.([0-9]{13})\.(candidate|active)\.([0-9a-f]{64})$/.exec(value || '')
  if (!match || !secret || secret.length < 32 || request.method !== 'GET' || new URL(request.url).pathname !== '/__preview/verify') return undefined
  if (Math.abs(Date.now() - Number(match[2])) > 60_000) return undefined
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  const signature = Uint8Array.from(match[4].match(/../g)!, byte => Number.parseInt(byte, 16))
  const message = encoder.encode(`${selector}\n${match[1]}\n${match[2]}\n${match[3]}\nGET\n/__preview/verify`)
  return await crypto.subtle.verify('HMAC', key, signature, message) ? { release: match[1], mode: match[3] } : undefined
}

function uncached(response: Response, release?: string): Response {
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', 'no-store')
  if (release) headers.set('X-Status-Preview-Commit', release)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

// Private service: the baseline gateway authenticates the caller before invoking it.
export function createDispatcher(authenticate = verifyServiceToken) { return {
  async fetch(request: Request, env: Env): Promise<Response> {
    const selector = request.headers.get('X-Status-Preview') || ''
    const match = /^branch-([0-9a-f]{24})$/.exec(selector)
    if (!match) return uncached(new Response('Invalid preview selector', { status: 400 }))
    try {
      if (request.headers.has('X-Status-Preview-Verify')) {
        const proof = await verifyCandidate(request, selector, env.PREVIEW_VERIFY_SECRET)
        if (!proof || !await authenticate(request, env)) return uncached(new Response('Preview verification denied', { status: 403 }))
        const { release, mode } = proof
        if (mode === 'active') {
          const enabled = await env.FLAGS.getBooleanDetails('status-preview-enabled', false)
          const details = await env.FLAGS.getObjectDetails<BranchRoute>(`status-preview-branch-${match[1]}`, {})
          if (enabled.errorCode || !enabled.value || details.errorCode || details.value.selector !== selector || details.value.release !== release) return uncached(new Response('Preview routing unavailable', { status: 503 }))
        }
        const candidate = env[`PREVIEW_BRANCH_${match[1].toUpperCase()}_${release.toUpperCase()}`]
        if (!candidate) return uncached(new Response('Preview routing unavailable', { status: 503 }))
        const headers = new Headers({ 'X-Status-Preview': selector, 'X-Status-Preview-Release': release, 'X-Status-Preview-Probe': '1' })
        const response = await candidate.fetch(new Request(request.url, { method: 'GET', headers }))
        if (response.status !== 204) return uncached(new Response('Preview verification failed', { status: 503 }))
        return uncached(new Response(null, { status: 204 }), release)
      }
      if (new URL(request.url).pathname === '/__preview/verify') return uncached(new Response('Preview verification denied', { status: 403 }))
      const enabled = await env.FLAGS.getBooleanDetails('status-preview-enabled', false)
      if (enabled.errorCode || !enabled.value) return uncached(new Response('Preview routing unavailable', { status: 503 }))
      const details = await env.FLAGS.getObjectDetails<BranchRoute>(`status-preview-branch-${match[1]}`, {})
      if (details.errorCode === 'FLAG_NOT_FOUND') return uncached(new Response('Preview not found', { status: 404 }))
      if (details.errorCode) return uncached(new Response('Preview routing unavailable', { status: 503 }))
      const route = details.value
      if (route.selector !== selector) return uncached(new Response('Preview not found', { status: 404 }))
      if (!route.release || !/^[0-9a-f]{40}$/.test(route.release)) {
        return uncached(new Response('Preview routing unavailable', { status: 503 }))
      }
      const binding = env[`PREVIEW_BRANCH_${match[1].toUpperCase()}_${route.release.toUpperCase()}`]
      if (!binding) return uncached(new Response('Preview routing unavailable', { status: 503 }))
      const headers = new Headers(request.headers)
      headers.set('X-Status-Preview-Release', route.release)
      return uncached(await binding.fetch(new Request(request, { headers })), route.release)
    } catch {
      return uncached(new Response('Preview routing unavailable', { status: 503 }))
    }
  },
} }

export default createDispatcher()
