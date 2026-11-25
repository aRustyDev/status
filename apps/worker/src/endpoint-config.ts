export type RequestPolicy = { allowPost?: boolean; plaintextHeaders?: string[]; vaultHeaders?: string[] }
export type Endpoint = { id: string; name: string; url: string; binding?: string; serviceId?: string; revision?: string; requestPolicy?: RequestPolicy }

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/

function normalizePolicy(value: unknown): RequestPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request policy')
  const policy = value as Record<string, unknown>
  if (Object.keys(policy).some(key => !['allowPost', 'plaintextHeaders', 'vaultHeaders'].includes(key)) || (policy.allowPost !== undefined && typeof policy.allowPost !== 'boolean')) throw new Error('Invalid request policy')
  const names = (input: unknown): string[] => {
    if (input === undefined) return []
    if (!Array.isArray(input) || input.length > 20 || input.some(name => typeof name !== 'string' || !HEADER_NAME.test(name))) throw new Error('Invalid request policy')
    const normalized = input.map(name => name.toLowerCase()).sort()
    if (new Set(normalized).size !== normalized.length) throw new Error('Invalid request policy')
    return normalized
  }
  const plaintextHeaders = names(policy.plaintextHeaders)
  const vaultHeaders = names(policy.vaultHeaders)
  if (plaintextHeaders.some(name => vaultHeaders.includes(name))) throw new Error('Invalid request policy')
  return { allowPost: policy.allowPost === true, plaintextHeaders, vaultHeaders }
}

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
    const endpoint = value as Endpoint
    if (endpoint.requestPolicy !== undefined) endpoint.requestPolicy = normalizePolicy(endpoint.requestPolicy)
    entries.set(value.id, endpoint)
  }
  return entries
}

// Hash the network target, not the display name. Service ID is an explicit
// deployment assertion checked against Wrangler config by the sync script.
export async function endpointFingerprint(endpoint: Endpoint): Promise<string> {
  const identity: unknown[] = [endpoint.url, endpoint.binding ?? null, endpoint.serviceId ?? null, endpoint.revision ?? null]
  if (endpoint.requestPolicy !== undefined) identity.push(normalizePolicy(endpoint.requestPolicy))
  const data = new TextEncoder().encode(JSON.stringify(identity))
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}
