import assert from 'node:assert/strict'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import fallbackModule from '../index.ts'

const fallback = 'default' in fallbackModule ? fallbackModule.default as typeof fallbackModule : fallbackModule
const { publicKey, privateKey } = await generateKeyPair('RS256')
const jwk = await exportJWK(publicKey)
jwk.kid = 'test-key'
jwk.alg = 'RS256'
const originalFetch = globalThis.fetch
globalThis.fetch = async () => Response.json({ keys: [jwk] }, { headers: { 'Cache-Control': 'max-age=3600' } })
const token = await new SignJWT({ email: 'reader@example.com' }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer('https://team.cloudflareaccess.com').setAudience('audience').setSubject('user').setExpirationTime('1h').sign(privateKey)
const otherToken = await new SignJWT({ email: 'reader@example.com' }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer('https://team.cloudflareaccess.com').setAudience('wrong').setSubject('user').setExpirationTime('1h').sign(privateKey)
let liveStatus = 200
let probeStatus = 200
let enabled = true
let hangGateway = false
const assetPaths: string[] = []
const calls: string[] = []
const env = {
  ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'audience',
  GATEWAY: { fetch: async (request: Request) => {
    const path = new URL(request.url).pathname
    calls.push(path)
    if (hangGateway) return new Promise<Response>(() => {})
    if (path === '/api/v1/bsp/public/status') return new Response('probe', { status: probeStatus })
    return new Response('live', { status: liveStatus })
  } },
  ASSETS: { fetch: async (request: Request) => {
    const path = new URL(request.url).pathname
    assetPaths.push(path)
    return new Response(path === '/' ? '<html><head></head><body></body></html>' : 'asset')
  } },
  FALLBACK_BUCKET: { get: async () => ({ json: async () => ({ enabled, snapshot: { schemaVersion: 1, generatedAt: 100 } }) }) },
} as never
const request = (path: string, jwt = token) => new Request(`https://status.example${path}`, { headers: { accept: 'text/html', ...(jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {}) } })
try {
  let result = await fallback.fetch(request('/'), env)
  assert.equal(await result.text(), 'live')
  assert.deepEqual(calls, ['/', '/api/v1/bsp/public/status'])
  probeStatus = 503
  result = await fallback.fetch(request('/'), env)
  assert.match(await result.text(), /bsp-snapshot/)
  assert.equal(result.headers.get('cache-control'), 'no-store')
  result = await fallback.fetch(request('/__fallback/logo_dark.png'), env)
  assert.equal(await result.text(), 'asset')
  assert.equal(assetPaths.at(-1), '/logo_dark.png')
  result = await fallback.fetch(request('/__fallback/icon.png'), env)
  assert.equal(await result.text(), 'asset')
  assert.equal(assetPaths.at(-1), '/icon.png')
  result = await fallback.fetch(request('/__fallback/snapshot.json'), env)
  assert.deepEqual(await result.json(), { schemaVersion: 1, generatedAt: 100 })
  assert.equal((await fallback.fetch(request('/__fallback/assets/a.js', ''), env)).status, 401)
  assert.equal((await fallback.fetch(request('/__fallback/snapshot.json', otherToken), env)).status, 401)
  probeStatus = 401
  assert.equal((await fallback.fetch(request('/'), env)).status, 401)
  liveStatus = 503
  enabled = false
  assert.equal((await fallback.fetch(request('/'), env)).status, 503)
  enabled = true
  result = await fallback.fetch(request('/admin/'), env)
  assert.equal(await result.text(), 'live')
  hangGateway = true
  const started = Date.now()
  assert.match(await (await fallback.fetch(request('/'), env)).text(), /bsp-snapshot/)
  assert.ok(Date.now() - started < 6500)
  hangGateway = false
  liveStatus = 200
  probeStatus = 200
  assert.equal(await (await fallback.fetch(request('/'), env)).text(), 'live')
} finally {
  globalThis.fetch = originalFetch
}
