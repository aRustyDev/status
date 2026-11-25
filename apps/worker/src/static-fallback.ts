const STATE_KEY = 'fallback/current.json'

export interface FallbackSettings {
  enabled: boolean
  intervalSeconds: number
}

interface Run {
  at: number
  ok: boolean
  error: string | null
}

export class FallbackConflictError extends Error {}

interface FallbackState {
  revision: string
  enabled: boolean
  settings: FallbackSettings
  snapshot: unknown | null
  status: { lastRunAt: number | null; lastSuccessAt: number | null; lastError: string | null }
  runs: Run[]
}

const emptyState = (): FallbackState => ({
  revision: crypto.randomUUID(),
  enabled: false,
  settings: { enabled: false, intervalSeconds: 60 },
  snapshot: null,
  status: { lastRunAt: null, lastSuccessAt: null, lastError: null },
  runs: [],
})

async function readState(bucket: R2Bucket): Promise<{ state: FallbackState; etag: string | null }> {
  const object = await bucket.get(STATE_KEY)
  if (!object) return { state: emptyState(), etag: null }
  const state = await object.json<FallbackState>()
  if (!state || !state.settings || !state.status || !Array.isArray(state.runs) || typeof state.enabled !== 'boolean') throw new Error('Invalid fallback state')
  return { state, etag: object.etag }
}

async function writeState(bucket: R2Bucket, state: FallbackState, etag: string | null): Promise<boolean> {
  const onlyIf = etag === null ? { etagDoesNotMatch: '*' } : { etagMatches: etag }
  const result = await bucket.put(STATE_KEY, JSON.stringify(state), { onlyIf, httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' } })
  return result !== null
}

export function fallbackView(state: FallbackState, now = Date.now()) {
  const { settings, status, runs } = state
  const health = !settings.enabled ? 'disabled' : status.lastError ? 'error' : !status.lastSuccessAt ? 'pending' : now - status.lastSuccessAt > settings.intervalSeconds * 3000 ? 'stale' : 'ok'
  return { settings, status, runs, health }
}

export async function getFallback(bucket: R2Bucket) {
  return fallbackView((await readState(bucket)).state)
}

export async function saveFallback(bucket: R2Bucket, settings: FallbackSettings) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const { state, etag } = await readState(bucket)
    const next = { ...state, revision: crypto.randomUUID(), enabled: settings.enabled, settings }
    if (await writeState(bucket, next, etag)) return fallbackView(next)
  }
  throw new Error('Concurrent fallback update')
}

export async function checkFallback(bucket: R2Bucket): Promise<{ ok: boolean; error: string | null }> {
  const key = `fallback/check/${crypto.randomUUID()}`
  try {
    await bucket.put(key, 'check')
    const object = await bucket.get(key)
    if (!object || await object.text() !== 'check') throw new Error('Read failed')
    await bucket.delete(key)
    return { ok: true, error: null }
  } catch {
    try { await bucket.delete(key) } catch { /* The check result already reports failure. */ }
    return { ok: false, error: 'Storage connectivity check failed' }
  }
}

export async function publishFallback(bucket: R2Bucket, build: (intervalSeconds: number) => Promise<unknown>, onlyWhenDue = false) {
  const { state, etag } = await readState(bucket)
  if (!state.enabled) return fallbackView(state)
  const now = Date.now()
  if (onlyWhenDue && state.status.lastRunAt !== null && now - state.status.lastRunAt < state.settings.intervalSeconds * 1000) return fallbackView(state)
  let snapshot: unknown | null = null
  let error: string | null = null
  try { snapshot = await build(state.settings.intervalSeconds) }
  catch { error = 'Snapshot publication failed' }
  const next: FallbackState = {
    ...state,
    revision: crypto.randomUUID(),
    snapshot: error ? state.snapshot : snapshot,
    status: { lastRunAt: now, lastSuccessAt: error ? state.status.lastSuccessAt : now, lastError: error },
    runs: [...state.runs, { at: now, ok: !error, error }].slice(-30),
  }
  if (await writeState(bucket, next, etag)) return fallbackView(next)
  throw new FallbackConflictError('Static fallback changed during publication')
}
