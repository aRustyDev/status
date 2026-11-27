/** Durable, per-identity mutation receipts. They contain no request or response body. */
export interface MutationIdentity { id: string; version: number; role: string }
export interface ReceiptContext {
  actor: MutationIdentity
  key: string
  storageKey: string
  hash: string
  expiresAt: number
  method: string
  path: string
  body: Record<string, unknown>
}
export interface Receipt {
  request_hash: string
  status: number
  result_id: string | null
  result_alias: number | null
  result_version: number | null
}
export class ReceiptError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message) }
}
const TTL = 24 * 60 * 60 * 1000
const SKEW = 5 * 60 * 1000
const KEY = /^(\d{13})\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i

export async function boundedBody(request: Request, clone = true, timeoutMs = 15_000): Promise<string> {
  const limit = 256_000, length = request.headers.get('content-length')
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) throw new ReceiptError(413, 'Request body too large')
  const stream = (clone ? request.clone() : request).body
  if (!stream) return ''
  const reader = stream.getReader(), chunks: Uint8Array[] = []
  const cancel = () => {
    void reader.cancel().catch(() => {})
    if (clone && request.body) void request.body.cancel().catch(() => {})
  }
  let size = 0, expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { expired = true; cancel(); reject(new ReceiptError(408, 'Request body timed out')) }, timeoutMs)
  })
  try {
    while (true) {
      const part = await Promise.race([reader.read(), timeout])
      if (expired) throw new ReceiptError(408, 'Request body timed out')
      if (part.done) break
      size += part.value.byteLength
      if (size > limit) { cancel(); throw new ReceiptError(413, 'Request body too large') }
      chunks.push(part.value)
    }
  } finally { if (timer) clearTimeout(timer); reader.releaseLock() }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(bytes)
}

export async function receiptContext(request: Request, actor: MutationIdentity, previewScope: string | null = null): Promise<ReceiptContext | null> {
  const key = request.headers.get('Idempotency-Key')
  if (!key) return null
  const match = KEY.exec(key)
  if (!match) throw new ReceiptError(400, 'Invalid idempotency key')
  const created = Number(match[1]), now = Date.now()
  if (created > now + SKEW || created + TTL <= now) throw new ReceiptError(409, 'The earlier save may have completed. Check the record before starting again.', 'IDEMPOTENCY_EXPIRED')
  const expectedActor = request.headers.get('Idempotency-Actor')
  if (!expectedActor || expectedActor !== actor.id) throw new ReceiptError(403, 'The signed-in account changed; refresh your session before saving')
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new ReceiptError(415, 'Expected application/json')
  const raw = await boundedBody(request)
  if (raw.length > 64_000) throw new ReceiptError(413, 'Request body too large')
  let body: unknown
  try { body = raw ? JSON.parse(raw) : {} } catch { throw new ReceiptError(400, 'Invalid JSON') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ReceiptError(400, 'Expected a JSON object')
  const url = new URL(request.url), path = url.pathname
  const bytes = new TextEncoder().encode(`${request.method}\n${path}${url.search}\n${raw}`)
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('')
  if (previewScope !== null && !/^[0-9a-f]{64}$/.test(previewScope)) throw new ReceiptError(503, 'Preview unavailable')
  const storageKey = previewScope ? `preview:${previewScope}:${key}` : key
  return { actor, key, storageKey, hash, expiresAt: created + TTL, method: request.method, path, body: body as Record<string, unknown> }
}

export async function findReceipt(db: D1Database, ctx: ReceiptContext): Promise<Receipt | null> {
  const row = await db.prepare(`SELECT r.request_hash,r.status,r.result_id,r.result_alias,r.result_version,
    u.version AS current_actor_version,u.role AS current_actor_role FROM mutation_receipts r JOIN users u ON u.id=r.actor_id
    WHERE r.actor_id=? AND r.request_key=?`).bind(ctx.actor.id, ctx.storageKey).first<Receipt & {current_actor_version:number;current_actor_role:string}>()
  if (!row) return null
  if (row.current_actor_version !== ctx.actor.version || row.current_actor_role !== ctx.actor.role) throw new ReceiptError(403, 'Identity changed; refresh and try again')
  if (row.request_hash !== ctx.hash) throw new ReceiptError(409, 'Idempotency key was already used for a different request')
  if (row.status < 200) throw new ReceiptError(503, 'Mutation receipt is incomplete')
  return row
}

/** Prefix and suffix run in the same D1 batch as the mutation and its audit. */
export function receiptClaim(db: D1Database, ctx: ReceiptContext, token: string): D1PreparedStatement {
  return db.prepare(`INSERT INTO mutation_receipts (actor_id,request_key,request_hash,actor_version,attempt_token,status,expires_at)
    VALUES (?,?,?,?,?,0,?)`).bind(ctx.actor.id, ctx.storageKey, ctx.hash, ctx.actor.version, token, ctx.expiresAt)
}

export function receiptFinish(db: D1Database, ctx: ReceiptContext, token: string, status: number, resultId: string, resultVersion: number,
  guardSql: string, guardValues: unknown[], aliasType?: string): D1PreparedStatement {
  const alias = aliasType ? '(SELECT alias FROM entity_aliases WHERE entity_type=? AND entity_id=?)' : 'NULL'
  return db.prepare(`UPDATE mutation_receipts SET status=CASE WHEN EXISTS (${guardSql}) THEN ? ELSE NULL END,
    result_id=?, result_version=?, result_alias=${alias} WHERE actor_id=? AND request_key=? AND attempt_token=?`)
    .bind(...guardValues, status, resultId, resultVersion, ...(aliasType ? [aliasType, resultId] : []), ctx.actor.id, ctx.storageKey, token)
}
