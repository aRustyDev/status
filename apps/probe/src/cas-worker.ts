import { endpointFingerprint, parseEndpoints, type Endpoint } from '../../worker/src/endpoint-config'
import { resolveMonitorCredentialSnapshot } from '../../worker/src/vault-resolver'
import { parsePersistedHttpConfig } from './http-monitor'

type Environment = { DB: D1Database; ENDPOINTS: string; VAULT_ENCRYPTION_KEY?: string; MONITOR_AUTH_READY?: string; MONITOR_CAS_READY?: string; [binding: string]: unknown }
class CredentialUnavailable extends Error {}

type Stage = 'grant' | 'ticket' | 'callback' | 'target'
type Timings = Partial<Record<Stage, number>>

type SavedCheck = { id: string; endpoint_id: string; expected_status: number; config_version: number; advanced_config: string | null }

async function boundedText(response: Response): Promise<string> {
  if (!response.body) throw new Error('Empty response')
  const reader = response.body.getReader()
  let size = 0
  const decoder = new TextDecoder()
  let result = ''
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) return result + decoder.decode()
      size += part.value.byteLength
      if (size > 16384) { await reader.cancel(); throw new Error('Response too large') }
      result += decoder.decode(part.value, { stream: true })
    }
  } finally { reader.releaseLock() }
}

async function handle(request: Request, env: Environment, timings: Timings): Promise<Response> {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/check' || env.MONITOR_AUTH_READY !== 'true' || env.MONITOR_CAS_READY !== 'true') throw new CredentialUnavailable()
  let input: { checkId?: unknown; checkVersion?: unknown }
  try { input = await request.json() as typeof input } catch { throw new CredentialUnavailable() }
  if (!input || Object.keys(input).some(key => !['checkId', 'checkVersion'].includes(key)) || typeof input.checkId !== 'string' || !Number.isSafeInteger(input.checkVersion)) throw new CredentialUnavailable()
  const check = await env.DB.prepare('SELECT id, endpoint_id, expected_status, config_version, advanced_config FROM http_checks WHERE id=? AND config_version=?').bind(input.checkId, input.checkVersion).first<SavedCheck>()
  if (!check?.advanced_config) throw new CredentialUnavailable()
  const endpoints = parseEndpoints(env.ENDPOINTS)
  const endpoint = endpoints.get(check.endpoint_id)
  if (!endpoint || new URL(endpoint.url).protocol !== 'https:') throw new CredentialUnavailable()
  const fingerprint = await endpointFingerprint(endpoint)
  const config = parsePersistedHttpConfig(JSON.parse(check.advanced_config), check.endpoint_id, fingerprint, check.expected_status)
  if (!config || config.auth?.type !== 'cas' || (config.method ?? 'GET').toUpperCase() !== 'GET' || Object.keys(config.headers ?? {}).length || Object.keys(config.vaultHeaders ?? {}).length || config.body !== undefined) throw new CredentialUnavailable()
  const provider = endpoint.authProviders?.cas
  if (!provider || provider.id !== config.auth.cas.providerId) throw new CredentialUnavailable()
  const credential = await resolveMonitorCredentialSnapshot(env.DB, env.VAULT_ENCRYPTION_KEY, check.id, check.config_version)
  if (!credential) throw new CredentialUnavailable()
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(config.timeoutMs ?? 10000)])
  const guard = async () => {
    const row = await env.DB.prepare(`SELECT c.advanced_config FROM http_checks c JOIN endpoint_registry r ON r.endpoint_id=c.endpoint_id
      JOIN vault_secrets s ON s.id=? AND s.vault_id=? AND s.type='userpass' AND s.version=? AND s.nonce=?
      WHERE c.id=? AND c.config_version=? AND c.endpoint_id=? AND r.fingerprint=?`)
      .bind(credential.secretId, credential.vaultId, credential.version, credential.nonce, check.id, check.config_version, endpoint.id, fingerprint).first<{ advanced_config: string | null }>()
    if (!row || row.advanced_config !== check.advanced_config) throw new CredentialUnavailable()
    if (signal.aborted) throw new Error('Timed out')
  }
  const send = async (stage: Stage, target: Endpoint | typeof provider, url: string, options: RequestInit): Promise<Response> => {
    const start = Date.now()
    try {
      await guard()
      const init = { ...options, redirect: 'manual' as const, signal }
      if (!target.binding) return await fetch(url, init)
      const binding = env[target.binding]
      if (!binding || typeof binding !== 'object' || !('fetch' in binding) || typeof binding.fetch !== 'function') throw new Error('Binding unavailable')
      return await binding.fetch(url, init) as Response
    } finally { timings[stage] = Math.max(0, Date.now() - start) }
  }
  const form = { 'content-type': 'application/x-www-form-urlencoded' }
  const tgtResponse = await send('grant', provider, provider.url, { method: 'POST', headers: form, body: new URLSearchParams({ username: credential.username, password: credential.password }).toString() })
  const location = tgtResponse.headers.get('location')
  await tgtResponse.body?.cancel()
  if (!tgtResponse.ok || !location) throw new Error('Authentication failed')
  const tgt = new URL(location, provider.url)
  const approved = new URL(provider.url)
  if (tgt.username || tgt.password || tgt.origin !== approved.origin || !tgt.pathname.startsWith(`${approved.pathname.replace(/\/$/, '')}/`) || tgt.search || tgt.hash || !/^[-A-Za-z0-9._~]+$/.test(tgt.pathname.slice(approved.pathname.replace(/\/$/, '').length + 1))) throw new Error('Invalid ticket destination')
  const ticketResponse = await send('ticket', provider, tgt.toString(), { method: 'POST', headers: form, body: new URLSearchParams({ service: endpoint.url }).toString() })
  if (!ticketResponse.ok) { await ticketResponse.body?.cancel(); throw new Error('Authentication failed') }
  const ticket = (await boundedText(ticketResponse)).trim()
  if (!ticket || ticket.length > 4096 || !/^[-A-Za-z0-9._~]+$/.test(ticket)) throw new Error('Invalid ticket')
  const ticketUrl = new URL(endpoint.url)
  ticketUrl.searchParams.set('ticket', ticket)
  const login = await send('callback', endpoint, ticketUrl.toString(), { method: 'GET' })
  const next = login.headers.get('location')
  const setCookies = login.headers.getSetCookie()
  await login.body?.cancel()
  if (next && new URL(next, endpoint.url).toString() !== endpoint.url) throw new Error('Unapproved redirect')
  if (!login.ok && !(login.status >= 300 && login.status < 400 && next)) throw new Error('Authentication failed')
  const cookie = setCookies.map(value => value.split(';', 1)[0]).filter(value => /^[!#$%&'*+.^_`|~A-Za-z0-9-]+=[\x21-\x7e]*$/.test(value)).join('; ')
  if (!cookie || cookie.length > 8192) throw new Error('Missing session')
  const response = await send('target', endpoint, endpoint.url, { method: 'GET', headers: { cookie } })
  const headers = new Headers(response.headers)
  headers.delete('set-cookie')
  headers.delete('authorization')
  if (headers.has('location')) headers.set('location', 'https://redirect.invalid/')
  for (const name of [...headers.keys()]) if (name.startsWith('x-status-cas-')) headers.delete(name)
  return new Response(response.body, { status: response.status, headers })
}

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    const timings: Timings = {}
    let response: Response
    try {
      response = await handle(request, env, timings)
    } catch (error) {
      response = new Response(null, { status: 502, headers: { 'x-status-cas-failure': error instanceof CredentialUnavailable ? 'credential' : 'authentication' } })
    }
    const headers = new Headers(response.headers)
    for (const [stage, duration] of Object.entries(timings)) headers.set(`x-status-cas-${stage}-ms`, String(duration))
    return new Response(response.body, { status: response.status, headers })
  },
}
