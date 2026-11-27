import assert from 'node:assert/strict'
import { issue14PreviewEnvironment } from '../issue14-preview.ts'
import { actionEndpoints } from '../../worker/src/actions-runtime.ts'

const scope = '737597c9ba1d3cc17826ea2f2b48a9d259e03dbf1acd241dc62d886da5c20511'
const base = { API_SCOPE: 'operations', PREVIEW_SUBSCRIBER_REQUIRED: 'true', PREVIEW_SUBSCRIBER_SCOPE: scope, PREVIEW_RELEASE: 'a'.repeat(40), VAULT_ENCRYPTION_KEY: 'existing-key', ISSUE14_ACTION_RECEIVER: { fetch: () => { throw new Error('must not be called') } } }
const configured = issue14PreviewEnvironment(base)
assert.equal(configured.ACTIONS_READY, 'true')
assert.equal(configured.VAULT_ENCRYPTION_KEY, base.VAULT_ENCRYPTION_KEY)
assert.equal(configured.ISSUE14_ACTION_RECEIVER, undefined)
const [endpoint] = [...actionEndpoints(configured.ACTION_ENDPOINTS).values()]
assert.equal(endpoint.binding, 'ISSUE14_ACTION_RECEIVER')
assert.equal(endpoint.serviceId, 'status-issue14-schema-sink-1127a')
assert.equal(new URL(endpoint.url).hostname, 'issue14.invalid')
for (const change of [{ API_SCOPE: 'monitoring' }, { API_SCOPE: 'status' }, { PREVIEW_SUBSCRIBER_REQUIRED: 'false' }, { PREVIEW_SUBSCRIBER_SCOPE: 'another-scope' }, { PREVIEW_RELEASE: '' }, { PREVIEW_RELEASE: 'not-a-commit' }]) {
  const other = { ...base, ...change }
  assert.equal(issue14PreviewEnvironment(other), other)
}
