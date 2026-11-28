export type RequestPolicy = { allowPost?: boolean; plaintextHeaders?: string[]; vaultHeaders?: string[] }
export type AuthProvider = { id: string; name: string; url: string; binding?: string; serviceId?: string; revision?: string }
export type Endpoint = { id: string; name: string; url: string; binding?: string; serviceId?: string; revision?: string; requestPolicy?: RequestPolicy; authProviders?: { oauth2?: AuthProvider; cas?: AuthProvider } }

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

function normalizeAuthProviders(value: unknown): NonNullable<Endpoint['authProviders']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid authentication providers')
  const providers = value as Record<string, unknown>
  if (Object.keys(providers).some(key => key !== 'oauth2' && key !== 'cas')) throw new Error('Invalid authentication providers')
  const result: NonNullable<Endpoint['authProviders']> = {}
  for (const mode of ['oauth2', 'cas'] as const) {
    if (providers[mode] === undefined) continue
    const provider = providers[mode]
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) throw new Error('Invalid authentication provider')
    const p = provider as Record<string, unknown>
    if (Object.keys(p).some(key => !['id', 'name', 'url', 'binding', 'serviceId', 'revision'].includes(key)) ||
        typeof p.id !== 'string' || !p.id || p.id.length > 200 || typeof p.name !== 'string' || !p.name ||
        typeof p.url !== 'string' || (p.binding !== undefined && (typeof p.binding !== 'string' || !p.binding)) ||
        (p.serviceId !== undefined && (typeof p.serviceId !== 'string' || !p.serviceId)) ||
        (p.revision !== undefined && (typeof p.revision !== 'string' || !p.revision)) || Boolean(p.binding) !== Boolean(p.serviceId)) throw new Error('Invalid authentication provider')
    const url = new URL(p.url)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('Invalid authentication provider URL')
    result[mode] = { id: p.id, name: p.name, url: p.url, ...(p.binding ? { binding: p.binding as string, serviceId: p.serviceId as string } : {}), ...(p.revision ? { revision: p.revision as string } : {}) }
  }
  return result
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
    if (endpoint.authProviders !== undefined) endpoint.authProviders = normalizeAuthProviders(endpoint.authProviders)
    entries.set(value.id, endpoint)
  }
  return entries
}

// Hash the network target, not the display name. Service ID is an explicit
// deployment assertion checked against Wrangler config by the sync script.
export async function endpointFingerprint(endpoint: Endpoint): Promise<string> {
  const identity: unknown[] = [endpoint.url, endpoint.binding ?? null, endpoint.serviceId ?? null, endpoint.revision ?? null]
  if (endpoint.requestPolicy !== undefined) identity.push(normalizePolicy(endpoint.requestPolicy))
  if (endpoint.authProviders !== undefined) {
    const providers = normalizeAuthProviders(endpoint.authProviders)
    identity.push(['authProviders', ...(['oauth2', 'cas'] as const).map(mode => {
      const provider = providers[mode]
      return provider ? [provider.id, provider.url, provider.binding ?? null, provider.serviceId ?? null, provider.revision ?? null] : null
    })])
  }
  const data = new TextEncoder().encode(JSON.stringify(identity))
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}
