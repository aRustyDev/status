import { createRemoteJWKSet, jwtVerify } from 'jose'

// Dedicated Access ingress; the existing private dispatcher selects the current
// branch release. This Worker never has a database, scheduler, or destination.
const METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE'])
const ACTION_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const actionItem = new RegExp(`^/api/v1/bsp/admin/actions/${ACTION_ID}$`, 'i')
const reads = new Set(['/api/v1/auth/me', '/api/v1/bsp/auth/me', '/api/v1/bsp/capabilities',
  '/api/v1/bsp/admin/actions', '/api/v1/bsp/admin/actions/destinations', '/api/v1/bsp/admin/actions/checks',
  '/api/v1/bsp/admin/actions/runs', '/api/v1/bsp/admin/vaults',
  '/api/v1/bsp/admin/vaults/238010605399733/secrets', '/admin/actions', '/admin/icon.png'])
const asset = /^\/admin\/assets\/[A-Za-z0-9._-]+\.(?:js|css|svg|png|woff2?)$/
const cache = new Map()
const error = (message, status) => Response.json({error:message}, {status,headers:{'Cache-Control':'no-store'}})

function config(env) {
  try {
    const origin = new URL(env.PREVIEW_EDITOR_ORIGIN), issuer = new URL(env.PREVIEW_EDITOR_ISSUER)
    if (origin.protocol !== 'https:' || origin.origin !== env.PREVIEW_EDITOR_ORIGIN || origin.origin === 'https://status.sow.foo' || origin.username || origin.password ||
        issuer.protocol !== 'https:' || issuer.origin !== env.PREVIEW_EDITOR_ISSUER || issuer.username || issuer.password || !issuer.hostname.endsWith('.cloudflareaccess.com') ||
        !/^[A-Za-z0-9._-]{1,256}$/.test(env.PREVIEW_EDITOR_AUD || '') || !/^[A-Za-z0-9._-]{1,256}$/.test(env.PREVIEW_EDITOR_CLIENT_ID || '') ||
        !/^branch-[0-9a-f]{24}$/.test(env.PREVIEW_SELECTOR || '') || !/^[a-z0-9-]+-preview-$/.test(env.PREVIEW_FLAG_PREFIX || '') ||
        !env.FLAGS || !env.PREVIEW_DISPATCHER) return null
    return {origin:origin.origin, issuer:issuer.origin, selector:env.PREVIEW_SELECTOR}
  } catch { return null }
}
function allowed(method,path) {
  if (path.includes('%') || path.includes('//') || !METHODS.has(method)) return false
  if (method === 'GET') return reads.has(path) || asset.test(path) || actionItem.test(path)
  if (method === 'POST') return path === '/api/v1/bsp/admin/actions'
  return (method === 'PATCH' || method === 'DELETE') && actionItem.test(path)
}
async function active(env,id) {
  try {
    const [enabled,route] = await Promise.all([
      env.FLAGS.getBooleanDetails(`${env.PREVIEW_FLAG_PREFIX}enabled`,false),
      env.FLAGS.getObjectDetails(`${env.PREVIEW_FLAG_PREFIX}branch-${id.selector.slice(7)}`,{}),
    ])
    if (enabled.errorCode || enabled.value !== true || route.errorCode || route.value?.selector !== id.selector || !/^[0-9a-f]{40}$/.test(route.value?.release || '')) return null
    return route.value.release
  } catch { return null }
}
function remoteKeys(issuer) {
  if (!cache.has(issuer)) cache.set(issuer,createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)))
  return cache.get(issuer)
}

export function createIngress(keyProvider=remoteKeys) {
  return {async fetch(request,env) {
    const id=config(env)
    if (!id) return error('Preview unavailable',503)
    const url=new URL(request.url)
    if (url.origin!==id.origin || !allowed(request.method,url.pathname)) return error('Not found',404)
    if (request.headers.get('X-Status-Preview')!==id.selector) return error('Preview unavailable',503)
    const jwt=request.headers.get('Cf-Access-Jwt-Assertion')
    if (!jwt || jwt.length>16384) return error('Access authentication required',401)
    try {
      const {payload}=await jwtVerify(jwt,keyProvider(id.issuer),{issuer:id.issuer,audience:env.PREVIEW_EDITOR_AUD,algorithms:['RS256'],requiredClaims:['exp']})
      if (payload.type!=='app' || payload.common_name!==env.PREVIEW_EDITOR_CLIENT_ID) return error('Invalid Access identity',401)
    } catch { return error('Invalid Access identity',401) }
    if (request.method!=='GET') {
      if (request.headers.get('Origin')!==id.origin || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type')||'')) return error('Invalid request origin or content type',403)
      const length=request.headers.get('Content-Length')
      if (length!==null && (!/^\d+$/.test(length) || Number(length)>64000)) return error('Request too large',413)
    }
    const expected=request.headers.get('X-Status-Editor-Expected-Release')
    if (!/^[0-9a-f]{40}$/.test(expected || '')) return error('Preview unavailable',503)
    const release=await active(env,id)
    if (!release || release!==expected) return error('Preview unavailable',503)
    const headers=new Headers(request.headers)
    for (const name of ['CF-Access-Client-Id','CF-Access-Client-Secret','Cookie','Authorization','X-Status-Identity-Method','X-Status-Preview','X-Status-Preview-Release','X-Status-Preview-Verify','X-Status-Preview-Probe','X-Status-Editor-Expected-Release']) headers.delete(name)
    headers.set('X-Status-Preview',id.selector)
    // The selected release checks this value against its own PREVIEW_RELEASE
    // before any editor write, fencing a dispatcher switch after our check.
    headers.set('X-Status-Editor-Expected-Release',release)
    let response
    try { response=await env.PREVIEW_DISPATCHER.fetch(new Request(request,{headers})) }
    catch { return error('Preview unavailable',503) }
    if (response.headers.get('X-Status-Preview-Commit')!==release) {
      void response.body?.cancel().catch(()=>{})
      return error('Preview changed',503)
    }
    const output=new Headers(response.headers)
    output.set('Cache-Control','no-store')
    return new Response(response.body,{status:response.status,statusText:response.statusText,headers:output})
  }}
}

export default createIngress()
