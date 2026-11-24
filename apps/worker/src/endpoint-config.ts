export type Endpoint = { id: string; name: string; url: string; binding?: string; serviceId?: string; revision?: string }

export function parseEndpoints(config: string): Map<string, Endpoint> {
  const parsed: unknown = JSON.parse(config || '[]')
  if (!Array.isArray(parsed)) throw new Error('ENDPOINTS must be an array')
  const entries = new Map<string, Endpoint>()
  for (const value of parsed) {
    if (!value || typeof value.id !== 'string' || !value.id || typeof value.name !== 'string' || typeof value.url !== 'string' ||
        (value.binding !== undefined && (typeof value.binding !== 'string' || !value.binding)) ||
        (value.serviceId !== undefined && (typeof value.serviceId !== 'string' || !value.serviceId)) ||
        (value.revision !== undefined && (typeof value.revision !== 'string' || !value.revision)) ||
        Boolean(value.binding) !== Boolean(value.serviceId) || entries.has(value.id)) {
      throw new Error('Invalid ENDPOINTS entry')
    }
    const url = new URL(value.url)
    if (!['http:', 'https:'].includes(url.protocol) || (!value.binding && url.protocol !== 'https:') || url.username || url.password) {
      throw new Error('Invalid ENDPOINTS URL')
    }
    entries.set(value.id, value as Endpoint)
  }
  return entries
}

// Hash the network target, not the display name. Service ID is an explicit
// deployment assertion checked against Wrangler config by the sync script.
export async function endpointFingerprint(endpoint: Endpoint): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify([endpoint.url, endpoint.binding ?? null, endpoint.serviceId ?? null, endpoint.revision ?? null]))
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}
