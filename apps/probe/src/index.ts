import { endpointFingerprint, parseEndpoints, type Endpoint } from '../../worker/src/endpoint-config'

type Check = {
  id: string
  endpoint_id: string
  interval_minutes: number
  expected_status: number
  config_version: number
  last_scheduled_at: number | null
}
type Environment = { DB: D1Database; ENDPOINTS: string; [binding: string]: unknown }
type Result = { status: 'up' | 'down'; httpStatus: number | null; latencyMs: number; completedAt: number }

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
    status = httpStatus === expectedStatus ? 'up' : 'down'
    await response.body?.cancel()
  } catch (error) {
    // Exception names and messages may contain destination URLs or credentials.
    const errorName = error instanceof Error && ['Error', 'TypeError', 'TimeoutError', 'AbortError'].includes(error.name)
      ? error.name : 'UnknownError'
    const vpcErrorCode = endpoint.binding ? proxyErrorCode(error) : 'unknown'
    console.log(JSON.stringify({ event: 'probe_failure', endpointId: endpoint.id, errorName, signalAborted: signal.aborted, vpcErrorCode }))
  }
  const completedAt = Date.now()
  return { status, httpStatus, latencyMs: Math.max(0, completedAt - startedAt), completedAt }
}

async function saveResult(db: D1Database, check: Check, fingerprint: string, scheduledAt: number, result: Result): Promise<boolean> {
  const results = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO http_check_results
      (check_id, config_version, scheduled_at, completed_at, status, http_status, latency_ms)
      SELECT id, config_version, ?, ?, ?, ?, ? FROM http_checks
      WHERE id = ? AND enabled = 1 AND config_version = ?
      AND EXISTS (SELECT 1 FROM endpoint_registry WHERE endpoint_id = http_checks.endpoint_id AND fingerprint = ?)`)
      .bind(scheduledAt, result.completedAt, result.status, result.httpStatus, result.latencyMs, check.id, check.config_version, fingerprint),
    db.prepare(`UPDATE http_checks SET last_scheduled_at = ?,
      last_result_at = (SELECT completed_at FROM http_check_results WHERE check_id = ? AND config_version = ? AND scheduled_at = ?),
      last_status = (SELECT status FROM http_check_results WHERE check_id = ? AND config_version = ? AND scheduled_at = ?),
      last_http_status = (SELECT http_status FROM http_check_results WHERE check_id = ? AND config_version = ? AND scheduled_at = ?),
      last_latency_ms = (SELECT latency_ms FROM http_check_results WHERE check_id = ? AND config_version = ? AND scheduled_at = ?)
      WHERE id = ? AND enabled = 1 AND config_version = ? AND (last_scheduled_at IS NULL OR last_scheduled_at < ?)
      AND EXISTS (SELECT 1 FROM http_check_results WHERE check_id = ? AND config_version = ? AND scheduled_at = ?)
      AND EXISTS (SELECT 1 FROM endpoint_registry WHERE endpoint_id = http_checks.endpoint_id AND fingerprint = ?)`)
      .bind(scheduledAt, check.id, check.config_version, scheduledAt, check.id, check.config_version, scheduledAt,
        check.id, check.config_version, scheduledAt, check.id, check.config_version, scheduledAt,
        check.id, check.config_version, scheduledAt, check.id, check.config_version, scheduledAt, fingerprint),
  ])
  return Number(results[0].meta.changes) > 0
}

export async function runChecks(scheduledTime: number, env: Environment): Promise<void> {
  const approved = parseEndpoints(env.ENDPOINTS)
  const registry = await env.DB.prepare('SELECT endpoint_id, fingerprint FROM endpoint_registry').all<{endpoint_id:string;fingerprint:string}>()
  const current = new Map(registry.results.map(row => [row.endpoint_id, row.fingerprint]))
  const scheduledAt = Math.floor(scheduledTime / 60_000) * 60_000
  const rows = await env.DB.prepare('SELECT id, endpoint_id, interval_minutes, expected_status, config_version, last_scheduled_at FROM http_checks WHERE enabled = 1 ORDER BY id').all<Check>()
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
      const result = await probe(endpoint, check.expected_status, env)
      const saved = await saveResult(env.DB, check, fingerprint, scheduledAt, result)
      console.log(JSON.stringify({ event: saved ? 'probe_completed' : 'probe_discarded', endpointId: endpoint.id, status: result.status }))
    }))
  }
  await env.DB.prepare('DELETE FROM http_check_results WHERE scheduled_at < ?').bind(scheduledAt - 14 * 86_400_000).run()
  console.log(JSON.stringify({ event: 'probe_tick', scheduledAt, due: due.length }))
}

export default {
  async scheduled(controller: ScheduledController, env: Environment): Promise<void> {
    await runChecks(controller.scheduledTime, env)
  },
}
