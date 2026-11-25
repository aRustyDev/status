import { endpointFingerprint, parseEndpoints, type Endpoint } from '../../worker/src/endpoint-config'
import { evaluateHttpMonitor, isBlockedRedirect, parsePersistedHttpConfig, type HttpMonitorConfig, type HttpMonitorResult } from './http-monitor'
import { resolveMonitorCredentialSnapshot, type MonitorCredentialSnapshot } from '../../worker/src/vault-resolver'
import { channelEndpoints, enqueueTransition, flushChannelDeliveries } from '../../worker/src/channels-runtime'
import { enqueueActionTransition, flushActions } from '../../worker/src/actions-runtime'

type Check = {
  id: string
  endpoint_id: string
  interval_minutes: number
  expected_status: number
  config_version: number
  last_scheduled_at: number | null
  advanced_config: string | null
}
type Environment = { DB: D1Database; ENDPOINTS: string; VAULT_ENCRYPTION_KEY?: string; MONITOR_AUTH_READY?: string; [binding: string]: unknown }
type Result = { status: 'up' | 'down'; effectiveStatus: 'up' | 'down' | 'degraded'; httpStatus: number | null; latencyMs: number; completedAt: number; credentialUnavailable?: boolean }

function channelsReady(env: Environment): boolean {
  return env.CHANNELS_READY === 'true' && (channelEndpoints(typeof env.CHANNEL_ENDPOINTS === 'string' ? env.CHANNEL_ENDPOINTS : undefined).size > 0)
}

// Cloudflare Workers VPC connection errors documented at
// https://developers.cloudflare.com/workers-vpc/reference/troubleshooting/
const proxyErrorCodes = new Set([
  'connection_refused', 'connection_terminated', 'connection_timeout', 'connection_limit_reached',
  'destination_unavailable', 'destination_not_found', 'destination_ip_prohibited', 'destination_ip_unroutable',
  'proxy_loop_detected', 'dns_error', 'dns_timeout', 'tls_protocol_error', 'tls_certificate_error',
  'http_request_error', 'http_upgrade_failed', 'http_request_denied', 'http_protocol_error',
  'http_response_incomplete', 'connection_read_timeout', 'connection_write_timeout', 'rate_limited',
  'proxy_internal_error',
])

function proxyErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown'
  const code = /(?:^|\b)ProxyError:\s*([a-zA-Z0-9_]+)/.exec(error.message)?.[1]
  return code && proxyErrorCodes.has(code) ? code : 'unknown'
}

async function probe(endpoint: Endpoint, expectedStatus: number, env: Environment): Promise<Result> {
  const startedAt = Date.now()
  let status: 'up' | 'down' = 'down'
  let httpStatus: number | null = null
  const signal = AbortSignal.timeout(5000)
  try {
    const options: RequestInit = { method: 'GET', redirect: 'manual', signal }
    let response: Response
    if (endpoint.binding) {
      const binding = env[endpoint.binding]
      if (!binding || typeof binding !== 'object' || !('fetch' in binding) || typeof binding.fetch !== 'function') {
        throw new Error('Missing VPC Service binding')
      }
      response = await binding.fetch(endpoint.url, options) as Response
    } else {
      response = await fetch(endpoint.url, options)
    }
    httpStatus = response.status
    status = !isBlockedRedirect(response) && httpStatus === expectedStatus ? 'up' : 'down'
    await response.body?.cancel()
  } catch (error) {
    // Exception names and messages may contain destination URLs or credentials.
    const errorName = error instanceof Error && ['Error', 'TypeError', 'TimeoutError', 'AbortError'].includes(error.name)
      ? error.name : 'UnknownError'
    const vpcErrorCode = endpoint.binding ? proxyErrorCode(error) : 'unknown'
    console.log(JSON.stringify({ event: 'probe_failure', endpointId: endpoint.id, errorName, signalAborted: signal.aborted, vpcErrorCode }))
  }
  const completedAt = Date.now()
  return { status, effectiveStatus: status, httpStatus, latencyMs: Math.max(0, completedAt - startedAt), completedAt }
}

// Resolve credentials only for the persisted check and version, never from a
// request-supplied secret reference. The approved endpoint is checked again
// immediately before transmission; responses and errors never include values.
async function evaluateConfigured(check: Check, config: HttpMonitorConfig, env: Environment, approved: ReadonlyMap<string, Endpoint>): Promise<HttpMonitorResult> {
  let authorization: string | undefined
  let credential: MonitorCredentialSnapshot | undefined
  let credentialFault = false
  const unavailable = (): HttpMonitorResult => ({ status: 'down', responseMs: null, httpStatus: null, reasons: ['credential_unavailable'], attempts: 1 })
  if (config.auth) {
    if (env.MONITOR_AUTH_READY !== 'true') return unavailable()
    try {
    const target = approved.get(check.endpoint_id)
    if (!target || new URL(target.url).protocol !== 'https:') return unavailable()
    const credentials = await resolveMonitorCredentialSnapshot(env.DB, env.VAULT_ENCRYPTION_KEY, check.id, check.config_version)
    if (!credentials || credentials.username.includes(':')) return unavailable()
    const current = await env.DB.prepare('SELECT endpoint_id, advanced_config FROM http_checks WHERE id=? AND config_version=?').bind(check.id, check.config_version).first<{endpoint_id:string;advanced_config:string | null}>()
    if (!current || current.endpoint_id !== check.endpoint_id || current.advanced_config !== check.advanced_config) return unavailable()
    const bytes = new TextEncoder().encode(`${credentials.username}:${credentials.password}`)
    authorization = `Basic ${btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))}`
    credential = credentials
    } catch { return unavailable() }
  }
  const result = await evaluateHttpMonitor(config, {
    endpoints: approved,
    fetch: async (url, init, endpoint) => {
      if (authorization) {
        // Fencing again at the transport boundary prevents a stale saved check
        // registry update, or secret rotation from sending stale credentials.
        try {
          const active = await env.DB.prepare(`SELECT c.advanced_config AS advanced_config FROM http_checks c JOIN endpoint_registry r ON r.endpoint_id=c.endpoint_id
            JOIN vault_secrets v ON v.id=? AND v.vault_id=? AND v.type='userpass' AND v.version=? AND v.nonce=?
            WHERE c.id=? AND c.config_version=? AND c.endpoint_id=? AND r.fingerprint=?`).bind(credential!.secretId,credential!.vaultId,credential!.version,credential!.nonce,check.id,check.config_version,check.endpoint_id,config.registryFingerprint).first<{advanced_config:string | null}>()
          if (!active || active.advanced_config !== check.advanced_config) throw new Error('Check changed')
        } catch { credentialFault = true; throw new Error('Check unavailable') }
        init = { ...init, headers: { authorization } }
      }
      if (!endpoint.binding) return fetch(url, init)
      const binding = env[endpoint.binding]
      if (!binding || typeof binding !== 'object' || !('fetch' in binding) || typeof binding.fetch !== 'function') throw new Error('Missing VPC Service binding')
      return binding.fetch(url, init) as Promise<Response>
    },
  })
  return credentialFault ? unavailable() : result
}

async function advancedProbe(check: Check, env: Environment, approved: ReadonlyMap<string, Endpoint>, fingerprint: string): Promise<Result | null> {
  let config: unknown
  try { config = JSON.parse(check.advanced_config!) } catch { return null }
  const monitorConfig = parsePersistedHttpConfig(config, check.endpoint_id, fingerprint, check.expected_status)
  if (!monitorConfig) return null
  const result = await evaluateConfigured(check, monitorConfig, env, approved)
  if (result.attempts === 0) return null
  return { status: result.status === 'up' ? 'up' : 'down', effectiveStatus: result.status, httpStatus: result.httpStatus, latencyMs: result.responseMs ?? 0, completedAt: Date.now(), ...(result.reasons.includes('credential_unavailable') ? { credentialUnavailable: true } : {}) }
}

async function saveResult(db: D1Database, check: Check, fingerprint: string, scheduledAt: number, result: Result, env: Environment): Promise<boolean> {
  const results = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO http_check_results
      (check_id, config_version, scheduled_at, completed_at, status, effective_status, http_status, latency_ms)
      SELECT id, config_version, ?, ?, ?, ?, ?, ? FROM http_checks
      WHERE id = ? AND enabled = 1 AND config_version = ?
      AND EXISTS (SELECT 1 FROM endpoint_registry WHERE endpoint_id = http_checks.endpoint_id AND fingerprint = ?)`)
      .bind(scheduledAt, result.completedAt, result.status, result.effectiveStatus, result.httpStatus, result.latencyMs, check.id, check.config_version, fingerprint),
    ...(!result.credentialUnavailable && channelsReady(env) ? [enqueueTransition(db, check.id, check.config_version, fingerprint, scheduledAt, result.effectiveStatus, result.completedAt)] : []),
    ...(!result.credentialUnavailable && env.ACTIONS_READY === 'true' && typeof env.ACTION_ENDPOINTS === 'string' && env.ACTION_ENDPOINTS ? [enqueueActionTransition(db, check.id, check.config_version, fingerprint, scheduledAt, result.effectiveStatus, result.completedAt)] : []),
    db.prepare(`UPDATE http_checks SET transition_suppressed = ?, last_scheduled_at = ?,
      last_result_at = (SELECT completed_at FROM http_check_results WHERE check_id = ? AND config_version = ? AND scheduled_at = ?),
      last_status = (SELECT status FROM http_check_results WHERE check_id = ? AND config_version = ? AND scheduled_at = ?),
      last_effective_status = (SELECT effective_status FROM http_check_results WHERE check_id = ? AND config_version = ? AND scheduled_at = ?),
      last_effective_scheduled_at = ?,
      last_http_status = (SELECT http_status FROM http_check_results WHERE check_id = ? AND config_version = ? AND scheduled_at = ?),
      last_latency_ms = (SELECT latency_ms FROM http_check_results WHERE check_id = ? AND config_version = ? AND scheduled_at = ?)
      WHERE id = ? AND enabled = 1 AND config_version = ? AND (last_scheduled_at IS NULL OR last_scheduled_at < ?)
      AND EXISTS (SELECT 1 FROM http_check_results WHERE check_id = ? AND config_version = ? AND scheduled_at = ?)
      AND EXISTS (SELECT 1 FROM endpoint_registry WHERE endpoint_id = http_checks.endpoint_id AND fingerprint = ?)`)
      .bind(result.credentialUnavailable ? 1 : 0, scheduledAt, check.id, check.config_version, scheduledAt, check.id, check.config_version, scheduledAt,
        check.id, check.config_version, scheduledAt, scheduledAt, check.id, check.config_version, scheduledAt,
        check.id, check.config_version, scheduledAt,
        check.id, check.config_version, scheduledAt, check.id, check.config_version, scheduledAt, fingerprint),
    ...(!result.credentialUnavailable ? [db.prepare(`INSERT INTO automation_transition_state (check_id,check_version,status)
      SELECT h.id,h.config_version,? FROM http_checks h WHERE h.id=? AND h.config_version=? AND h.last_scheduled_at=?
      AND EXISTS (SELECT 1 FROM http_check_results r WHERE r.check_id=h.id AND r.config_version=h.config_version AND r.scheduled_at=? AND COALESCE(r.effective_status,r.status)=?)
      AND NOT EXISTS (SELECT 1 FROM maintenance m WHERE m.cancelled=0 AND m.starts_at<=? AND m.ends_at>?
        AND (NOT EXISTS (SELECT 1 FROM maintenance_components mc WHERE mc.maintenance_id=m.id)
          OR EXISTS (SELECT 1 FROM maintenance_components mc WHERE mc.maintenance_id=m.id AND mc.component_id=h.component_id)))
      ON CONFLICT(check_id) DO UPDATE SET generation=automation_transition_state.generation + CASE WHEN automation_transition_state.check_version<>excluded.check_version OR automation_transition_state.status<>excluded.status THEN 1 ELSE 0 END,check_version=excluded.check_version,status=excluded.status`)
      .bind(result.effectiveStatus,check.id,check.config_version,scheduledAt,scheduledAt,result.effectiveStatus,result.completedAt,result.completedAt)] : []),
  ])
  return Number(results[0].meta.changes) > 0
}

export async function runChecks(scheduledTime: number, env: Environment): Promise<void> {
  const approved = parseEndpoints(env.ENDPOINTS)
  const registry = await env.DB.prepare('SELECT endpoint_id, fingerprint FROM endpoint_registry').all<{endpoint_id:string;fingerprint:string}>()
  const current = new Map(registry.results.map(row => [row.endpoint_id, row.fingerprint]))
  const scheduledAt = Math.floor(scheduledTime / 60_000) * 60_000
  const rows = await env.DB.prepare('SELECT id, endpoint_id, interval_minutes, expected_status, config_version, last_scheduled_at, advanced_config FROM http_checks WHERE enabled = 1 ORDER BY id').all<Check>()
  const due = rows.results.filter(check =>
    (check.last_scheduled_at === null || scheduledAt - check.last_scheduled_at >= check.interval_minutes * 60_000))
  for (let i = 0; i < due.length; i += 4) {
    await Promise.all(due.slice(i, i + 4).map(async check => {
      const endpoint = approved.get(check.endpoint_id)
      if (!endpoint) {
        console.error(JSON.stringify({ event: 'probe_endpoint_missing', endpointId: check.endpoint_id }))
        return
      }
      const fingerprint = await endpointFingerprint(endpoint)
      if (current.get(endpoint.id) !== fingerprint) {
        console.error(JSON.stringify({ event: 'probe_endpoint_mismatch', endpointId: endpoint.id }))
        return
      }
      const result = check.advanced_config === null
        ? await probe(endpoint, check.expected_status, env)
        : await advancedProbe(check, env, approved, fingerprint)
      if (!result) {
        console.error(JSON.stringify({ event: 'probe_config_invalid', endpointId: check.endpoint_id }))
        return
      }
      const saved = await saveResult(env.DB, check, fingerprint, scheduledAt, result, env)
      if (saved && result.credentialUnavailable) console.warn(JSON.stringify({ event: 'probe_credential_unavailable', checkId: check.id }))
      console.log(JSON.stringify({ event: saved ? 'probe_completed' : 'probe_discarded', endpointId: endpoint.id, status: result.status }))
    }))
  }
  if (channelsReady(env)) await flushChannelDeliveries(env as Parameters<typeof flushChannelDeliveries>[0])
  if (env.ACTIONS_READY === 'true' && typeof env.ACTION_ENDPOINTS === 'string' && env.ACTION_ENDPOINTS) await flushActions(env as Parameters<typeof flushActions>[0])
  await env.DB.prepare('DELETE FROM http_check_results WHERE scheduled_at < ?').bind(scheduledAt - 14 * 86_400_000).run()
  console.log(JSON.stringify({ event: 'probe_tick', scheduledAt, due: due.length }))
}

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/test') return new Response('Not found', { status: 404 })
    const reader = request.body?.getReader()
    if (!reader) return Response.json({ error: 'Invalid test request' }, { status: 400 })
    let size = 0
    const decoder = new TextDecoder()
    let raw = ''
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      // Match the management Worker's bounded byte limit: a valid saved
      // configuration may use many more UTF-8 bytes than UTF-16 characters.
      if (size > 256_000) { await reader.cancel(); return Response.json({ error: 'Test request too large' }, { status: 413 }) }
      raw += decoder.decode(part.value, { stream: true })
    }
    raw += decoder.decode()
    let input: Record<string, unknown>
    try { input = JSON.parse(raw) as Record<string, unknown> } catch { return Response.json({ error: 'Invalid test request' }, { status: 400 }) }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return Response.json({ error: 'Invalid test request' }, { status: 400 })
    const saved = typeof input.checkId === 'string' && Number.isSafeInteger(input.checkVersion) && Object.keys(input).every(key => ['checkId', 'checkVersion'].includes(key))
    let check: Check | null = null
    if (saved) check = await env.DB.prepare('SELECT id,endpoint_id,interval_minutes,expected_status,config_version,last_scheduled_at,advanced_config FROM http_checks WHERE id=? AND config_version=?').bind(input.checkId, input.checkVersion).first<Check>()
    if (saved && !check) return Response.json({ error: 'Saved check changed or is unavailable' }, { status: 409 })
    if (!saved && (Object.keys(input).some(key => !['endpointId', 'expectedStatus', 'advancedConfig'].includes(key)) || typeof input.endpointId !== 'string' || !Number.isInteger(input.expectedStatus) || Number(input.expectedStatus) < 100 || Number(input.expectedStatus) > 599)) return Response.json({ error: 'Invalid test request' }, { status: 400 })
    const approved = parseEndpoints(env.ENDPOINTS)
    const endpoint = approved.get(saved ? check!.endpoint_id : String(input.endpointId))
    if (!endpoint) return Response.json({ error: 'Unknown approved destination' }, { status: 400 })
    const fingerprint = await endpointFingerprint(endpoint)
    const registered = await env.DB.prepare('SELECT fingerprint FROM endpoint_registry WHERE endpoint_id = ?').bind(endpoint.id).first<{ fingerprint: string }>()
    if (!registered || registered.fingerprint !== fingerprint) return Response.json({ error: 'Destination is unavailable' }, { status: 409 })
    let settings: unknown = input.advancedConfig ?? { timeoutMs: 5000, attempts: 1 }
    if (saved) { try { settings = check!.advanced_config === null ? { timeoutMs: 5000, attempts: 1 } : JSON.parse(check!.advanced_config) } catch { return Response.json({ error: 'Invalid test settings' }, { status: 400 }) } }
    const expectedStatus = saved ? check!.expected_status : Number(input.expectedStatus)
    const config = parsePersistedHttpConfig(settings, endpoint.id, fingerprint, expectedStatus)
    if (!config || (!saved && config.auth)) return Response.json({ error: 'Invalid test settings' }, { status: 400 })
    const startedAt = Date.now()
    const result = saved ? await evaluateConfigured(check!, config, env, approved) : await evaluateHttpMonitor(config, {
      endpoints: approved,
      fetch: async (url, init, target) => {
        if (!target.binding) return fetch(url, init)
        const binding = env[target.binding]
        if (!binding || typeof binding !== 'object' || !('fetch' in binding) || typeof binding.fetch !== 'function') throw new Error('Missing VPC Service binding')
        return binding.fetch(url, init) as Promise<Response>
      },
    })
    const steps = [{ label: result.status === 'up' ? 'HTTP check passed' : result.status === 'degraded' ? 'HTTP check degraded' : 'HTTP check failed', status: result.status === 'up' ? 'ok' : 'error', detail: result.reasons.join(', ') || (result.httpStatus === null ? undefined : `HTTP ${result.httpStatus}`), durationMs: result.responseMs ?? undefined }]
    return Response.json({ overall: result.status === 'up' ? 'ok' : 'error', steps, totalMs: Date.now() - startedAt })
  },
  async scheduled(controller: ScheduledController, env: Environment): Promise<void> {
    await runChecks(controller.scheduledTime, env)
  },
}
