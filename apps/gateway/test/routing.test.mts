import assert from 'node:assert/strict'
import gatewayModule from '../index.ts'
import assetsModule from '../assets.ts'

const gateway = 'default' in gatewayModule ? gatewayModule.default as typeof gatewayModule : gatewayModule
const assets = 'default' in assetsModule ? assetsModule.default as typeof assetsModule : assetsModule
let role = 'operator'
let authOk = true
const calls: string[] = []
const api = { fetch: async (request: Request) => {
  const path = new URL(request.url).pathname
  calls.push('api:' + path)
  if (path === '/api/v1/auth/me') return authOk ? Response.json({ role }) : new Response('unauthorized', { status: 401 })
  return new Response('legacy:' + path, { status: path.startsWith('/api/') ? 200 : 404 })
}}
const status = { fetch: async (request: Request) => {
  const path = new URL(request.url).pathname
  calls.push('status:' + path)
  return new Response('status:' + path, { status: path === '/assets/old.js' ? 404 : 200 })
}}
const admin = { fetch: async (request: Request) => {
  const path = new URL(request.url).pathname
  calls.push('admin:' + path)
  return new Response('admin:' + path)
}}
const scoped = (scope: string) => ({ fetch: async (req: Request) => {
  calls.push(scope + ':' + new URL(req.url).pathname)
  return new Response(scope)
}})
const env = { API: api, STATUS_UI: status, ADMIN_UI: admin, STATUS_API: scoped('status-api'), MONITORING_API: scoped('monitoring-api'), UI_MODE: 'upstream' } as never
const request = (path: string, accept = 'text/html') => new Request('https://status.example' + path, { headers: { accept } })
let response = await gateway.fetch(request('/admin/monitors'), env)
assert.equal(await response.text(), 'admin:/monitors')
response = await gateway.fetch(request('/admin/assets/a.js', '*/*'), env)
assert.equal(await response.text(), 'admin:/assets/a.js')
const legacyEnv = { ...(env as object), UI_MODE: 'legacy' } as never
response = await gateway.fetch(request('/admin/assets/a.js', '*/*'), legacyEnv)
assert.equal(await response.text(), 'admin:/assets/a.js')
response = await gateway.fetch(request('/admin/monitors'), legacyEnv)
assert.equal(response.status, 404)
assert.equal(calls.at(-1), 'api:/admin/monitors')

response = await gateway.fetch(request('/admin'), env)
assert.equal(response.status, 308)
assert.equal(response.headers.get('location'), 'https://status.example/admin/')
response = await gateway.fetch(request('/api/v1/public/status', '*/*'), env)
assert.equal(await response.text(), 'status-api')
response = await gateway.fetch(request('/api/v1/bsp/admin/monitors/42/history', '*/*'), env)
assert.equal(await response.text(), 'monitoring-api')
response = await gateway.fetch(request('/api/v1/bsp/admin/incidents', '*/*'), env)
assert.equal(await response.text(), 'legacy:/api/v1/bsp/admin/incidents')
response = await gateway.fetch(request('/assets/old.js', '*/*'), env)
assert.equal(response.status, 404)
assert.equal(calls.at(-1), 'api:/assets/old.js')
role = 'viewer'
response = await gateway.fetch(request('/admin/monitors'), env)
assert.equal(response.status, 403)
authOk = false
response = await gateway.fetch(request('/'), env)
assert.equal(response.status, 401)
const paths: string[] = []
const assetEnv = { ASSETS: { fetch: async (req: Request) => {
  const path = new URL(req.url).pathname
  paths.push(path)
  return new Response(path, { status: path === '/' ? 200 : 404 })
}}} as never
response = await assets.fetch(request('/monitors'), assetEnv)
assert.equal(await response.text(), '/')
response = await assets.fetch(request('/assets/missing.js', '*/*'), assetEnv)
assert.equal(response.status, 404)
assert.deepEqual(paths, ['/monitors', '/', '/assets/missing.js'])
console.log('Gateway route and asset checks passed')
