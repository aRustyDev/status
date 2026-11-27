import { apiScope } from './scope'

interface Env {
  API: Fetcher
  STATUS_UI: Fetcher
  STATUS_API: Fetcher
  MONITORING_API: Fetcher
  ADMIN_UI: Fetcher
  UI_MODE: string
  FLAGS?: Flagship
  PREVIEW_DISPATCHER?: Fetcher
  PREVIEW_SELECTOR?: string
  PREVIEW_RELEASE?: string
  [key: `PREVIEW_${number}_${'A' | 'B'}`]: Fetcher
}

interface PreviewRoute {
  selector?: string
  target?: string
  release?: string
  expiresAt?: number
}

function uncached(response: Response, release?: string): Response {
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', 'no-store')
  if (release) headers.set('X-Status-Preview-Commit', release)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

async function preview(request: Request, env: Env, selector: string): Promise<Response> {
  const match = /^([1-6])\.[0-9a-f]{32}$/.exec(selector)
  const branch = /^branch-[0-9a-f]{24}$/.test(selector)
  if (!match && !branch) return uncached(new Response('Invalid preview selector', { status: 400 }))

  // Only the private dispatcher can authenticate this narrow service probe.
  // Ordinary requests continue through the human-identity check below.
  if (branch && request.method === 'GET' && new URL(request.url).pathname === '/__preview/verify' && request.headers.has('X-Status-Preview-Verify')) {
    if (!env.PREVIEW_DISPATCHER) return uncached(new Response('Preview routing unavailable', { status: 503 }))
    try { return uncached(await env.PREVIEW_DISPATCHER.fetch(request)) }
    catch { return uncached(new Response('Preview routing unavailable', { status: 503 })) }
  }

  // The baseline API validates the Access assertion before a client can select a build.
  const identityUrl = new URL('/api/v1/auth/preview-verify', request.url)
  let identity: Response
  try {
    identity = await env.API.fetch(new Request(identityUrl, { method: 'GET', headers: request.headers }))
  } catch {
    return uncached(new Response('Preview routing unavailable', { status: 503 }))
  }
  if (!identity.ok) return uncached(identity)
  if (branch) {
    if (!env.PREVIEW_DISPATCHER) return uncached(new Response('Preview routing unavailable', { status: 503 }))
    try {
      const headers = new Headers(request.headers)
      headers.delete('X-Status-Preview-Release')
      return uncached(await env.PREVIEW_DISPATCHER.fetch(new Request(request, { headers })))
    } catch {
      return uncached(new Response('Preview routing unavailable', { status: 503 }))
    }
  }
  if (!match) return uncached(new Response('Invalid preview selector', { status: 400 }))
  if (!env.FLAGS) return uncached(new Response('Preview routing unavailable', { status: 503 }))

  try {
    const enabled = await env.FLAGS.getBooleanDetails('status-preview-enabled', false)
    if (enabled.errorCode || !enabled.value) return uncached(new Response('Preview routing unavailable', { status: 503 }))
    const details = await env.FLAGS.getObjectDetails<PreviewRoute>(`status-preview-slot-${match[1]}`, {})
    if (details.errorCode) return uncached(new Response('Preview routing unavailable', { status: 503 }))
    const route = details.value
    if (route.selector !== selector || typeof route.expiresAt !== 'number' || route.expiresAt <= Date.now()) {
      return uncached(new Response('Preview not found', { status: 404 }))
    }
    if ((route.target !== 'a' && route.target !== 'b') || !route.release || !/^[0-9a-f]{40}$/.test(route.release)) {
      return uncached(new Response('Preview routing unavailable', { status: 503 }))
    }
    const binding = env[`PREVIEW_${match[1]}_${route.target.toUpperCase()}` as `PREVIEW_${number}_${'A' | 'B'}`]
    if (!binding) return uncached(new Response('Preview routing unavailable', { status: 503 }))
    const headers = new Headers(request.headers)
    headers.set('X-Status-Preview-Release', route.release)
    const response = await binding.fetch(new Request(request, { headers }))
    return uncached(response, route.release)
  } catch {
    return uncached(new Response('Preview routing unavailable', { status: 503 }))
  }
}

async function route(request: Request, env: Env): Promise<Response> {
    if (env.PREVIEW_SELECTOR || env.PREVIEW_RELEASE) {
      if (!env.PREVIEW_SELECTOR || !env.PREVIEW_RELEASE ||
          request.headers.get('X-Status-Preview') !== env.PREVIEW_SELECTOR ||
          request.headers.get('X-Status-Preview-Release') !== env.PREVIEW_RELEASE) {
        return uncached(new Response('Preview unavailable', { status: 503 }))
      }
    } else {
      const selector = request.headers.get('X-Status-Preview')
      if (selector !== null) return preview(request, env, selector)
    }
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/')) {
      const scope = apiScope(url.pathname)
      if (scope === 'status') return env.STATUS_API.fetch(request)
      if (scope === 'monitoring') return env.MONITORING_API.fetch(request)
      return env.API.fetch(request)
    }

    const identityUrl = new URL('/api/v1/auth/me', url)
    const identity = await env.API.fetch(new Request(identityUrl, {
      method: 'GET',
      headers: request.headers,
    }))
    if (!identity.ok) return identity
    const user = await identity.json<{ role: string }>()

    if (url.pathname === '/admin') {
      url.pathname = '/admin/'
      return Response.redirect(url.toString(), 308)
    }
    if (url.pathname.startsWith('/admin/')) {
      if (user.role !== 'operator' && user.role !== 'admin') {
        return Response.json({ error: 'Insufficient role' }, { status: 403 })
      }
      if (env.UI_MODE === 'legacy' && !url.pathname.startsWith('/admin/assets/')) {
        return env.API.fetch(request)
      }
      url.pathname = url.pathname.slice('/admin'.length)
      return env.ADMIN_UI.fetch(new Request(url, request))
    }

    const isNavigation = request.method === 'GET' &&
      request.headers.get('accept')?.includes('text/html')
    if (isNavigation) {
      return env.UI_MODE === 'legacy' ? env.API.fetch(request) : env.STATUS_UI.fetch(request)
    }
    const asset = await env.STATUS_UI.fetch(request)
    if (asset.status !== 404) return asset
    return env.API.fetch(request)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return uncached(await route(request, env))
  },
}
