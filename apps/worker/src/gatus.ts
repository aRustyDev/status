/** Read-only Gatus snapshot adapter. Gatus remains responsible for checks and alerts. */
export type GatusKind = 'endpoint' | 'suite'
export type GatusHealth = 'up' | 'down' | 'degraded' | 'pending'
export interface GatusCatalogEntry {
  kind: GatusKind
  key: string
  name: string
  group: string
  /** Explicit maximum age for a result, supplied independently from Gatus's status API. */
  staleAfterSeconds: number
  advisory: boolean
}
export interface GatusMonitor {
  /** Stable, namespaced identity; persistence/number aliases are the caller's responsibility. */
  sourceId: string
  name: string
  group: string
  kind: GatusKind
  health: GatusHealth
  lastCheckedAt: number | null
  durationMs: number | null
}
export interface GatusSnapshot {
  monitors: GatusMonitor[]
  /** False if either upstream endpoint failed or returned invalid or ambiguous data. */
  available: boolean
}
export interface GatusBinding { fetch(request: Request): Promise<Response> }

const MAX_BODY_BYTES = 1_048_576
const MAX_CATALOG_ENTRIES = 500
const MAX_RESULTS_PER_MONITOR = 1
const MAX_FUTURE_SKEW_MS = 60_000
const DEFAULT_TIMEOUT_MS = 5000
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
export const gatusSourceId = (entry: Pick<GatusCatalogEntry, 'kind' | 'group' | 'name'>) =>
  JSON.stringify(['gatus', entry.kind, entry.group, entry.name])

export function validateGatusCatalog(catalog: readonly GatusCatalogEntry[]): void {
  if (!Array.isArray(catalog) || catalog.length === 0 || catalog.length > MAX_CATALOG_ENTRIES) throw new Error('Invalid Gatus catalog')
  const identities = new Set<string>()
  const keys = new Set<string>()
  for (const entry of catalog) {
    if (!entry || typeof entry !== 'object' || (entry.kind !== 'endpoint' && entry.kind !== 'suite') ||
        typeof entry.key !== 'string' || !entry.key || entry.key.length > 512 ||
        typeof entry.name !== 'string' || !entry.name || entry.name.length > 512 ||
        typeof entry.group !== 'string' || entry.group.length > 512 ||
        !Number.isSafeInteger(entry.staleAfterSeconds) || entry.staleAfterSeconds < 1 || entry.staleAfterSeconds > 604800 ||
        typeof entry.advisory !== 'boolean') throw new Error('Invalid Gatus catalog')
    if (Object.keys(entry).some(key => !['kind', 'key', 'name', 'group', 'staleAfterSeconds', 'advisory'].includes(key)) ||
        [entry.key, entry.name, entry.group].some(value => /(?:https?|tcp|dns):\/\//i.test(value))) throw new Error('Invalid Gatus catalog')
    const sourceId = gatusSourceId(entry)
    const sourceKey = JSON.stringify([entry.kind, entry.key])
    if (identities.has(sourceId) || keys.has(sourceKey)) throw new Error('Ambiguous Gatus catalog')
    identities.add(sourceId)
    keys.add(sourceKey)
  }
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (response.status >= 300 && response.status < 400) throw new Error('Gatus redirect refused')
  if (!response.ok || !/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')) throw new Error('Gatus request failed')
  const length = response.headers.get('content-length')
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new Error('Gatus response too large')
  if (!response.body) throw new Error('Gatus response missing')
  const reader = response.body.getReader()
  // Some custom bindings do not propagate the request abort to the response
  // stream. Cancel the reader explicitly so a timed-out read is not left held.
  const abortRead = () => { void reader.cancel().catch(() => {}) }
  if (signal.aborted) abortRead()
  else signal.addEventListener('abort', abortRead, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY_BYTES) throw new Error('Gatus response too large')
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally { signal.removeEventListener('abort', abortRead); reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown
}

async function fetchStatus(binding: GatusBinding, path: '/api/v1/endpoints/statuses' | '/api/v1/suites/statuses', timeoutMs: number): Promise<unknown> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Gatus request timed out')) }, timeoutMs)
    })
    // A VPC binding determines the network destination; this hostname is never caller-controlled.
    const request = new Request(`http://gatus.internal${path}?page=1&pageSize=1`, {
      method: 'GET', headers: { Accept: 'application/json' }, redirect: 'manual', signal: controller.signal,
    })
    return await Promise.race([binding.fetch(request).then(response => readBoundedJson(response, controller.signal)), timeout])
  } finally { if (timer) clearTimeout(timer) }
}

type RawStatus = { name: string; group: string; key: string; results: unknown[] }
function indexStatuses(value: unknown, expectedEmpty: boolean): Map<string, RawStatus> {
  // The pinned Gatus SQLite suite endpoint returns JSON null when it has no
  // suites at all. Only accept that shape if the reviewed inventory is empty.
  if (value === null && expectedEmpty) return new Map()
  if (!Array.isArray(value) || value.length > MAX_CATALOG_ENTRIES) throw new Error('Invalid Gatus status response')
  const statuses = new Map<string, RawStatus>()
  for (const item of value) {
    if (!record(item) || typeof item.key !== 'string' || !item.key || typeof item.name !== 'string' || !item.name ||
        (item.group !== undefined && typeof item.group !== 'string') || !Array.isArray(item.results) || item.results.length > MAX_RESULTS_PER_MONITOR ||
        statuses.has(item.key)) throw new Error('Invalid Gatus status response')
    statuses.set(item.key, { key: item.key, name: item.name, group: item.group ?? '', results: item.results })
  }
  return statuses
}

function pending(entry: GatusCatalogEntry): GatusMonitor {
  return { sourceId: gatusSourceId(entry), name: entry.name, group: entry.group, kind: entry.kind, health: 'pending', lastCheckedAt: null, durationMs: null }
}
function mapStatus(entry: GatusCatalogEntry, raw: RawStatus | undefined, now: number): GatusMonitor {
  const output = pending(entry)
  if (!raw || raw.name !== entry.name || raw.group !== entry.group) return output
  if (raw.results.length !== 1) return output
  const sample = raw.results[0]
  if (!record(sample) || typeof sample.success !== 'boolean' || typeof sample.timestamp !== 'string' ||
      typeof sample.duration !== 'number' || !Number.isFinite(sample.duration) || sample.duration < 0) return output
  const timestamp = Date.parse(sample.timestamp)
  if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > now + MAX_FUTURE_SKEW_MS) return output
  output.lastCheckedAt = timestamp
  output.durationMs = sample.duration / 1_000_000
  if (now - timestamp > entry.staleAfterSeconds * 1000) return output
  output.health = sample.success ? 'up' : entry.advisory ? 'degraded' : 'down'
  return output
}

/** Fetch two fixed routes through a private binding. Failure never turns missing data into healthy status. */
export async function getGatusSnapshot(binding: GatusBinding, catalog: readonly GatusCatalogEntry[], options: { now?: number; timeoutMs?: number } = {}): Promise<GatusSnapshot> {
  validateGatusCatalog(catalog)
  const now = options.now ?? Date.now()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(now) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('Invalid Gatus request options')
  try {
    const [endpoints, suites] = await Promise.all([
      fetchStatus(binding, '/api/v1/endpoints/statuses', timeoutMs),
      fetchStatus(binding, '/api/v1/suites/statuses', timeoutMs),
    ])
    const byKind = {
      endpoint: indexStatuses(endpoints, !catalog.some(entry => entry.kind === 'endpoint')),
      suite: indexStatuses(suites, !catalog.some(entry => entry.kind === 'suite')),
    }
    // A drifted inventory must not produce a deceptively healthy partial board.
    for (const kind of ['endpoint', 'suite'] as const) {
      const expected = catalog.filter(entry => entry.kind === kind)
      if (expected.length !== byKind[kind].size || expected.some(entry => {
        const item = byKind[kind].get(entry.key)
        return !item || item.name !== entry.name || item.group !== entry.group
      })) throw new Error('Gatus inventory mismatch')
    }
    return { available: true, monitors: catalog.map(entry => mapStatus(entry, byKind[entry.kind].get(entry.key), now)) }
  } catch {
    return { available: false, monitors: catalog.map(pending) }
  }
}
