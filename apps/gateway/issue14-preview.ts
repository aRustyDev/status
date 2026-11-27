// This branch-only fixture enables the editor for one isolated schema preview.
// The controller gives schema releases a private database and sets this scope
// from the selector. Other previews and normal deployments must remain unchanged.
const isolatedScope = '737597c9ba1d3cc17826ea2f2b48a9d259e03dbf1acd241dc62d886da5c20511'
const destination = JSON.stringify([{ id: 'issue14-isolated-sink', name: 'Issue 14 isolated sink', url: 'https://issue14.invalid/action', binding: 'ISSUE14_ACTION_RECEIVER', serviceId: 'status-issue14-schema-sink-1127a', revision: '1' }])

export type Issue14PreviewScope = { API_SCOPE?: string; PREVIEW_SUBSCRIBER_REQUIRED?: string; PREVIEW_SUBSCRIBER_SCOPE?: string; PREVIEW_RELEASE?: string }
export function isIssue14Preview(env: Issue14PreviewScope): boolean {
  return env.API_SCOPE === 'operations' && env.PREVIEW_SUBSCRIBER_REQUIRED === 'true' && env.PREVIEW_SUBSCRIBER_SCOPE === isolatedScope && /^[0-9a-f]{40}$/.test(env.PREVIEW_RELEASE ?? '')
}
export function issue14PreviewEnvironment<T extends Issue14PreviewScope>(env: T): T {
  if (!isIssue14Preview(env)) return env
  // Deliberately remove the binding, even if one was supplied. The Action
  // runtime fails closed for bound destinations whose service is unavailable.
  return { ...env, ACTIONS_READY: 'true', ACTION_ENDPOINTS: destination, ISSUE14_ACTION_RECEIVER: undefined }
}
