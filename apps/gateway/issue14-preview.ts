// This branch-only fixture enables the editor for one isolated schema preview.
// The controller gives schema releases a private database and sets this scope
// from the selector. Other previews and normal deployments must remain unchanged.
const isolatedScope = '737597c9ba1d3cc17826ea2f2b48a9d259e03dbf1acd241dc62d886da5c20511'
const destination = JSON.stringify([{ id: 'issue14-isolated-sink', name: 'Issue 14 isolated sink', url: 'https://issue14.invalid/action', binding: 'ISSUE14_ACTION_RECEIVER', serviceId: 'status-issue14-schema-sink-1127a', revision: '1' }])

export type Issue14PreviewScope = { API_SCOPE?: string; PREVIEW_SUBSCRIBER_REQUIRED?: string; PREVIEW_SUBSCRIBER_SCOPE?: string; PREVIEW_RELEASE?: string }
export function isIssue14Preview(env: Issue14PreviewScope): boolean {
  return env.API_SCOPE === 'operations' && env.PREVIEW_SUBSCRIBER_REQUIRED === 'true' && env.PREVIEW_SUBSCRIBER_SCOPE === isolatedScope && /^[0-9a-f]{40}$/.test(env.PREVIEW_RELEASE ?? '')
}

// Only this disposable preview may identify the configured read-only browser
// when the schema deployment lacks the optional viewer settings. A digest
// avoids storing the Access service token's client ID in the branch.
const viewerClientDigest = '1b9cd395a5c85a3f1075180faf1ef920cdd86382154ec9ccfc8a2a6eb430abaa'
export async function isKnownIssue14ViewerClient(clientId: string, expectedDigest = viewerClientDigest): Promise<boolean> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(clientId))
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('') === expectedDigest
}
export async function isIssue14PreviewViewer(
  env: Issue14PreviewScope & { DEPLOYMENT_ENVIRONMENT?: string; PREVIEW_BROWSER_CLIENT_ID?: string; PREVIEW_BROWSER_ORIGIN?: string },
  url: URL, identity: { common_name?: unknown; type?: unknown }, expectedDigest = viewerClientDigest,
): Promise<boolean> {
  if (!isIssue14Preview(env) || env.DEPLOYMENT_ENVIRONMENT !== 'staging' || env.PREVIEW_BROWSER_CLIENT_ID || env.PREVIEW_BROWSER_ORIGIN ||
      url.origin !== 'https://status.sow.foo' || identity.type !== 'app' || typeof identity.common_name !== 'string') return false
  return isKnownIssue14ViewerClient(identity.common_name, expectedDigest)
}

// Public Access app metadata and a one-way client-ID digest, not the token's
// secret. This fallback is compiled only into the disposable preview branch.
const editorFallback = {
  origin: 'https://issue14-editor-778537fd773a0d7e33ce.sow.foo',
  issuer: 'https://woven-solutions.cloudflareaccess.com',
  audience: '83b17595e80d731d05695243f699bfe376c639b81bf7be639bbe77b1f285f5dd',
  clientDigest: '88e1c5b7f97e3d216fc80334420c2fb1a9c5802380d98c6346baf81e1f273669',
}
type EditorSettings = { origin:string; issuer:string; audience:string; clientId?:string; clientDigest?:string }
export function issue14EditorSettings(env: Issue14PreviewScope & { DEPLOYMENT_ENVIRONMENT?:string; PREVIEW_EDITOR_ORIGIN?:string; PREVIEW_EDITOR_ISSUER?:string; PREVIEW_EDITOR_AUD?:string; PREVIEW_EDITOR_CLIENT_ID?:string }, fallback: EditorSettings = editorFallback): EditorSettings | null {
  if (!isIssue14Preview(env) || env.DEPLOYMENT_ENVIRONMENT !== 'staging') return null
  const values = [env.PREVIEW_EDITOR_ORIGIN, env.PREVIEW_EDITOR_ISSUER, env.PREVIEW_EDITOR_AUD, env.PREVIEW_EDITOR_CLIENT_ID]
  if (values.every(value => !value)) return fallback
  if (values.some(value => !value)) return null
  return { origin:values[0]!, issuer:values[1]!, audience:values[2]!, clientId:values[3]! }
}
export async function issue14EditorClientMatches(settings: EditorSettings, clientId: string): Promise<boolean> {
  if (settings.clientId) return clientId === settings.clientId
  if (!settings.clientDigest || !/^[0-9a-f]{64}$/.test(settings.clientDigest)) return false
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(clientId))
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('') === settings.clientDigest
}
export function issue14PreviewEnvironment<T extends Issue14PreviewScope>(env: T): T {
  if (!isIssue14Preview(env)) return env
  // Deliberately remove the binding, even if one was supplied. The Action
  // runtime fails closed for bound destinations whose service is unavailable.
  return { ...env, ACTIONS_READY: 'true', ACTION_ENDPOINTS: destination, ISSUE14_ACTION_RECEIVER: undefined }
}
