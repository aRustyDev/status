import { boundedBody } from './idempotency'

/** Local credentials are write-only at the API boundary. Names are metadata, never credentials. */
type Actor = { id: string; email: string; version: number }
type Body = Record<string, unknown>
export class VaultError extends Error { constructor(readonly status: number, message: string) { super(message) } }
const fail = (status: number, message: string): never => { throw new VaultError(status, message) }
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })
export const vaultReady = (key: string | undefined): boolean => typeof key === 'string' && /^[0-9a-f]{64}$/i.test(key)
const statement = (db: D1Database, sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args)
const metadata = 'id, vault_id AS vaultId, name, type, created_at AS createdAt, updated_at AS updatedAt, version'
const vaultMetadata = "id, name, 'local' AS type, created_at AS createdAt, updated_at AS updatedAt"
function randomId(): number {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return bytes.reduce((id, byte) => id * 256 + byte, 0) || 1
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) return fail(400, 'Invalid name')
  return value.trim()
}
function payload(body: Body, type: string): string {
  let data: unknown
  if (type === 'value') {
    if (typeof body.value !== 'string' || !body.value || body.value.length > 16000) return fail(400, 'Invalid secret value')
    data = { value: body.value }
  } else if (type === 'userpass') {
    const up = body.userpass
    if (!up || typeof up !== 'object' || Array.isArray(up) || Object.keys(up).some(k => !['username','password'].includes(k))) return fail(400, 'Invalid credentials')
    const {username, password} = up as Body
    if (typeof username !== 'string' || !username || username.length > 8000 || typeof password !== 'string' || !password || password.length > 8000) return fail(400, 'Invalid credentials')
    data = { username, password }
  } else if (type === 'json') {
    if (typeof body.json !== 'string' || body.json.length > 16000) return fail(400, 'Invalid JSON secret')
    try { data = JSON.parse(body.json) } catch { return fail(400, 'Invalid JSON secret') }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return fail(400, 'Invalid JSON secret')
  } else return fail(400, 'Invalid secret type')
  return JSON.stringify(data)
}
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
async function encrypt(key: string, vaultId: number, secretId: number, type: string, plain: string) {
  const raw = new Uint8Array(key.match(/../g)!.map(hex => parseInt(hex, 16)))
  const cipherKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt'])
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const aad = new TextEncoder().encode(`status-vault-v1:${vaultId}:${secretId}:${type}`)
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM', iv:nonce, additionalData:aad}, cipherKey, new TextEncoder().encode(plain)))
  return { nonce: b64(nonce), ciphertext: b64(ciphertext) }
}
/** Persist a random authenticated sentinel once; concurrent initializers read the winner. */
export async function vaultKeyReady(db: D1Database, key: string | undefined): Promise<boolean> {
  if (!vaultReady(key)) return false
  try {
    let row = await db.prepare('SELECT nonce,ciphertext FROM vault_key_verifier WHERE id=1').first<{nonce:string;ciphertext:string}>()
    if (!row) {
      // Never bind a new key over existing ciphertext if the verifier is lost.
      const existing = await db.prepare('SELECT 1 AS present FROM vault_secrets LIMIT 1').first()
      if (existing) return false
      const sealed = await encrypt(key!, 0, 0, 'key-check', 'status-vault-key-verifier-v1')
      await statement(db, 'INSERT OR IGNORE INTO vault_key_verifier (id,nonce,ciphertext) VALUES (1,?,?)', sealed.nonce, sealed.ciphertext).run()
      row = await db.prepare('SELECT nonce,ciphertext FROM vault_key_verifier WHERE id=1').first<{nonce:string;ciphertext:string}>()
    }
    if (!row) return false
    const raw = new Uint8Array(key!.match(/../g)!.map(hex => parseInt(hex, 16)))
    const cipherKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt'])
    const bytes = (text: string) => Uint8Array.from(atob(text), character => character.charCodeAt(0))
    const plain = await crypto.subtle.decrypt({name:'AES-GCM', iv:bytes(row.nonce), additionalData:new TextEncoder().encode('status-vault-v1:0:0:key-check')}, cipherKey, bytes(row.ciphertext))
    return new TextDecoder().decode(plain) === 'status-vault-key-verifier-v1'
  } catch { return false }
}
const id = (value: string | undefined): number => {
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) return fail(404, 'Not found')
  return Number(value)
}
async function readBody(request: Request): Promise<Body> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return fail(415, 'Expected application/json')
  const text = await boundedBody(request, false)
  if (text.length > 32000) return fail(413, 'Request body too large')
  try { const value: unknown = JSON.parse(text); if (value && typeof value === 'object' && !Array.isArray(value)) return value as Body } catch { /* generic */ }
  return fail(400, 'Invalid JSON')
}
function audit(db: D1Database, actor: Actor, action: string, entity: string, entityId: number) {
  return statement(db, `INSERT INTO audit_events (id,actor_email,action,entity_type,entity_id,created_at,details) VALUES (?,?,?,?,?,?,CASE WHEN EXISTS (SELECT 1 FROM users WHERE id=? AND role='admin' AND version=?) THEN '{}' ELSE NULL END)`, crypto.randomUUID(), actor.email, action, entity, String(entityId), Date.now(), actor.id, actor.version)
}
function auditExisting(db: D1Database, actor: Actor, entity: 'vault' | 'vault_secret', entityId: number, vaultId: number) {
  const exists = entity === 'vault' ? 'SELECT 1 FROM vaults WHERE id=?' : 'SELECT 1 FROM vault_secrets WHERE id=? AND vault_id=?'
  return statement(db, `INSERT INTO audit_events (id,actor_email,action,entity_type,entity_id,created_at,details) SELECT ?,?,?,?,?,?,CASE WHEN EXISTS (SELECT 1 FROM users WHERE id=? AND role='admin' AND version=?) THEN '{}' ELSE NULL END WHERE EXISTS (${exists})`, crypto.randomUUID(),actor.email,'delete',entity,String(entityId),Date.now(),actor.id,actor.version,entityId,...(entity === 'vault_secret' ? [vaultId] : []))
}
/** Called only after Access authentication, admin authorization and same-origin enforcement. */
export async function vaultApi(request: Request, db: D1Database, key: string | undefined, actor: Actor, route: string): Promise<Response> {
  if (!(await vaultKeyReady(db,key))) return fail(503, 'Vault is unavailable')
  const suffix = route.slice('/admin/vaults'.length)
  const parts = suffix ? suffix.slice(1).split('/') : []
  if (parts.some(part => !part)) return fail(404, 'Not found')
  const method = request.method
  if (!parts.length && method === 'GET') return json((await db.prepare(`SELECT ${vaultMetadata} FROM vaults ORDER BY name,id`).all()).results)
  if (!parts.length && method === 'POST') {
    const body = await readBody(request)
    if (Object.keys(body).some(k => !['name','type'].includes(k)) || (body.type !== undefined && body.type !== 'local')) return fail(400, 'Unsupported vault provider')
    const vaultId = randomId(), now = Date.now()
    await db.batch([statement(db, 'INSERT INTO vaults (id,name,created_at,updated_at) VALUES (?,?,?,?)', vaultId,name(body.name),now,now), audit(db,actor,'create','vault',vaultId)])
    return json(await statement(db, `SELECT ${vaultMetadata} FROM vaults WHERE id=?`,vaultId).first(),201)
  }
  const vaultId = id(parts[0])
  if (!(await statement(db,'SELECT id FROM vaults WHERE id=?',vaultId).first())) return fail(404,'Not found')
  if (parts.length === 1 && method === 'DELETE') {
    const results = await db.batch([auditExisting(db,actor,'vault',vaultId,vaultId),statement(db,'DELETE FROM vaults WHERE id=?',vaultId)])
    if (!results[1].meta.changes) return fail(404,'Not found')
    return json({ok:true})
  }
  if (parts[1] !== 'secrets' || parts.length > 3) return fail(404,'Not found')
  if (parts.length === 2 && method === 'GET') return json((await statement(db,`SELECT ${metadata} FROM vault_secrets WHERE vault_id=? ORDER BY name,id`,vaultId).all()).results)
  if (parts.length === 2 && method === 'POST') {
    const body = await readBody(request), type = body.type
    if (typeof type !== 'string' || Object.keys(body).some(k => !['name','type','value','userpass','json'].includes(k))) return fail(400,'Invalid secret')
    const secretId = randomId(), now = Date.now(), encrypted = await encrypt(key!,vaultId,secretId,type,payload(body,type))
    await db.batch([statement(db,'INSERT INTO vault_secrets (id,vault_id,name,type,ciphertext,nonce,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',secretId,vaultId,name(body.name),type,encrypted.ciphertext,encrypted.nonce,now,now),audit(db,actor,'create','vault_secret',secretId)])
    return json(await statement(db,`SELECT ${metadata} FROM vault_secrets WHERE id=?`,secretId).first(),201)
  }
  const secretId = id(parts[2])
  const current = await statement(db,'SELECT type,version FROM vault_secrets WHERE id=? AND vault_id=?',secretId,vaultId).first<{type:string;version:number}>()
  if (!current) return fail(404,'Not found')
  if (method === 'DELETE') {
    const body = await readBody(request)
    if (Object.keys(body).some(k => k !== 'version') || !Number.isSafeInteger(body.version)) return fail(400,'Invalid version')
    if (body.version !== current.version) return fail(409,'Secret changed. Reload and try again.')
    const results = await db.batch([
      statement(db, `INSERT INTO audit_events (id,actor_email,action,entity_type,entity_id,created_at,details) SELECT ?,?,?,?,?,?,CASE WHEN EXISTS (SELECT 1 FROM users WHERE id=? AND role='admin' AND version=?) THEN '{}' ELSE NULL END WHERE EXISTS (SELECT 1 FROM vault_secrets WHERE id=? AND vault_id=? AND version=?)`,crypto.randomUUID(),actor.email,'delete','vault_secret',String(secretId),Date.now(),actor.id,actor.version,secretId,vaultId,current.version),
      statement(db,'DELETE FROM vault_secrets WHERE id=? AND vault_id=? AND version=?',secretId,vaultId,current.version),
    ])
    if (!results[1].meta.changes) return fail(409,'Secret changed. Reload and try again.')
    return json({ok:true})
  }
  if (method === 'PATCH') {
    const body = await readBody(request)
    if (!Number.isSafeInteger(body.version) || body.version !== current.version) return fail(409,'Secret changed. Reload and try again.')
    if (Object.keys(body).some(k => !['version','value','userpass','json'].includes(k))) return fail(400,'Invalid secret')
    const encrypted = await encrypt(key!,vaultId,secretId,current.type,payload(body,current.type))
    const results = await db.batch([statement(db,'UPDATE vault_secrets SET ciphertext=?,nonce=?,updated_at=?,version=version+1 WHERE id=? AND vault_id=? AND version=?',encrypted.ciphertext,encrypted.nonce,Date.now(),secretId,vaultId,current.version), statement(db, `INSERT INTO audit_events (id,actor_email,action,entity_type,entity_id,created_at,details) SELECT ?,?,?,?,?,?,CASE WHEN EXISTS (SELECT 1 FROM users WHERE id=? AND role='admin' AND version=?) THEN '{}' ELSE NULL END WHERE EXISTS (SELECT 1 FROM vault_secrets WHERE id=? AND vault_id=? AND version=? AND nonce=?)`,crypto.randomUUID(),actor.email,'rotate','vault_secret',String(secretId),Date.now(),actor.id,actor.version,secretId,vaultId,current.version+1,encrypted.nonce)])
    if (!results[0].meta.changes) return fail(409,'Secret changed. Reload and try again.')
    return json(await statement(db,`SELECT ${metadata} FROM vault_secrets WHERE id=?`,secretId).first())
  }
  return fail(404,'Not found')
}
