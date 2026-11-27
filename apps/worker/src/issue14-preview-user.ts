import { isIssue14Preview, type Issue14PreviewScope } from '../../gateway/issue14-preview'

const principalDigest = '7d49cfe609b72e212360017e56aea4f61eb633f3211d91c9fb2f3e3444ebe8f8'
const marker = 'issue14-preview-admin-bootstrap'
type Identity = { id: string; issuer: string; subject: string }

// Called only after Access JWT validation. The transaction records the one-time
// grant; a later demotion or an already modified user is never overwritten.
export async function bootstrapPreviewUser(env: Issue14PreviewScope & { DB: D1Database }, user: Identity, expectedDigest = principalDigest): Promise<boolean> {
  if (!isIssue14Preview(env)) return false
  const bytes = new TextEncoder().encode(JSON.stringify([user.issuer, user.subject]))
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('')
  if (digest !== expectedDigest) return false
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET role='admin',version=version+1 WHERE id=? AND issuer=? AND subject=? AND role='viewer' AND version=1 AND NOT EXISTS (SELECT 1 FROM audit_events WHERE id=?)").bind(user.id,user.issuer,user.subject,marker),
    env.DB.prepare("INSERT OR IGNORE INTO audit_events (id,actor_email,action,entity_type,entity_id,created_at,details) SELECT ?,email,'update','preview_fixture_admin',id,?,'{}' FROM users WHERE id=? AND issuer=? AND subject=? AND role='admin' AND version=2").bind(marker,Date.now(),user.id,user.issuer,user.subject),
  ])
  return true
}
