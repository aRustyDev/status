import { apiScope } from './scope'

interface Env {
  API: Fetcher
  STATUS_UI: Fetcher
  STATUS_API: Fetcher
  MONITORING_API: Fetcher
  ADMIN_UI: Fetcher
  UI_MODE: string
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
  },
}
