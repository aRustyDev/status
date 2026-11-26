import { ApiError } from '@better-forge/ui'
export { ApiError, clearSession, enterAfterSignIn, getCurrentUser, isAuthenticated, mustChangePassword, setSession, type AuthUser } from '@better-forge/ui'
import type { AuthUser } from '@better-forge/ui'
import { abandonMutationIntent, beginMutationIntent, fetchMutationResponse, finishMutationIntent, PendingMutationError } from '@bsp/shared'

export function isViewer(user: AuthUser | null): boolean {
  return user?.role === 'viewer'
}

async function request<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  const serialized = body === undefined ? '' : JSON.stringify(body)
  let intent
  try { intent = beginMutationIntent(method, path, serialized, 'bsp') }
  catch (error) {
    if (error instanceof PendingMutationError && !error.inFlight && window.confirm('The earlier save may have completed. Check the relevant record first. Have you checked it and want to allow a new attempt?')) abandonMutationIntent(error.intent)
    throw error
  }
  let response: Response
  let data: unknown
  try {
    ;({ response, body: data } = await fetchMutationResponse(`/api/v1/bsp${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        ...(intent ? { 'Idempotency-Key': intent.key, 'Idempotency-Actor': intent.actor } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: serialized }),
    }, !!intent || timeoutMs !== undefined, timeoutMs))
  } catch (error) {
    finishMutationIntent(intent, 0)
    if (intent) throw new Error('The save may have completed. Retry without changing the form, or check the record before starting again.', { cause: error })
    throw error
  }
  if (!response.ok) {
    const error = data as { error?: string; code?: string } | null
    if (response.status === 401) window.dispatchEvent(new Event('access-expired'))
    finishMutationIntent(intent, response.status)
    if (intent && error?.code === 'IDEMPOTENCY_EXPIRED' && window.confirm('The earlier save may have completed. Check the relevant record first. Have you checked it and want to allow a new attempt?')) abandonMutationIntent(intent)
    const message = intent && (response.status === 502 || response.status === 504)
      ? 'The save may have completed. Retry without changing the form, or check the record before starting again.'
      : error?.error ?? `Request failed (${response.status})`
    throw new ApiError(message, response.status, error?.code, error)
  }
  if (response.status === 204) { finishMutationIntent(intent, response.status); return undefined as T }
  finishMutationIntent(intent, response.status)
  return data as T
}

export const api = {
  get: <T>(path: string, options?: { timeoutMs?: number }) => request<T>('GET', path, undefined, options?.timeoutMs),
  post: <T>(path: string, body: unknown = {}, options?: { timeoutMs?: number }) => request<T>('POST', path, body, options?.timeoutMs),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  delete: (path: string, body?: unknown) => request<void>('DELETE', path, body),
  getText: async (path: string) => {
    const response = await fetch(`/api/v1/bsp${path}`, { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
    if (!response.ok) throw new ApiError('Request failed', response.status)
    return response.text()
  },
  upload: async <T>(path: string, body: FormData): Promise<T> => {
    const response = await fetch(`/api/v1/bsp${path}`, { method: 'POST', body, headers: { 'X-Requested-With': 'XMLHttpRequest' } })
    if (!response.ok) throw new ApiError('Request failed', response.status)
    return response.json() as Promise<T>
  },
  postText: async <T>(path: string, body: string, contentType: string): Promise<T> => {
    const response = await fetch(`/api/v1/bsp${path}`, { method: 'POST', body, headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': contentType } })
    if (!response.ok) throw new ApiError('Request failed', response.status)
    return response.json() as Promise<T>
  },
  downloadPost: async (path: string, body: unknown, filename: string) => {
    const response = await fetch(`/api/v1/bsp${path}`, { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (response.status === 401) window.dispatchEvent(new Event('access-expired'))
    if (!response.ok) throw new ApiError('Request failed', response.status)
    const url = URL.createObjectURL(await response.blob())
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.click()
    URL.revokeObjectURL(url)
  },
  download: async (path: string, filename: string) => {
    const response = await fetch(`/api/v1/bsp${path}`, { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
    if (response.status === 401) window.dispatchEvent(new Event('access-expired'))
    if (!response.ok) throw new ApiError('Request failed', response.status)
    const url = URL.createObjectURL(await response.blob())
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.click()
    URL.revokeObjectURL(url)
  },
}
