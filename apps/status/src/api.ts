import { SNAPSHOT_URL, answerFromSnapshot } from './dataSource'

/**
 * A failed public API request: `status` is the HTTP status, or 0 when the request never got a response.
 * `code` is the server's machine-readable error code, such as STATUS_PAGE_PRIVATE, when it sent one.
 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string | undefined

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

function cookie(name: string): string | null {
  const prefix = `${name}=`
  const part = document.cookie.split('; ').find((item) => item.startsWith(prefix))
  return part ? decodeURIComponent(part.slice(prefix.length)) : null
}

/** Headers for a JSON request that changes something; a signed-in visitor's session also needs its CSRF token. */
export function jsonHeaders(): Record<string, string> {
  const csrf = cookie('bsp_csrf')
  return csrf ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : { 'Content-Type': 'application/json' }
}

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event('access-session-expired'))
    const body = await res.json().catch(() => null) as { error?: unknown; code?: unknown } | null
    const message = typeof body?.error === 'string' && body.error
      ? body.error
      : `Request failed with status ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`
    throw new ApiError(message, res.status, typeof body?.code === 'string' ? body.code : undefined)
  }

  try {
    return await res.json() as T
  } catch {
    throw new ApiError('Invalid JSON in response', res.status)
  }
}

/**
 * Fetches a public API path and parses the JSON body. Non-2xx responses and network failures both reject with
 * an {@link ApiError}, so callers never mistake an error payload for data.
 */
export async function getJSON<T>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  init?.signal?.addEventListener('abort', cancel, { once: true })
  if (init?.signal?.aborted) controller.abort()
  const run = async () => {
    if (SNAPSHOT_URL && path.startsWith('/api/v1/public/')) return answerFromSnapshot<T>(path, SNAPSHOT_URL)
    let res: Response
    try {
      const headers = new Headers(init?.headers)
      headers.set('X-Requested-With', 'XMLHttpRequest')
      res = await fetch(path.replace(/^\/api\/v1\//, '/api/v1/bsp/'), { ...init, headers, ...(timeoutMs !== undefined ? { signal: controller.signal } : {}) })
    } catch (err) {
      throw new ApiError(err instanceof Error && err.message ? err.message : 'Network request failed', 0)
    }
    return parse<T>(res)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    if (timeoutMs === undefined) return await run()
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ApiError('Request timed out', 0)) }, timeoutMs) })
    return await Promise.race([run(), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    init?.signal?.removeEventListener('abort', cancel)
  }
}

/** Posts JSON to an API path, with the CSRF token of a signed-in session. Rejects like {@link getJSON}. */
export async function postJSON<T>(path: string, body: unknown = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(path.replace(/^\/api\/v1\//, '/api/v1/bsp/'), { method: 'POST', headers: { ...jsonHeaders(), 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify(body) })
  } catch (err) {
    throw new ApiError(err instanceof Error && err.message ? err.message : 'Network request failed', 0)
  }
  return parse<T>(res)
}
