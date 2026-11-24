/** A browser intent stores only a random key and a body fingerprint, never form values. */
export interface MutationIntent { key: string; slot: string; actor: string }
export class PendingMutationError extends Error {
  constructor(readonly intent: MutationIntent, readonly inFlight: boolean) {
    super(inFlight ? 'An earlier save is still in progress. Wait for it to finish.' : 'An earlier save may have completed. Check the relevant record before starting another.')
  }
}
const flights = new Map<string, { count: number; success: boolean; failure: boolean; ambiguous: boolean; priorAmbiguous: boolean }>()
let actor: string | null = null
let clockOffset = 0

/** Set only from a verified /auth/me response, and update after account switching. */
export function setMutationActor(value: string | null, serverTime?: number): void {
  actor = value
  clockOffset = typeof serverTime === 'number' && Number.isFinite(serverTime) ? serverTime - Date.now() : 0
}

function fingerprint(value: string): string {
  let a = 2166136261, b = 0x9e3779b9
  for (let i = 0; i < value.length; i++) { a = Math.imul(a ^ value.charCodeAt(i), 16777619); b = Math.imul(b ^ value.charCodeAt(i), 2246822519) }
  return `${a >>> 0}-${b >>> 0}-${value.length}`
}
function read(slot: string): string | null {
  try { return sessionStorage.getItem(slot) } catch { throw new Error('Browser session storage is required to safely save changes') }
}
function write(slot: string, value: string): void {
  try { sessionStorage.setItem(slot, value) } catch { throw new Error('Browser session storage is required to safely save changes') }
}
function remove(slot: string): void {
  try { sessionStorage.removeItem(slot) } catch { throw new Error('Browser session storage is required to safely save changes') }
}
function randomUuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
}

function supported(method: string, path: string): boolean {
  if (method === 'POST' && /^\/admin\/(components|checks|incidents|maintenance|monitors)$/.test(path)) return true
  if (method === 'POST' && /^\/admin\/(incidents\/[^/]+\/(publish|updates)|maintenance\/[^/]+\/(cancel|end))$/.test(path)) return true
  if (method === 'PATCH' && /^\/admin\/(components|checks|incidents|maintenance|users|monitors)\/[^/]+$/.test(path)) return true
  return method === 'PUT' && /^\/admin\/checks\/[^/]+\/advanced$/.test(path)
}

/** Preserve one request's key across expiry, network failure and ambiguous server errors. */
export function beginMutationIntent(method: string, path: string, serializedBody: string, contract: 'bsp' | 'legacy'): MutationIntent | null {
  if (!supported(method, path)) return null
  if (!actor) throw new Error('Verify your signed-in account before saving')
  const bodyHash = fingerprint(serializedBody), prefix = `bsp-mutation:${fingerprint(actor)}:${contract}:${method}:${path}:`, slot = `${prefix}${bodyHash}`
  if (method === 'POST' && /^\/admin\/(components|checks|incidents|maintenance|monitors)$/.test(path)) {
    try {
      for (let index = 0; index < sessionStorage.length; index++) {
        const other = sessionStorage.key(index)
        if (!other?.startsWith(prefix) || other === slot) continue
        const previous = JSON.parse(read(other) ?? 'null') as {key?:string} | null
        if (previous?.key) throw new PendingMutationError({ key: previous.key, slot: other, actor }, (flights.get(previous.key)?.count ?? 0) > 0)
      }
    } catch (error) {
      if (error instanceof PendingMutationError) throw error
      throw new Error('Browser session storage is required to safely save changes', { cause: error })
    }
  }
  const saved = read(slot)
  try {
    const previous = JSON.parse(saved ?? 'null') as { hash?: string; key?: string } | null
    if (previous?.hash === bodyHash && typeof previous.key === 'string') return track({ key: previous.key, slot, actor })
    if (saved !== null) throw new Error('Pending save state is invalid. Check the record before starting again.')
  } catch { throw new Error('Pending save state is invalid. Check the record before starting again.') }
  const key = `${Math.round(Date.now() + clockOffset)}.${randomUuid()}`
  write(slot, JSON.stringify({ hash: bodyHash, key, ambiguous: false }))
  return track({ key, slot, actor })
}

function track(intent: MutationIntent): MutationIntent {
  const saved = read(intent.slot)
  let stored: { key?: string; hash?: string; ambiguous?: boolean } | null
  try { stored = JSON.parse(saved ?? 'null') as typeof stored } catch { throw new Error('Pending save state is invalid. Check the record before starting again.') }
  if (stored?.key !== intent.key) throw new Error('Pending save state changed. Check the record before starting again.')
  const flight = flights.get(intent.key) ?? { count: 0, success: false, failure: false, ambiguous: false, priorAmbiguous: stored.ambiguous === true }
  // Persist uncertainty before fetch: a tab can crash after the server commits but before a response arrives.
  write(intent.slot, JSON.stringify({ ...stored, ambiguous: true }))
  flight.count++; flights.set(intent.key, flight)
  return intent
}

export function finishMutationIntent(intent: MutationIntent | null, status: number): void {
  if (!intent) return
  const saved = read(intent.slot)
  let stored: { key?: string; ambiguous?: boolean; hash?: string } | null
  try { stored = JSON.parse(saved ?? 'null') as typeof stored } catch { throw new Error('Pending save state is invalid. Check the record before starting again.') }
  const flight = flights.get(intent.key)
  if (flight) { flight.count--; if (status >= 200 && status < 300) flight.success = true; else flight.failure = true; if (status === 0 || status >= 500) flight.ambiguous = true }
  if (stored?.key !== intent.key) { if (flight && flight.count <= 0) flights.delete(intent.key); return }
  if (flight && flight.count > 0) return
  if (flight) flights.delete(intent.key)
  if (status >= 200 && status < 300 && !flight?.failure || (!flight?.priorAmbiguous && !flight?.ambiguous && !flight?.success && [400,403,404,405,413,415,422].includes(status))) remove(intent.slot)
}

/** Called only after the operator explicitly confirms they checked the earlier result. */
export function abandonMutationIntent(intent: MutationIntent): void {
  if ((flights.get(intent.key)?.count ?? 0) > 0) throw new Error('An earlier save is still in progress. Wait for it to finish.')
  const saved = read(intent.slot)
  try { if ((JSON.parse(saved ?? 'null') as { key?: string } | null)?.key === intent.key) remove(intent.slot) }
  catch (error) { if (error instanceof Error && error.message.includes('session storage is required')) throw error }
}

/** A deadline covers both fetching and consuming the response body. */
export async function fetchMutationResponse(input: string, init: RequestInit, bounded: boolean, timeoutMs = 20_000): Promise<{response:Response; body:unknown}> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let expired = false
  const send = async () => {
    const response = await fetch(input, bounded ? { ...init, signal: controller.signal } : init)
    const body = response.status === 204 ? undefined : response.ok ? await response.json() : await response.json().catch(() => null)
    return { response, body }
  }
  if (!bounded) return send()
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; controller.abort(); reject(new Error('Request timed out')) }, timeoutMs) })
  try {
    const result = await Promise.race([send(), deadline])
    if (expired) throw new Error('Request timed out')
    return result
  } finally { if (timer) clearTimeout(timer) }
}
