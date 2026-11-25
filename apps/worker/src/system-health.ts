import { endpointFingerprint, parseEndpoints } from './endpoint-config'
import { getGatusSnapshot, type GatusBinding, type GatusCatalogEntry } from './gatus'

type Status = 'ok' | 'attention' | 'error' | 'disabled'

type HealthEnvironment = {
  DB: D1Database
  ENDPOINTS: string
  BACKUPS?: Fetcher
  BACKUPS_READY?: string
  GATUS?: GatusBinding
  GATUS_REQUIRED?: string
}

/** Only report signals we can observe from this Worker; never return dependency errors. */
export async function getSystemHealthReport(env: HealthEnvironment, now = Date.now()) {
  let database: { status: 'ok' | 'error'; responseMs: number | null } = { status: 'error', responseMs: null }
  let monitoring: { status: Status; configuredMonitors: number | null; overdueMonitors: number | null; lastMonitorCheckAt: number | null } = {
    status: 'error', configuredMonitors: null, overdueMonitors: null, lastMonitorCheckAt: null,
  }
  const started = Date.now()
  try {
    await env.DB.prepare('SELECT 1 AS available').first()
    database = { status: 'ok', responseMs: Math.max(0, Date.now() - started) }
    const checks = await env.DB.prepare(`SELECT h.endpoint_id, h.interval_minutes, h.last_result_at, r.fingerprint
      FROM http_checks h LEFT JOIN endpoint_registry r ON r.endpoint_id=h.endpoint_id WHERE h.enabled=1`).all<{ endpoint_id: string; interval_minutes: number; last_result_at: number | null; fingerprint: string | null }>()
    const endpoints = parseEndpoints(env.ENDPOINTS)
    const fingerprints = new Map(await Promise.all([...endpoints].map(async ([id, endpoint]) => [id, await endpointFingerprint(endpoint)] as const)))
    const valid = checks.results.filter(check => check.fingerprint && fingerprints.get(check.endpoint_id) === check.fingerprint)
    const overdue = checks.results.filter(check => !check.fingerprint || fingerprints.get(check.endpoint_id) !== check.fingerprint || !check.last_result_at || now - check.last_result_at > check.interval_minutes * 180_000).length
    const lastTimes = valid.map(check => check.last_result_at).filter((value): value is number => value !== null)
    monitoring = { status: checks.results.length === 0 ? 'disabled' : overdue > 0 ? 'attention' : 'ok', configuredMonitors: checks.results.length, overdueMonitors: overdue, lastMonitorCheckAt: lastTimes.length ? Math.max(...lastTimes) : null }
  } catch {
    // A later monitoring query can fail even when the initial database probe succeeds.
  }

  let gatus: { status: Status; configuredMonitors: number | null } = { status: 'error', configuredMonitors: null }
  try {
    const rows = await env.DB.prepare('SELECT kind, source_key, source_name, source_group, stale_after_seconds, advisory FROM gatus_sources WHERE active=1').all<{ kind: 'endpoint' | 'suite'; source_key: string; source_name: string; source_group: string; stale_after_seconds: number; advisory: number }>()
    const catalog: GatusCatalogEntry[] = rows.results.map(row => ({ kind: row.kind, key: row.source_key, name: row.source_name, group: row.source_group, staleAfterSeconds: row.stale_after_seconds, advisory: Boolean(row.advisory) }))
    gatus = { status: 'disabled', configuredMonitors: catalog.length }
    if (env.GATUS_REQUIRED !== undefined && !['true', 'false'].includes(env.GATUS_REQUIRED)) gatus.status = 'error'
    else if (catalog.length || env.GATUS || env.GATUS_REQUIRED === 'true') {
      gatus.status = 'error'
      if (env.GATUS && catalog.length) {
        const snapshot = await getGatusSnapshot(env.GATUS, catalog, { now })
        gatus.status = !snapshot.available ? 'error' : snapshot.monitors.some(item => item.health === 'pending') ? 'attention' : 'ok'
      }
    }
  } catch { /* Configuration and dependency errors are deliberately omitted. */ }

  let backupStatus: Status = env.BACKUPS_READY === 'true' ? 'error' : 'disabled'
  if (env.BACKUPS && env.BACKUPS_READY === 'true') {
    backupStatus = 'error'
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Timed out')) }, 3000) })
      const reachable = (async () => {
        const response = await env.BACKUPS!.fetch(new Request('https://backup.internal/health', { signal: controller.signal }))
        if (response.body) await response.body.cancel()
        return response.ok
      })()
      if (await Promise.race([reachable, timeout])) backupStatus = 'ok'
    } catch { /* Do not expose service errors or configuration. */ }
    finally { if (timer) clearTimeout(timer) }
  }
  const backups = { status: backupStatus }
  return {
    status: database.status === 'error' || monitoring.status === 'error' || monitoring.status === 'attention' || gatus.status === 'error' || gatus.status === 'attention' || backups.status === 'error' ? 'degraded' as const : 'healthy' as const,
    generatedAt: now,
    application: { status: 'ok' as const }, database, monitoring, gatus,
    notifications: { status: 'disabled' as const }, backups,
    staticMirror: { status: 'disabled' as const },
  }
}
