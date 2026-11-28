import assert from 'node:assert/strict'
import test from 'node:test'
import { createDispatcher } from './dispatcher.ts'
import { candidateVerificationHeader } from '../src/verify-candidate.mjs'

const id = 'a'.repeat(24)
const selector = `branch-${id}`
const sha = 'b'.repeat(40)
const secret = 'private-verification-secret-32-bytes-long'
const request = (path = '/api/test', headers = {}) => new Request(`https://status.example${path}`, {
  headers: { 'X-Test-Preview': selector, ...headers },
})

function environment({ routeError, globalError, globalValue = true, route, throwRoute = false } = {}) {
  return {
    PREVIEW_HEADER: 'X-Test-Preview', FLAG_PREFIX: 'test-', PREVIEW_VERIFY_SECRET: secret,
    FLAGS: {
      getBooleanDetails: async key => {
        assert.equal(key, 'test-enabled')
        return { value: globalValue, errorCode: globalError }
      },
      getObjectDetails: async key => {
        assert.equal(key, `test-branch-${id}`)
        if (throwRoute) throw new Error('backend unavailable')
        return { value: route ?? {}, errorCode: routeError }
      },
    },
  }
}

test('missing branch flag is a non-cacheable 404, but other evaluation errors remain unavailable', async () => {
  const dispatcher = createDispatcher()
  for (const [errorCode, status] of [['FLAG_NOT_FOUND', 404], ['GENERAL', 503], ['TYPE_MISMATCH', 503], ['INVALID_CONTEXT', 503]]) {
    const response = await dispatcher.fetch(request(), environment({ routeError: errorCode }))
    assert.equal(response.status, status, errorCode)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    assert.equal(response.headers.get('X-Status-Preview-Commit'), null)
  }
  assert.equal((await dispatcher.fetch(request(), environment({ throwRoute: true }))).status, 503)
  assert.equal((await dispatcher.fetch(request(), environment({ globalError: 'FLAG_NOT_FOUND', routeError: 'FLAG_NOT_FOUND' }))).status, 503)
  assert.equal((await dispatcher.fetch(request(), environment({ globalValue: false, routeError: 'FLAG_NOT_FOUND' }))).status, 503)
})

test('missing active flag never makes privileged verification succeed', async () => {
  const dispatcher = createDispatcher(async () => true)
  const proof = candidateVerificationHeader({ selector, sha, secret, mode: 'active' })
  const response = await dispatcher.fetch(request('/__preview/verify', { 'X-Status-Preview-Verify': proof }), environment({ routeError: 'FLAG_NOT_FOUND' }))
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
})
