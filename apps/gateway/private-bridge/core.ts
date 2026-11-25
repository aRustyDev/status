import { createRemoteJWKSet, customFetch, jwksCache, jwtVerify, type JWTPayload } from 'jose'
import type { GatewayMiddlewareContext, GatewayMiddlewareNext } from '@cloudflare/zt-types'

export interface ForwardEnv {
  PRIVATE_ORIGIN: string
  ACCESS_TEAM_DOMAIN: string
  ACCESS_AUD: string
  FALLBACK: { fetch(request: Request): Promise<Response> }
}
export type GatewayContext = Pick<GatewayMiddlewareContext, 'identity'>
export type Continuation = GatewayMiddlewareNext
type Verify = (token: string, issuer: string, audience: string, signal: AbortSignal) => Promise<JWTPayload>
const keyCaches = new Map<string, Record<string, never>>()
const hop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
const error = (status: number) => Response.json({ error: 'Request unavailable' }, { status, headers: { 'Cache-Control': 'no-store' } })
const loginRequired = (request: Request) => request.method === 'GET' && request.headers.get('accept')?.includes('text/html')
  ? new Response(null, { status: 302, headers: { Location: '/cdn-cgi/access/login', 'Cache-Control': 'no-store' } })
  : error(401)

async function verifyAccess(token: string, issuer: string, audience: string, signal: AbortSignal): Promise<JWTPayload> {
  // Only trusted in-process keys are shared; each fetch retains its own cancellation signal.
  let cache = keyCaches.get(issuer)
  if (!cache) { cache = {}; keyCaches.set(issuer, cache) }
  const keys = createRemoteJWKSet(new URL(issuer + '/cdn-cgi/access/certs'), {
    [jwksCache]: cache,
    [customFetch]: (url, options) => fetch(url, { ...options, signal: AbortSignal.any([options.signal, signal]) }),
  })
  return (await jwtVerify(token, keys, { issuer, audience, requiredClaims: ['exp', 'sub', 'email'] })).payload
}
function joseCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string' ? err.code : undefined
}
function invalidAssertion(err: unknown): boolean {
  return ['ERR_JWT_EXPIRED', 'ERR_JWT_CLAIM_VALIDATION_FAILED', 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
    'ERR_JWKS_NO_MATCHING_KEY', 'ERR_JWS_INVALID', 'ERR_JWT_INVALID', 'ERR_JOSE_ALG_NOT_ALLOWED',
    'ERR_JOSE_NOT_SUPPORTED'].includes(joseCode(err) ?? '')
}
function accessCookie(value: string | null): string | null {
  const values = (value ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith('CF_Authorization='))
  return values.length === 1 ? values[0]!.slice('CF_Authorization='.length) : null
}
function clean(source: Headers): Headers {
  const output = new Headers(source)
  const dynamic = (source.get('connection') ?? '').split(',').map(v => v.trim().toLowerCase())
  for (const name of [...output.keys()]) {
    const key = name.toLowerCase()
    if (hop.has(key) || dynamic.includes(key) || key.startsWith('cf-') || key.startsWith('x-forwarded-') || key.startsWith('x-private-bridge-') || key.startsWith('x-envoy-') || ['forwarded', 'host', 'content-length', 'x-real-ip', 'true-client-ip', 'x-original-url', 'x-rewrite-url'].includes(key)) output.delete(name)
  }
  const cookies = (output.get('cookie') ?? '').split(';').map(v => v.trim()).filter(v => v && !/^cf_authorization(?:_|$)/i.test(v.split('=', 1)[0] ?? '')).join('; ')
  if (cookies) output.set('cookie', cookies); else output.delete('cookie')
  return output
}

class LimitExceeded extends Error {}
async function readBounded(stream: ReadableStream<Uint8Array> | null, maximum: number, signal: AbortSignal, timedOut: Promise<never>): Promise<ArrayBuffer | null> {
  if (!stream) return null
  const reader = stream.getReader(), chunks: Uint8Array[] = []; let size = 0
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  try {
    while (true) {
      const part = await Promise.race([reader.read(), timedOut])
      if (signal.aborted) throw new Error('timeout')
      if (part.done) break
      size += part.value.length
      if (size > maximum) { cancel(); throw new LimitExceeded() }
      chunks.push(part.value)
    }
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock() }
  const result = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length }
  return result.buffer
}

/** Test dependencies and deadline are injectable; the entrypoint uses the defaults. */
export async function handleForward(request: Request, context: GatewayContext, next: Continuation, env: ForwardEnv, verify: Verify = verifyAccess, timeoutMs = 15_000): Promise<Response> {
  const response = await handleForwardRequest(request, context, next, env, verify, timeoutMs)
  // Gateway forbids bodies on HEAD responses, including errors generated here.
  return request.method === 'HEAD' ? new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers }) : response
}

async function handleForwardRequest(request: Request, context: GatewayContext, next: Continuation, env: ForwardEnv, verify: Verify, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  let timer = setTimeout(() => controller.abort(), timeoutMs)
  const resetDeadline = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), timeoutMs) }
  const timedOut = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }))
  // A client disconnect cancels any abortable downstream work as well.
  const cancelClient = () => controller.abort()
  request.signal.addEventListener('abort', cancelClient, { once: true })
  if (request.signal.aborted) controller.abort()
  void timedOut.catch(() => {})
  let streaming = false
  const cleanup = () => { clearTimeout(timer); request.signal.removeEventListener('abort', cancelClient) }
  const forwardResponse = (response: Response, method: string, headers: Headers): Response => {
    if (method === 'HEAD' || [204, 205, 304].includes(response.status) || !response.body) {
      if (response.body) void response.body.cancel().catch(() => {})
      return new Response(null, { status: response.status, statusText: response.statusText, headers })
    }
    const reader = response.body.getReader()
    let finished = false
    resetDeadline()
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        const cancel = () => {
          if (finished) return
          finished = true
          void reader.cancel().catch(() => {})
          streamController.error(new Error('Response deadline exceeded'))
          cleanup()
        }
        controller.signal.addEventListener('abort', cancel, { once: true })
        if (controller.signal.aborted) cancel()
      },
      async pull(streamController) {
        try {
          const part = await reader.read()
          if (finished) return
          if (part.done) { finished = true; cleanup(); streamController.close() }
          else { resetDeadline(); streamController.enqueue(part.value) }
        } catch (err) {
          if (!finished) { finished = true; cleanup(); streamController.error(err) }
        }
      },
      async cancel() {
        if (finished) return
        finished = true
        cleanup()
        await reader.cancel()
      },
    })
    const result = new Response(stream, { status: response.status, statusText: response.statusText, headers })
    streaming = true
    return result
  }
  let phase: 'identity' | 'verification' | 'continuation' | 'request' | 'binding' = 'identity'
  try {
    if (controller.signal.aborted) return error(504)
    let origin: URL, issuer: URL
    try {
      origin = new URL(env.PRIVATE_ORIGIN); issuer = new URL(`https://${env.ACCESS_TEAM_DOMAIN}`)
      if (origin.origin !== env.PRIVATE_ORIGIN || !['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || !/^([a-z0-9-]+\.)+woven$/i.test(origin.hostname) || issuer.origin !== `https://${env.ACCESS_TEAM_DOMAIN}` || !issuer.hostname.endsWith('.cloudflareaccess.com') || !env.ACCESS_AUD) return error(503)
    } catch { return error(503) }
    const url = new URL(request.url), method = request.method.toUpperCase()
    if (url.origin !== origin.origin || url.pathname.startsWith('//')) return error(400)
    if (/^\/cdn-cgi\/access\/(?:login|logout)\/?$/.test(url.pathname)) {
      if (!['GET', 'HEAD'].includes(method)) return error(405)
      phase = 'continuation'
      const response = await Promise.race([next(new Request(request, { signal: controller.signal })), timedOut])
      return forwardResponse(response, method, response.headers)
    }
    if (url.pathname.startsWith('/cdn-cgi/')) return error(404)
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)) return error(405)
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && request.headers.get('Origin') !== origin.origin) return error(403)
    // Gateway context does not expose a cancellation argument; its result is ignored after the deadline.
    const identity = await Promise.race([context.identity(), timedOut])
    if (!identity?.email || typeof identity.email !== 'string') return loginRequired(request)
    const candidates = [request.headers.get('Cf-Access-Jwt-Assertion'), accessCookie(request.headers.get('Cookie'))].filter((v): v is string => !!v)
    if (!candidates.length) return loginRequired(request)
    let assertion: string | null = null
    phase = 'verification'
    for (const candidate of candidates) {
      if (candidate.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(candidate)) continue
      try {
        const payload = await Promise.race([verify(candidate, issuer.origin, env.ACCESS_AUD, controller.signal), timedOut])
        if (typeof payload.sub === 'string' && payload.sub && typeof payload.email === 'string' && payload.email.toLowerCase() === identity.email.toLowerCase() && typeof payload.exp === 'number' && payload.exp > Date.now() / 1000) { assertion = candidate; break }
      } catch (err) {
        if (controller.signal.aborted) throw err
        if (!invalidAssertion(err)) return error(joseCode(err) === 'ERR_JWKS_TIMEOUT' ? 504 : 503)
      }
    }
    if (!assertion) return loginRequired(request)
    phase = 'request'
    const len = request.headers.get('content-length')
    if (len && (!/^\d+$/.test(len) || Number(len) > 1_048_576)) return error(413)
    const body = await readBounded(request.body, 1_048_576, controller.signal, timedOut)
    const headers = clean(request.headers); headers.set('Cf-Access-Jwt-Assertion', assertion)
    const forwarded = new Request(request.url, { method, headers, body: ['GET', 'HEAD'].includes(method) ? undefined : body ?? undefined, redirect: 'manual', signal: controller.signal })
    phase = 'binding'
    const response = await Promise.race([env.FALLBACK.fetch(forwarded), timedOut])
    const location = response.headers.get('Location')
    if (location) { try { if (location.startsWith('//') || new URL(location, origin).origin !== origin.origin) return error(502) } catch { return error(502) } }
    const responseHeaders = new Headers(response.headers)
    const dynamic = (response.headers.get('connection') ?? '').split(',').map(value => value.trim().toLowerCase())
    for (const name of [...responseHeaders.keys()]) {
      const key = name.toLowerCase()
      if (hop.has(key) || dynamic.includes(key) || key.startsWith('x-private-bridge-') || key === 'cf-access-jwt-assertion') responseHeaders.delete(name)
    }
    return forwardResponse(response, method, responseHeaders)
  } catch (err) {
    if (controller.signal.aborted || joseCode(err) === 'ERR_JWKS_TIMEOUT') return error(504)
    if (err instanceof LimitExceeded) return error(phase === 'request' ? 413 : 502)
    return error(503)
  } finally { if (!streaming) cleanup() }
}
