interface Env {
  ASSETS: Fetcher
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const asset = await env.ASSETS.fetch(request)
    if (asset.status !== 404) return asset
    if (request.method !== 'GET' || !request.headers.get('accept')?.includes('text/html')) return asset
    const url = new URL(request.url)
    if (url.pathname.startsWith('/assets/')) return asset
    url.pathname = '/'
    return env.ASSETS.fetch(new Request(url, request))
  },
}
