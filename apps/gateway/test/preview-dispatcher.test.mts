import assert from 'node:assert/strict'
import test from 'node:test'
import gatewayModule from '../index.ts'
import dispatcherModule from '../preview-dispatcher.ts'
import { createDispatcher, verifyServiceToken } from '../preview-dispatcher.ts'
import { generateKeyPair, SignJWT } from 'jose'
import { candidateVerificationHeader } from '../../../.github/actions/branch-previews/src/verify-candidate.mjs'

const gateway = 'default' in gatewayModule ? gatewayModule.default as typeof gatewayModule : gatewayModule
const dispatcher = 'default' in dispatcherModule ? dispatcherModule.default as typeof dispatcherModule : dispatcherModule
const key = 'a'.repeat(24)
const selector = `branch-${key}`
const sha = 'b'.repeat(40)
const binding = `PREVIEW_BRANCH_${key.toUpperCase()}_${sha.toUpperCase()}`
let identityStatus = 200
let flagError: string | undefined
let enabled = true
let route: Record<string, unknown> = { selector, release: sha }
const api = { fetch: async () => new Response('{}', { status: identityStatus }) }
const flags = {
  getBooleanDetails: async () => ({ value: enabled }),
  getObjectDetails: async (name: string) => {
    assert.equal(name, `status-preview-branch-${key}`)
    return { value: route, errorCode: flagError }
  },
}
const target = { fetch: async (request: Request) => {
  assert.equal(request.headers.get('X-Status-Preview-Release'), sha)
  assert.equal(request.headers.get('X-Status-Preview-Verify'), null)
  if (new URL(request.url).pathname === '/__preview/verify') {
    assert.equal(request.headers.get('X-Status-Preview-Probe'), '1')
    assert.equal(request.headers.get('Cf-Access-Jwt-Assertion'), null)
    return new Response(null, { status: 204 })
  }
  return new Response('branch response', { headers: { 'Cache-Control': 'public, max-age=500' } })
} }
const dispatcherEnv = { FLAGS: flags, [binding]: target } as never
const previewDispatcher = { fetch: (request: Request) => dispatcher.fetch(request, dispatcherEnv) }
const env = { API: api, PREVIEW_DISPATCHER: previewDispatcher } as never
const request = (value = selector) => new Request('https://status.example/api/test', {
  headers: { 'X-Status-Preview': value, 'X-Status-Preview-Release': 'forged' },
})

test('authenticates before dispatching and routes the selected release without caching', async () => {
  identityStatus = 401
  assert.equal((await gateway.fetch(request(), env)).status, 401)
  identityStatus = 200
  const response = await gateway.fetch(request(), env)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'branch response')
  assert.equal(response.headers.get('X-Status-Preview-Commit'), sha)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
})

test('rejects malformed, disabled, unknown, and unavailable branch routes', async () => {
  assert.equal((await gateway.fetch(request('branch-bad'), env)).status, 400)
  enabled = false
  assert.equal((await gateway.fetch(request(), env)).status, 503)
  enabled = true
  flagError = 'ERROR'
  assert.equal((await gateway.fetch(request(), env)).status, 503)
  flagError = undefined
  route = { selector: 'branch-' + 'c'.repeat(24), release: sha }
  assert.equal((await gateway.fetch(request(), env)).status, 404)
  route = { selector, release: 'c'.repeat(40) }
  assert.equal((await gateway.fetch(request(), env)).status, 503)
  route = { selector, release: sha }
})

test('returns an uncached 404 for a deleted selector flag and keeps evaluation failures unavailable', async () => {
  try {
    flagError = 'FLAG_NOT_FOUND'
    const missing = await gateway.fetch(request(), env)
    assert.equal(missing.status, 404)
    assert.equal(await missing.text(), 'Preview not found')
    assert.equal(missing.headers.get('Cache-Control'), 'no-store')
    assert.equal(missing.headers.get('X-Status-Preview-Commit'), null)

    for (const error of ['GENERAL', 'TYPE_MISMATCH', 'PARSE_ERROR']) {
      flagError = error
      assert.equal((await gateway.fetch(request(), env)).status, 503)
    }
  } finally {
    flagError = undefined
  }
})

test('verifies a bound candidate only with a valid, fresh signature and Access identity', async () => {
  const secret = 'private-verification-secret-32-bytes-long'
  const verifyEnv = { FLAGS: flags, PREVIEW_VERIFY_SECRET: secret, [binding]: target } as never
  let serviceAuthorized = false
  const serviceDispatcher = createDispatcher(async () => serviceAuthorized)
  const verifyDispatcher = { fetch: (req: Request) => serviceDispatcher.fetch(req, verifyEnv) }
  const entry = { API: api, PREVIEW_DISPATCHER: verifyDispatcher } as never
  const token = candidateVerificationHeader({ selector, sha, secret })
  const signedRequest = (path = '/__preview/verify', value = token) => new Request(`https://status.example${path}`, {
    headers: { 'X-Status-Preview': selector, 'X-Status-Preview-Verify': value },
  })
  identityStatus = 401
  assert.equal((await gateway.fetch(signedRequest(), entry)).status, 403)
  serviceAuthorized = true
  const response = await gateway.fetch(signedRequest(), entry)
  assert.equal(response.status, 204)
  assert.equal(response.headers.get('X-Status-Preview-Commit'), sha)
  assert.equal((await gateway.fetch(signedRequest('/api/v1/other'), entry)).status, 401)
  assert.equal((await gateway.fetch(signedRequest('/__preview/verify', candidateVerificationHeader({ selector, sha, secret, now: Date.now() - 120_000 })), entry)).status, 403)
  assert.equal((await gateway.fetch(signedRequest('/__preview/verify', token.slice(0, -1) + (token.endsWith('0') ? '1' : '0')), entry)).status, 403)
  route = { selector, release: 'c'.repeat(40) }
  assert.equal((await gateway.fetch(signedRequest('/__preview/verify', candidateVerificationHeader({ selector, sha, secret, mode: 'active' })), entry)).status, 503)
  route = { selector, release: sha }
  assert.equal((await gateway.fetch(signedRequest('/__preview/verify', candidateVerificationHeader({ selector, sha, secret, mode: 'active' })), entry)).status, 204)
  identityStatus = 200
})

test('service proof requires a signed Access JWT for the configured token and audience', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const issuer = 'https://team.cloudflareaccess.com'
  const env = { ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'aud', PREVIEW_SERVICE_TOKEN_ID: 'token.access' } as never
  const makeRequest = async (claims: Record<string, string>, audience = 'aud') => new Request('https://status.example', { headers: {
    'Cf-Access-Jwt-Assertion': await new SignJWT(claims).setProtectedHeader({ alg: 'RS256' }).setIssuer(issuer).setAudience(audience).setExpirationTime('1m').sign(privateKey),
  } })
  const keys = async () => publicKey
  assert.equal(await verifyServiceToken(await makeRequest({ common_name: 'token.access' }), env, keys), true)
  assert.equal(await verifyServiceToken(await makeRequest({ common_name: 'another.access' }), env, keys), false)
  assert.equal(await verifyServiceToken(await makeRequest({ common_name: 'token.access' }, 'wrong'), env, keys), false)
  assert.equal(await verifyServiceToken(new Request('https://status.example'), env, keys), false)
})
