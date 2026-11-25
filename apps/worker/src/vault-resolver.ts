import { vaultKeyReady } from './vault'

/**
 * Private, in-process runtime capability. Callers must only use these functions
 * while executing the identified persisted integration; never expose them via
 * an HTTP route. Workers holding the key and DB binding are trusted callers.
 * Resolution never accepts a vault reference supplied in a job or request.
 */
type Reference = { vaultId: number; secretId: number }
type StoredSecret = { type: string; nonce: string; ciphertext: string }
export type MonitorCredential = { username: string; password: string }

function reference(value: unknown): Reference | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const ref = value as Record<string, unknown>
  if (Object.keys(ref).some(key => key !== 'vaultId' && key !== 'secretId') ||
      !Number.isSafeInteger(ref.vaultId) || Number(ref.vaultId) < 1 ||
      !Number.isSafeInteger(ref.secretId) || Number(ref.secretId) < 1) return null
  return { vaultId: Number(ref.vaultId), secretId: Number(ref.secretId) }
}

async function decrypt(db: D1Database, key: string | undefined, ref: Reference, expectedType: 'value' | 'userpass'): Promise<Record<string, unknown> | null> {
  try {
    if (!await vaultKeyReady(db, key)) return null
    const row = await db.prepare('SELECT type,nonce,ciphertext FROM vault_secrets WHERE id=? AND vault_id=? AND type=?')
      .bind(ref.secretId, ref.vaultId, expectedType).first<StoredSecret>()
    if (!row || row.type !== expectedType) return null
    const rawKey = new Uint8Array(key!.match(/../g)!.map(hex => parseInt(hex, 16)))
    const cipherKey = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt'])
    const bytes = (text: string) => Uint8Array.from(atob(text), character => character.charCodeAt(0))
    const additionalData = new TextEncoder().encode(`status-vault-v1:${ref.vaultId}:${ref.secretId}:${expectedType}`)
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(row.nonce), additionalData }, cipherKey, bytes(row.ciphertext))
    const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext))
    return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null
  } catch {
    // Neither provider errors nor the decrypted plaintext belong in logs or responses.
    return null
  }
}

/** Resolve only the Basic credential configured on this exact saved check version. */
export async function resolveMonitorCredential(db: D1Database, key: string | undefined, checkId: string, configVersion: number): Promise<MonitorCredential | null> {
  if (!checkId || !Number.isSafeInteger(configVersion) || configVersion < 1) return null
  try {
    const row = await db.prepare('SELECT advanced_config FROM http_checks WHERE id=? AND config_version=?')
      .bind(checkId, configVersion).first<{advanced_config:string | null}>()
    if (!row?.advanced_config) return null
    const config: unknown = JSON.parse(row.advanced_config)
    if (!config || typeof config !== 'object' || Array.isArray(config)) return null
    const auth = (config as Record<string, unknown>).auth
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return null
    const { type, basic } = auth as Record<string, unknown>
    if (type !== 'basic' || !basic || typeof basic !== 'object' || Array.isArray(basic)) return null
    const ref = reference((basic as Record<string, unknown>).vault)
    if (!ref) return null
    const result = await decrypt(db, key, ref, 'userpass')
    if (!result || Object.keys(result).some(field => field !== 'username' && field !== 'password') ||
        typeof result.username !== 'string' || !result.username || typeof result.password !== 'string' || !result.password) return null
    return { username: result.username, password: result.password }
  } catch { return null }
}

/** Resolve only the value credential configured on this exact saved channel version. */
export async function resolveChannelCredential(db: D1Database, key: string | undefined, channelId: string, version: number): Promise<string | null> {
  if (!channelId || !Number.isSafeInteger(version) || version < 1) return null
  try {
    const row = await db.prepare('SELECT vault_id,secret_id FROM notification_channels WHERE id=? AND version=?')
      .bind(channelId, version).first<{vault_id:unknown;secret_id:unknown}>()
    if (!row) return null
    const ref = reference({ vaultId: row.vault_id, secretId: row.secret_id })
    if (!ref) return null
    const result = await decrypt(db, key, ref, 'value')
    if (!result || Object.keys(result).some(field => field !== 'value') || typeof result.value !== 'string' || !result.value) return null
    return result.value
  } catch { return null }
}

/** Resolve only the value credential configured on this exact saved action version. */
export async function resolveActionCredential(db: D1Database, key: string | undefined, actionId: string, version: number): Promise<string | null> {
  if (!actionId || !Number.isSafeInteger(version) || version < 1) return null
  try {
    const row = await db.prepare('SELECT vault_id,secret_id FROM worker_actions WHERE id=? AND version=?')
      .bind(actionId, version).first<{vault_id:unknown;secret_id:unknown}>()
    if (!row) return null
    const ref = reference({ vaultId: row.vault_id, secretId: row.secret_id })
    if (!ref) return null
    const result = await decrypt(db, key, ref, 'value')
    if (!result || Object.keys(result).some(field => field !== 'value') || typeof result.value !== 'string' || !result.value) return null
    return result.value
  } catch { return null }
}
