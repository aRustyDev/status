import { ApiError } from '@better-forge/ui'
export { ApiError, clearSession, enterAfterSignIn, getCurrentUser, isAuthenticated, mustChangePassword, setSession, type AuthUser } from '@better-forge/ui'
import type { AuthUser } from '@better-forge/ui'

export function isViewer(user: AuthUser | null): boolean {
  return user?.role === 'viewer'
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1/bsp${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { error?: string; code?: string } | null
    if (response.status === 401) window.dispatchEvent(new Event('access-expired'))
    throw new ApiError(error?.error ?? `Request failed (${response.status})`, response.status, error?.code, error)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  delete: (path: string) => request<void>('DELETE', path),
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
  download: async (path: string, filename: string) => {
    const response = await fetch(`/api/v1/bsp${path}`, { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
    if (!response.ok) throw new ApiError('Request failed', response.status)
    const url = URL.createObjectURL(await response.blob())
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.click()
    URL.revokeObjectURL(url)
  },
}
