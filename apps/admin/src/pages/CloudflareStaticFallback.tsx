import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, ApiError, ErrorState, LoadingState, PageContainer, PageHeader, Switch, formatDateTime } from '@better-forge/ui'
import { api } from '../api/client'

// Adapted from BetterStatusPage's StaticFallback page (MIT; see THIRD_PARTY_LICENSE_BetterStatusPage).
type Settings = { enabled: boolean; intervalSeconds: number }
type Health = 'disabled' | 'pending' | 'ok' | 'stale' | 'error'
type Mirror = {
  settings: Settings
  settingsRevision: string
  status: { lastRunAt: number | null; lastSuccessAt: number | null; lastError: string | null }
  health: Health
  runs: Array<{ at: number; ok: boolean; error: string | null }>
}

const QUERY_KEY = ['static-mirror']
const card = { background: 'var(--m3-surface-container-lowest)', border: '1px solid var(--m3-outline-variant)', color: 'var(--m3-on-surface)' }
const healthText: Record<Health, string> = { disabled: 'Off', pending: 'Waiting', ok: 'Up to date', stale: 'Stale', error: 'Failing' }
const healthStyles: Record<Health, React.CSSProperties> = {
  disabled: { background: 'var(--m3-surface-container-high)', color: 'var(--m3-secondary)' },
  pending: { background: 'var(--m3-surface-container-high)', color: 'var(--m3-secondary)' },
  ok: { background: 'var(--m3-up-bg)', color: 'var(--m3-up)' },
  stale: { background: 'var(--m3-degraded-bg)', color: 'var(--m3-degraded)' },
  error: { background: 'var(--m3-error-container)', color: 'var(--m3-on-error-container)' },
}
const titles: Record<Health, string> = { disabled: 'Static fallback is off', pending: 'Waiting for the first push', ok: 'The copy is up to date', stale: 'The copy is out of date', error: 'The latest push failed' }
const date = (value: number | null) => value === null ? 'Never' : formatDateTime(value)
const sameSettings = (left: Settings, right: Settings) => left.enabled === right.enabled && left.intervalSeconds === right.intervalSeconds

export default function CloudflareStaticFallbackPage() {
  const query = useQuery<Mirror>({ queryKey: QUERY_KEY, queryFn: () => api.get('/admin/static-mirror'), refetchInterval: 15_000 })
  const header = <PageHeader title="Static fallback" subtitle="A saved copy of the status page for when the live page is unavailable." />
  if (!query.data) return <PageContainer>{header}{query.isError
    ? <ErrorState message="Could not load static fallback settings." onRetry={() => void query.refetch()} />
    : <LoadingState label="Loading static fallback…" />}</PageContainer>
  return <PageContainer>{header}{query.isError && <Alert tone="error">Could not refresh static fallback status. Showing the last response.</Alert>}<Fallback data={query.data} /></PageContainer>
}

function Fallback({ data }: { data: Mirror }) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState(data.settings)
  const [baseline, setBaseline] = useState(data.settings)
  const [baselineRevision, setBaselineRevision] = useState(data.settingsRevision)
  const [conflictRefresh, setConflictRefresh] = useState<'idle' | 'loading' | 'failed' | 'ready'>('idle')
  const [customInterval, setCustomInterval] = useState(() => ![60, 300, 900].includes(data.settings.intervalSeconds))
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const setResult = (result: Mirror) => {
    queryClient.setQueryData(QUERY_KEY, result)
    setForm(result.settings)
    setBaseline(result.settings)
    setBaselineRevision(result.settingsRevision)
    setConflictRefresh('idle')
    setCustomInterval(![60, 300, 900].includes(result.settings.intervalSeconds))
    setMessage(result.status.lastError ? { tone: 'error', text: result.status.lastError } : { tone: 'success', text: 'Static fallback updated.' })
  }
  const onError = (error: unknown) => setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'The request failed.' })
  async function refreshConflict() {
    setConflictRefresh('loading')
    try {
      await queryClient.fetchQuery<Mirror>({ queryKey: QUERY_KEY, queryFn: () => api.get('/admin/static-mirror'), staleTime: 0, retry: false })
      setConflictRefresh('ready')
    } catch {
      setConflictRefresh('failed')
    }
  }
  const save = useMutation({
    mutationFn: (settings: Settings) => api.put<Mirror>('/admin/static-mirror', { ...settings, settingsRevision: baselineRevision }),
    onSuccess: setResult,
    onError: async error => {
      if (error instanceof ApiError && error.status === 409) {
        await refreshConflict()
      } else onError(error)
    },
  })
  const push = useMutation({ mutationFn: () => api.post<Mirror>('/admin/static-mirror/test'), onSuccess: setResult, onError })
  const check = useMutation({
    mutationFn: () => api.post<{ ok: boolean; error: string | null }>('/admin/static-mirror/check'),
    onSuccess: result => setMessage(result.ok ? { tone: 'success', text: 'Storage access check passed.' } : { tone: 'error', text: result.error || 'Storage access check failed.' }),
    onError,
  })
  const busy = save.isPending || push.isPending || check.isPending
  const dirty = !sameSettings(form, baseline)
  const conflict = conflictRefresh !== 'idle' || (dirty && baselineRevision !== data.settingsRevision)
  const displayed = dirty ? form : data.settings
  const displayedCustom = dirty ? customInterval : ![60, 300, 900].includes(displayed.intervalSeconds)
  const validInterval = Number.isInteger(displayed.intervalSeconds) && displayed.intervalSeconds >= 60 && displayed.intervalSeconds <= 86400 && displayed.intervalSeconds % 60 === 0
  function updateForm(change: Partial<Settings>) {
    if (!dirty) { setBaseline(data.settings); setBaselineRevision(data.settingsRevision) }
    setForm({ ...displayed, ...change })
  }
  function reloadSettings() {
    setBaseline(data.settings)
    setBaselineRevision(data.settingsRevision)
    setConflictRefresh('idle')
    setForm(data.settings)
    setCustomInterval(![60, 300, 900].includes(data.settings.intervalSeconds))
  }

  return <div className="space-y-6 text-[color:var(--m3-on-surface)]">
    {message && <Alert tone={message.tone} onDismiss={() => setMessage(null)}>{message.text}</Alert>}
    <section className="rounded-2xl p-5 md:p-6" style={card} aria-labelledby="fallback-status-title">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div><h2 id="fallback-status-title" className="font-headline text-xl font-semibold">{titles[data.health]}</h2><p className="mt-1 text-sm" style={{ color: 'var(--m3-secondary)' }}>The copy shows the last saved state and its age.</p></div>
        <span className="rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide" style={healthStyles[data.health]}>{healthText[data.health]}</span>
      </div>
      {data.status.lastError && <Alert tone="error">{data.status.lastError}</Alert>}
      <dl className="mt-6 grid gap-5 border-t pt-5 sm:grid-cols-2" style={{ borderColor: 'var(--m3-outline-variant)' }}>
        <div><dt className="text-xs uppercase tracking-wide">Last success</dt><dd className="mt-1">{date(data.status.lastSuccessAt)}</dd></div>
        <div><dt className="text-xs uppercase tracking-wide">Last attempt</dt><dd className="mt-1">{date(data.status.lastRunAt)}</dd></div>
      </dl>
      {data.runs.length > 0 && <div className="mt-6"><h3 className="text-xs uppercase tracking-wide">Last {data.runs.length} pushes</h3>
        <div role="img" aria-label={`${data.runs.filter(run => run.ok).length} of the last ${data.runs.length} pushes succeeded`} className="mt-2 flex flex-wrap gap-1">
          {data.runs.map((run, index) => <span key={`${run.at}-${index}`} title={`${date(run.at)} · ${run.ok ? 'succeeded' : run.error || 'failed'}`} className="h-[30px] w-[11px] rounded" style={{ background: run.ok ? 'var(--m3-up)' : 'var(--m3-down)' }} />)}
        </div>
      </div>}
    </section>
    <section className="rounded-2xl p-5 md:p-6 space-y-5" style={card} aria-labelledby="fallback-settings-title">
      <h2 id="fallback-settings-title" className="font-headline text-xl font-semibold">Settings</h2>
      <p className="text-sm" style={{ color: 'var(--m3-secondary)' }}>The copy is stored in the private bucket configured for this deployment. Access remains required to view it.</p>
      {conflict && <Alert tone="error">Settings changed elsewhere. Your unsaved edits are preserved. Reload the current settings before saving. {conflictRefresh === 'failed'
        ? <button type="button" className="underline" onClick={() => void refreshConflict()}>Retry refresh</button>
        : <button type="button" className="underline" disabled={busy || conflictRefresh === 'loading'} onClick={reloadSettings}>Reload settings</button>}</Alert>}
      <Switch disabled={busy} checked={displayed.enabled} onChange={enabled => updateForm({ enabled })} label="Push the status page" />
      <div><label htmlFor="fallback-interval" className="block font-mono text-xs uppercase tracking-wider mb-2">How often</label>
        <select id="fallback-interval" disabled={busy} className="input" value={displayedCustom ? 'custom' : String(displayed.intervalSeconds)} onChange={event => { const custom = event.target.value === 'custom'; setCustomInterval(custom); updateForm({ intervalSeconds: custom ? 120 : Number(event.target.value) }) }}>
          <option value="60">1 min</option><option value="300">5 min</option><option value="900">15 min</option><option value="custom">Custom</option>
        </select>
      </div>
      {displayedCustom && <div><label htmlFor="fallback-custom-interval" className="block text-sm mb-2">Interval in minutes</label><input id="fallback-custom-interval" disabled={busy} className="input" type="number" min={1} max={1440} step={1} value={displayed.intervalSeconds / 60} onChange={event => updateForm({ intervalSeconds: Number(event.target.value) * 60 })} /></div>}
      {!validInterval && <p role="alert">Choose a whole number of minutes from 1 to 1440.</p>}
      <div className="flex flex-wrap gap-3">
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => { setMessage(null); check.mutate() }}>Check access</button>
        <button type="button" className="btn btn-primary" disabled={busy || conflict || !dirty || !validInterval} onClick={() => { setMessage(null); save.mutate(form) }}>Save</button>
        <button type="button" className="btn btn-secondary" disabled={busy || conflict || dirty || !data.settings.enabled} onClick={() => { setMessage(null); push.mutate() }}>Push now</button>
      </div>
    </section>
  </div>
}
