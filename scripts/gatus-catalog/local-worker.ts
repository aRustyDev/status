import { syncGatusCatalog } from '../../apps/worker/src/gatus-catalog'
import { validateGatusCatalog, type GatusCatalogEntry } from '../../apps/worker/src/gatus'

interface Env { DB: D1Database; PROVISION_TOKEN: string }
const MAX_BYTES = 262_144
let used = false

async function authorized(request: Request, token: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(token)) return false
  const value = request.headers.get('authorization') ?? ''
  if (!/^Bearer [0-9a-f]{64}$/.test(value)) return false
  const encoder = new TextEncoder()
  const expected = encoder.encode(`Bearer ${token}`)
  const actual = encoder.encode(value)
  return crypto.subtle.timingSafeEqual(expected, actual)
}

async function readCatalog(request: Request): Promise<GatusCatalogEntry[]> {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('content-type') ?? '')) throw new Error('Invalid catalog')
  const len = request.headers.get('content-length')
  if (len && (!/^\d+$/.test(len) || Number(len) > MAX_BYTES)) throw new Error('Invalid catalog')
  if (!request.body) throw new Error('Invalid catalog')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) throw new Error('Invalid catalog')
      chunks.push(value)
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const part of chunks) { bytes.set(part, offset); offset += part.length }
  const catalog: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes))
  if (!Array.isArray(catalog)) throw new Error('Invalid catalog')
  validateGatusCatalog(catalog)
  return catalog
}

/** Never deploy this Worker: the CLI runs it on loopback with a local or explicitly verified D1 binding. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.hostname !== '127.0.0.1' || url.pathname !== '/apply' || request.method !== 'POST') return new Response(null, { status: 404 })
    if (!await authorized(request, env.PROVISION_TOKEN)) return new Response(null, { status: 401 })
    if (used) return new Response(null, { status: 409 })
    let catalog: GatusCatalogEntry[]
    try { catalog = await readCatalog(request) } catch { return Response.json({ error: 'Invalid catalog' }, { status: 400 }) }
    // No concurrent caller, or a retry after an unknown outcome, may invoke a second sync.
    if (used) return new Response(null, { status: 409 })
    used = true
    try {
      await syncGatusCatalog(env.DB, catalog)
      return Response.json({ applied: catalog.length })
    } catch { return Response.json({ error: 'Catalog sync failed' }, { status: 500 }) }
  },
}
