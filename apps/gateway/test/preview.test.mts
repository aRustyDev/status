import assert from 'node:assert/strict'
import test from 'node:test'
import gatewayModule from '../index.ts'

const gateway = 'default' in gatewayModule ? gatewayModule.default as typeof gatewayModule : gatewayModule
const selector = '1.' + 'a'.repeat(32)
const release = 'b'.repeat(40)
let route: Record<string, unknown> = { selector, release, target: 'a', expiresAt: Date.now() + 60_000 }
let enabled = true
let flagError: string | undefined
let identityStatus = 200
const api = { fetch: async (req: Request) => {
  assert.equal(new URL(req.url).pathname, '/api/v1/auth/preview-verify')
  assert.equal(req.method, 'GET')
  return new Response('{}', { status: identityStatus })
} }
const flags = {
  getBooleanDetails: async () => ({ value: enabled }),
  getObjectDetails: async () => ({ value: route, errorCode: flagError }),
}
const target = { fetch: async (req: Request) => {
  assert.equal(req.headers.get('X-Status-Preview-Release'), release)
  return new Response('feature')
} }
const env = { API: api, FLAGS: flags, PREVIEW_1_A: target } as never
const request = (value: string) => new Request('https://status.example/api/test', { headers: { 'X-Status-Preview': value, 'X-Status-Preview-Release': 'forged' } })

test('routes an authenticated request through Flagship and the selected binding', async () => {
  const response = await gateway.fetch(request(selector), env)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'feature')
  assert.equal(response.headers.get('X-Status-Preview-Commit'), release)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
})

test('checks branch previews with the verification-only endpoint', async () => {
  const branchSelector = 'branch-' + 'a'.repeat(24)
  const dispatcher = { fetch: async () => new Response('branch feature') }
  const response = await gateway.fetch(request(branchSelector), { API: api, PREVIEW_DISPATCHER: dispatcher } as never)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'branch feature')
})

test('rejects malformed, unknown, and expired selectors', async () => {
  assert.equal((await gateway.fetch(request('bad'), env)).status, 400)
  assert.equal((await gateway.fetch(request('1.' + 'c'.repeat(32)), env)).status, 404)
  route = { ...route, expiresAt: Date.now() - 1 }
  assert.equal((await gateway.fetch(request(selector), env)).status, 404)
  route = { ...route, expiresAt: Date.now() + 60_000 }
})

test('fails closed for invalid identity, disabled flags, evaluation errors and missing bindings', async () => {
  identityStatus = 401
  assert.equal((await gateway.fetch(request(selector), env)).status, 401)
  identityStatus = 200
  enabled = false
  assert.equal((await gateway.fetch(request(selector), env)).status, 503)
  enabled = true
  flagError = 'GENERAL'
  assert.equal((await gateway.fetch(request(selector), env)).status, 503)
  flagError = undefined
  route = { ...route, target: 'b' }
  assert.equal((await gateway.fetch(request(selector), env)).status, 503)
  route = { ...route, target: 'a' }
})

test('private gateway rejects stale and forged release identifiers', async () => {
  const privateEnv = { PREVIEW_SELECTOR: selector, PREVIEW_RELEASE: release, API: api, STATUS_API: target } as never
  assert.equal((await gateway.fetch(request(selector), privateEnv)).status, 503)
  const headers = { 'X-Status-Preview': selector, 'X-Status-Preview-Release': release }
  const response = await gateway.fetch(new Request('https://status.example/api/v1/public/status', { headers }), privateEnv)
  assert.equal(response.status, 200)
})
