import { vaultKeyReady } from './vault'

/**
 * Private, in-process runtime capability. Callers must only use these functions
 * while executing the identified persisted integration; never expose them via
 * an HTTP route. Workers holding the key and DB binding are trusted callers.
 * Resolution never accepts a vault reference supplied in a job or request.
 */
type Reference = { vaultId: number; secretId: number }
type StoredSecret = { type: string; nonce: string; ciphertext: string; version: number }
type DecryptedSecret = { data: Record<string, unknown>; version: number; nonce: string }
export type ValueCredentialSnapshot = { value: string; vaultId: number; secretId: number; version: number; nonce: string }
export type MonitorCredential = { username: string; password: string }
export type MonitorCredentialSnapshot = MonitorCredential & { vaultId: number; secretId: number; version: number; nonce: string }

function reference(value: unknown): Reference | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const ref = value as Record<string, unknown>
  if (Object.keys(ref).some(key => key !== 'vaultId' && key !== 'secretId') ||
      !Number.isSafeInteger(ref.vaultId) || Number(ref.vaultId) < 1 ||
      !Number.isSafeInteger(ref.secretId) || Number(ref.secretId) < 1) return null
  return { vaultId: Number(ref.vaultId), secretId: Number(ref.secretId) }
}

async function decrypt(db: D1Database, key: string | undefined, ref: Reference, expectedType: 'value' | 'userpass'): Promise<DecryptedSecret | null> {
  try {
    if (!await vaultKeyReady(db, key)) return null
    const row = await db.prepare('SELECT type,nonce,ciphertext,version FROM vault_secrets WHERE id=? AND vault_id=? AND type=?')
      .bind(ref.secretId, ref.vaultId, expectedType).first<StoredSecret>()
    if (!row || row.type !== expectedType) return null
    const rawKey = new Uint8Array(key!.match(/../g)!.map(hex => parseInt(hex, 16)))
    const cipherKey = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt'])
    const bytes = (text: string) => Uint8Array.from(atob(text), character => character.charCodeAt(0))
    const additionalData = new TextEncoder().encode(`status-vault-v1:${ref.vaultId}:${ref.secretId}:${expectedType}`)
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(row.nonce), additionalData }, cipherKey, bytes(row.ciphertext))
    const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext))
    return data && typeof data === 'object' && !Array.isArray(data) && Number.isSafeInteger(row.version) ? { data: data as Record<string, unknown>, version: row.version, nonce: row.nonce } : null
  } catch {
    // Neither provider errors nor the decrypted plaintext belong in logs or responses.
    return null
  }
}

/** Resolve only the authentication credential configured on this exact saved check version. */
export async function resolveMonitorCredentialSnapshot(db: D1Database, key: string | undefined, checkId: string, configVersion: number): Promise<MonitorCredentialSnapshot | null> {
  if (!checkId || !Number.isSafeInteger(configVersion) || configVersion < 1) return null
  try {
    const row = await db.prepare('SELECT advanced_config FROM http_checks WHERE id=? AND config_version=?')
      .bind(checkId, configVersion).first<{advanced_config:string | null}>()
    if (!row?.advanced_config) return null
    const config: unknown = JSON.parse(row.advanced_config)
    if (!config || typeof config !== 'object' || Array.isArray(config)) return null
    const auth = (config as Record<string, unknown>).auth
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return null
    const record = auth as Record<string, unknown>
    const type = record.type
    if (type !== 'basic' && type !== 'oauth2' && type !== 'cas') return null
    const section = record[type]
    if (!section || typeof section !== 'object' || Array.isArray(section)) return null
    const ref = reference((section as Record<string, unknown>).vault)
    if (!ref) return null
    const decrypted = await decrypt(db, key, ref, 'userpass')
    const result = decrypted?.data
    if (!result || Object.keys(result).some(field => field !== 'username' && field !== 'password') ||
        typeof result.username !== 'string' || !result.username || typeof result.password !== 'string' || !result.password) return null
    return { username: result.username, password: result.password, ...ref, version: decrypted.version, nonce: decrypted.nonce }
  } catch { return null }
}

/** Resolve Secure Values only from the persisted configuration of this exact check. */
export async function resolveMonitorHeaderSnapshots(db: D1Database, key: string | undefined, checkId: string, configVersion: number): Promise<Record<string, ValueCredentialSnapshot> | null> {
  if (!checkId || !Number.isSafeInteger(configVersion) || configVersion < 1) return null
  try {
    const row = await db.prepare('SELECT advanced_config FROM http_checks WHERE id=? AND config_version=?')
      .bind(checkId, configVersion).first<{advanced_config:string | null}>()
    if (!row?.advanced_config) return null
    const config: unknown = JSON.parse(row.advanced_config)
    if (!config || typeof config !== 'object' || Array.isArray(config)) return null
    const headers = (config as Record<string, unknown>).vaultHeaders
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return null
    const snapshots: Record<string, ValueCredentialSnapshot> = {}
    for (const [name, value] of Object.entries(headers)) {
      const ref = reference(value)
      if (!ref) return null
      const decrypted = await decrypt(db, key, ref, 'value')
      const data = decrypted?.data
      if (!data || Object.keys(data).some(field => field !== 'value') || typeof data.value !== 'string' || !data.value) return null
      snapshots[name] = { value: data.value, ...ref, version: decrypted.version, nonce: decrypted.nonce }
    }
    return snapshots
  } catch { return null }
}

/** String-only convenience for non-transport callers. */
export async function resolveMonitorCredential(db: D1Database, key: string | undefined, checkId: string, configVersion: number): Promise<MonitorCredential | null> {
  const snapshot = await resolveMonitorCredentialSnapshot(db, key, checkId, configVersion)
  return snapshot ? { username: snapshot.username, password: snapshot.password } : null
}

/** Resolve a scoped saved value and the exact encrypted record used to produce it. */
async function valueCredential(db: D1Database, key: string | undefined, table: 'notification_channels' | 'worker_actions', integrationId: string, version: number): Promise<ValueCredentialSnapshot | null> {
  if (!integrationId || !Number.isSafeInteger(version) || version < 1) return null
  try {
    const row = await db.prepare(`SELECT vault_id,secret_id FROM ${table} WHERE id=? AND version=?`)
      .bind(integrationId, version).first<{vault_id:unknown;secret_id:unknown}>()
    if (!row) return null
    const ref = reference({ vaultId: row.vault_id, secretId: row.secret_id })
    if (!ref) return null
    const decrypted = await decrypt(db, key, ref, 'value')
    const result = decrypted?.data
    if (!result || Object.keys(result).some(field => field !== 'value') || typeof result.value !== 'string' || !result.value) return null
    return { value: result.value, ...ref, version: decrypted.version, nonce: decrypted.nonce }
  } catch { return null }
}

/** Snapshot is private to an in-process delivery; never expose it through an API. */
export async function resolveChannelCredentialSnapshot(db: D1Database, key: string | undefined, channelId: string, version: number): Promise<ValueCredentialSnapshot | null> {
  return valueCredential(db, key, 'notification_channels', channelId, version)
}
export async function resolveActionCredentialSnapshot(db: D1Database, key: string | undefined, actionId: string, version: number): Promise<ValueCredentialSnapshot | null> {
  return valueCredential(db, key, 'worker_actions', actionId, version)
}

// Keep the existing string-only API for non-delivery callers.
export async function resolveChannelCredential(db: D1Database, key: string | undefined, channelId: string, version: number): Promise<string | null> {
  return (await resolveChannelCredentialSnapshot(db, key, channelId, version))?.value ?? null
}
export async function resolveActionCredential(db: D1Database, key: string | undefined, actionId: string, version: number): Promise<string | null> {
  return (await resolveActionCredentialSnapshot(db, key, actionId, version))?.value ?? null
}
