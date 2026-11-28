import assert from 'node:assert/strict'
import test from 'node:test'
import gatewayModule from '../index.ts'

const gateway = 'default' in gatewayModule ? gatewayModule.default as typeof gatewayModule : gatewayModule
const selector = 'branch-' + 'a'.repeat(24)
const release = 'b'.repeat(40)
let identityStatus = 200
const api = { fetch: async (req: Request) => {
  assert.equal(new URL(req.url).pathname, '/api/v1/auth/preview-verify')
  assert.equal(req.method, 'GET')
  return new Response('{}', { status: identityStatus })
} }
const dispatcher = { fetch: async (req: Request) => {
  assert.equal(req.headers.get('X-Status-Preview-Release'), null)
  return new Response('branch feature')
} }
const env = { API: api, PREVIEW_DISPATCHER: dispatcher } as never
const request = (value: string) => new Request('https://status.example/api/test', { headers: { 'X-Status-Preview': value, 'X-Status-Preview-Release': 'forged' } })

test('authenticates and dispatches branch previews', async () => {
  const response = await gateway.fetch(request(selector), env)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'branch feature')
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
})

test('rejects malformed and retired slot selectors', async () => {
  assert.equal((await gateway.fetch(request('bad'), env)).status, 400)
  assert.equal((await gateway.fetch(request('1.' + 'a'.repeat(32)), env)).status, 400)
})

test('fails closed for invalid identity and missing dispatcher', async () => {
  identityStatus = 401
  assert.equal((await gateway.fetch(request(selector), env)).status, 401)
  identityStatus = 200
  assert.equal((await gateway.fetch(request(selector), { API: api } as never)).status, 503)
})

test('private gateway rejects stale and forged release identifiers', async () => {
  const target = { fetch: async () => new Response('feature') }
  const privateEnv = { PREVIEW_SELECTOR: selector, PREVIEW_RELEASE: release, API: api, STATUS_API: target } as never
  assert.equal((await gateway.fetch(request(selector), privateEnv)).status, 503)
  const headers = { 'X-Status-Preview': selector, 'X-Status-Preview-Release': release }
  const response = await gateway.fetch(new Request('https://status.example/api/v1/public/status', { headers }), privateEnv)
  assert.equal(response.status, 200)
})
