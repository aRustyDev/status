import { vaultKeyReady } from '../worker/src/vault'
import { isIssue14Preview } from './issue14-preview'

// This module is intentionally limited to one disposable schema preview.
const marker = 'issue14-isolated-vault-fixture-v1'
const vaultId = 238010605399733
const secretId = 218386432287168
const dummyValue = 'isolated-preview-dummy-value'

type FixtureEnv = {
  DB: D1Database
  API_SCOPE?: string
  PREVIEW_SUBSCRIBER_REQUIRED?: string
  PREVIEW_SUBSCRIBER_SCOPE?: string
  PREVIEW_RELEASE?: string
  VAULT_ENCRYPTION_KEY?: string
}
type Actor = { id: string; role: string; version: number }

/** Initialize once only, after an authorized admin has been authenticated. */
export async function ensureIssue14VaultFixture(env: FixtureEnv, actor: Actor): Promise<boolean> {
  if (!isIssue14Preview(env) || actor.role !== 'admin') return false
  try {
    const authorized = await env.DB.prepare("SELECT 1 FROM users WHERE id=? AND role='admin' AND version=?").bind(actor.id, actor.version).first()
    if (!authorized) return false
    const existing = await env.DB.prepare('SELECT entity_id FROM audit_events WHERE id=?').bind(marker).first()
    if (existing) return true
    const occupied = await env.DB.prepare('SELECT EXISTS (SELECT 1 FROM vaults) OR EXISTS (SELECT 1 FROM vault_secrets) AS occupied').first<{occupied:number}>()
    if (!occupied || occupied.occupied || !await vaultKeyReady(env.DB, env.VAULT_ENCRYPTION_KEY)) return false

    const key = env.VAULT_ENCRYPTION_KEY!
    const raw = new Uint8Array(key.match(/../g)!.map(hex => parseInt(hex, 16)))
    const cipherKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt'])
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    const aad = new TextEncoder().encode(`status-vault-v1:${vaultId}:${secretId}:value`)
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, cipherKey, new TextEncoder().encode(JSON.stringify({ value: dummyValue }))))
    const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
    const runId = crypto.randomUUID()
    const now = Date.now()
    // The marker and fixture are created atomically. A unique run ID prevents
    // a racing initializer from writing against another initializer's marker.
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO audit_events (id,actor_email,action,entity_type,entity_id,created_at,details)
        SELECT ?, 'preview-fixture@invalid', 'initialize', 'preview_fixture', ?, ?, '{}'
        WHERE NOT EXISTS (SELECT 1 FROM vaults) AND NOT EXISTS (SELECT 1 FROM vault_secrets)
          AND EXISTS (SELECT 1 FROM users WHERE id=? AND role='admin' AND version=?)`).bind(marker, runId, now, actor.id, actor.version),
      env.DB.prepare(`INSERT INTO vaults (id,name,created_at,updated_at)
        SELECT ?, 'Issue 14 isolated preview', ?, ? WHERE EXISTS (SELECT 1 FROM audit_events WHERE id=? AND entity_id=?)`).bind(vaultId, now, now, marker, runId),
      env.DB.prepare(`INSERT INTO vault_secrets (id,vault_id,name,type,ciphertext,nonce,created_at,updated_at)
        SELECT ?, ?, 'Synthetic preview token', 'value', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM audit_events WHERE id=? AND entity_id=?)`).bind(secretId, vaultId, base64(encrypted), base64(nonce), now, now, marker, runId),
    ])
    return Boolean(results[0]?.meta.changes) || Boolean(await env.DB.prepare('SELECT 1 FROM audit_events WHERE id=?').bind(marker).first())
  } catch {
    // Do not leak key material or ciphertext in errors or HTTP responses.
    return false
  }
}
