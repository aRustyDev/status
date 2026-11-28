import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { isIssue14PreviewViewer } from '../issue14-preview.ts'

const client = 'synthetic-viewer-id'
const digest = createHash('sha256').update(client).digest('hex')
const env = { API_SCOPE: 'operations', PREVIEW_SUBSCRIBER_REQUIRED: 'true', PREVIEW_SUBSCRIBER_SCOPE: '737597c9ba1d3cc17826ea2f2b48a9d259e03dbf1acd241dc62d886da5c20511', PREVIEW_RELEASE: 'a'.repeat(40), DEPLOYMENT_ENVIRONMENT: 'staging' }
const identity = { type: 'app', common_name: client }
const origin = new URL('https://status.sow.foo/api/v1/auth/me')

test('the fallback recognizes only the isolated viewer on the exact staging origin', async () => {
  assert.equal(await isIssue14PreviewViewer(env, origin, identity, digest), true)
  for (const change of [{API_SCOPE:'status'}, {PREVIEW_SUBSCRIBER_REQUIRED:'false'}, {PREVIEW_SUBSCRIBER_SCOPE:'other'}, {PREVIEW_RELEASE:''}, {DEPLOYMENT_ENVIRONMENT:'production'}, {PREVIEW_BROWSER_CLIENT_ID:'different'}, {PREVIEW_BROWSER_ORIGIN:'https://status.sow.foo'}]) {
    assert.equal(await isIssue14PreviewViewer({...env,...change}, origin, identity, digest), false)
  }
  assert.equal(await isIssue14PreviewViewer(env, new URL('https://other.invalid'), identity, digest), false)
  assert.equal(await isIssue14PreviewViewer(env, new URL('http://status.sow.foo'), identity, digest), false)
  assert.equal(await isIssue14PreviewViewer(env, origin, {type:'org',common_name:client}, digest), false)
  assert.equal(await isIssue14PreviewViewer(env, origin, {type:'app',common_name:'different'}, digest), false)
  assert.equal(await isIssue14PreviewViewer(env, origin, {type:'app'}, digest), false)
})
