import { apiScope } from './scope'

interface Env {
  API: Fetcher
  STATUS_UI: Fetcher
  STATUS_API: Fetcher
  MONITORING_API: Fetcher
  ADMIN_UI: Fetcher
  UI_MODE: string
  PREVIEW_DISPATCHER?: Fetcher
  PREVIEW_SELECTOR?: string
  PREVIEW_RELEASE?: string
}

function uncached(response: Response, release?: string): Response {
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', 'no-store')
  if (release) headers.set('X-Status-Preview-Commit', release)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

async function preview(request: Request, env: Env, selector: string): Promise<Response> {
  if (!/^branch-[0-9a-f]{24}$/.test(selector)) return uncached(new Response('Invalid preview selector', { status: 400 }))

  // Only the private dispatcher can authenticate this narrow service probe.
  // Ordinary requests continue through the human-identity check below.
  if (request.method === 'GET' && new URL(request.url).pathname === '/__preview/verify' && request.headers.has('X-Status-Preview-Verify')) {
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
  if (!env.PREVIEW_DISPATCHER) return uncached(new Response('Preview routing unavailable', { status: 503 }))
  try {
    const headers = new Headers(request.headers)
    headers.delete('X-Status-Preview-Release')
    return uncached(await env.PREVIEW_DISPATCHER.fetch(new Request(request, { headers })))
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
