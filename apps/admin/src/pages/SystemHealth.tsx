import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { Alert, ErrorState, LoadingState, PageContainer, PageHeader, formatDateTime } from '@better-forge/ui'

// Adapted from BetterStatusPage's SystemHealth page (MIT; see THIRD_PARTY_LICENSE_BetterStatusPage).
// Cloudflare Workers have no persistent process uptime or in-process scheduler, so
// this page presents only the signals supplied by the Cloudflare health endpoint.
type ComponentStatus = 'ok' | 'attention' | 'error' | 'disabled'
interface SystemHealthReport {
  status: 'healthy' | 'degraded'
  generatedAt: number
  application: { status: 'ok' }
  database: { status: 'ok' | 'error'; responseMs: number | null }
  monitoring: { status: ComponentStatus; configuredMonitors: number | null; overdueMonitors: number | null; lastMonitorCheckAt: number | null }
  gatus: { status: ComponentStatus; configuredMonitors: number | null }
  notifications: { status: 'disabled' }
  backups: { status: 'ok' | 'error' | 'disabled' }
  staticMirror: { status: ComponentStatus; lastSuccessAt?: number | null }
}

function formatDate(value: number | null) {
  return value === null ? 'Unavailable' : formatDateTime(value)
}

function StatusBadge({ status }: { status: ComponentStatus | 'healthy' | 'degraded' }) {
  const palette = status === 'ok' || status === 'healthy'
    ? { background: 'var(--m3-up-bg)', color: 'var(--m3-up)' }
    : status === 'disabled'
      ? { background: 'var(--m3-surface-container-high)', color: 'var(--m3-secondary)' }
      : status === 'attention'
        ? { background: 'var(--m3-degraded-bg)', color: 'var(--m3-degraded)' }
        : { background: 'var(--m3-error-container)', color: 'var(--m3-on-error-container)' }
  return <span className="rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide" style={palette}>{status}</span>
}

function HealthCard({ icon, title, status, children }: { icon: string; title: string; status: ComponentStatus; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl p-5 md:p-6 space-y-5" style={{ background: 'var(--m3-surface-container-lowest)', border: '1px solid var(--m3-outline-variant)' }}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined rounded-xl p-2.5" style={{ background: 'var(--admin-icon-container)', color: 'var(--admin-icon-color)' }}>{icon}</span>
          <h2 className="font-headline text-xl font-semibold">{title}</h2>
        </div>
        <StatusBadge status={status} />
      </div>
      <dl className="grid gap-4 sm:grid-cols-2">{children}</dl>
    </section>
  )
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return <div><dt className="text-xs uppercase tracking-wide" style={{ color: 'var(--m3-secondary)' }}>{label}</dt><dd className="mt-1 font-medium">{value}</dd></div>
}

export default function SystemHealthPage() {
  const [report, setReport] = useState<SystemHealthReport | null>(null)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const requestSequence = useRef(0)
  const load = useCallback(async (manual = false) => {
    const sequence = ++requestSequence.current
    if (manual) setRefreshing(true)
    try {
      const next = await api.get<SystemHealthReport>('/admin/system-health')
      if (sequence === requestSequence.current) { setReport(next); setError('') }
    } catch (cause) {
      if (sequence === requestSequence.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (sequence === requestSequence.current) setRefreshing(false)
    }
  }, [])
  useEffect(() => {
    const sequence = requestSequence
    void load()
    const interval = window.setInterval(() => { void load() }, 15_000)
    return () => { window.clearInterval(interval); sequence.current++ }
  }, [load])
  const header = <PageHeader title="System Health" subtitle="Internal health of this Cloudflare deployment." actions={
    <button type="button" disabled={refreshing} onClick={() => { void load(true) }} className="btn btn-primary">
      <span className="material-symbols-outlined" aria-hidden="true">refresh</span>{refreshing ? 'Refreshing…' : 'Refresh'}
    </button>
  } />
  if (!report && !error) return <PageContainer>{header}<LoadingState label="Loading system health…" /></PageContainer>
  return <PageContainer className="text-[color:var(--m3-on-surface)]">
    {header}
    {error && (report ? <Alert tone="error">{error}</Alert> : <ErrorState message={error} onRetry={() => { void load(true) }} />)}
    {report && <>
      <div className="rounded-2xl p-5 flex flex-wrap items-center justify-between gap-4" style={{ background: report.status === 'healthy' ? 'var(--m3-up-bg)' : 'var(--m3-error-container)' }}>
        <div><p className="font-headline text-xl font-semibold">{report.status === 'healthy' ? 'BetterStatusPage is healthy' : 'BetterStatusPage needs attention'}</p><p className="text-sm opacity-80">Updated {formatDateTime(report.generatedAt)} · refreshes every 15 seconds</p></div>
        <StatusBadge status={report.status} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <HealthCard icon="deployed_code" title="Application" status={report.application.status}>
          <Metric label="Worker" value="Responding" />
        </HealthCard>
        <HealthCard icon="database" title="Database" status={report.database.status}>
          <Metric label="Connection" value={report.database.status === 'ok' ? 'Available' : 'Unavailable'} />
          <Metric label="Response time" value={report.database.responseMs === null ? 'Unavailable' : `${report.database.responseMs} ms`} />
        </HealthCard>
        <HealthCard icon="monitor_heart" title="Monitoring" status={report.monitoring.status}>
          <Metric label="Configured checks" value={report.monitoring.configuredMonitors ?? 'Unavailable'} />
          <Metric label="Overdue checks" value={report.monitoring.overdueMonitors ?? 'Unavailable'} />
          <Metric label="Latest stored check" value={formatDate(report.monitoring.lastMonitorCheckAt)} />
          <Metric label="Scheduler liveness" value="Unavailable" />
        </HealthCard>
        <HealthCard icon="monitoring" title="Gatus integration" status={report.gatus.status}>
          <Metric label="Snapshot" value={report.gatus.status === 'ok' ? 'Available' : report.gatus.status === 'attention' ? 'Stale or pending' : report.gatus.status === 'disabled' ? 'Not configured' : 'Unavailable'} />
          <Metric label="Configured monitors" value={report.gatus.configuredMonitors ?? 'Unavailable'} />
        </HealthCard>
        <HealthCard icon="notifications_active" title="Notification delivery" status={report.notifications.status}>
          <Metric label="Delivery" value="Not available" />
        </HealthCard>
        <HealthCard icon="backup" title="Backups" status={report.backups.status}>
          <Metric label="Backup service" value={report.backups.status === 'ok' ? 'Available' : report.backups.status === 'disabled' ? 'Not enabled' : 'Unavailable'} />
          <Metric label="Backup integrity" value="Not checked" />
        </HealthCard>
        <HealthCard icon="cloud_upload" title="Static fallback" status={report.staticMirror.status}>
          <Metric label="Push" value={report.staticMirror.status === 'ok' ? 'Up to date' : report.staticMirror.status === 'attention' ? 'Stale or pending' : report.staticMirror.status === 'error' ? 'Unavailable' : 'Not enabled'} />
          {report.staticMirror.lastSuccessAt != null && <Metric label="Last success" value={formatDate(report.staticMirror.lastSuccessAt)} />}
        </HealthCard>
      </div>
    </>}
  </PageContainer>
}
