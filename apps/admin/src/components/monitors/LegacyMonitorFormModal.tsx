import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Monitor, MonitorType } from '@bsp/shared'
import { Alert, Field, Modal, ModalFooter, getCurrentUser } from '@better-forge/ui'
import { api } from '../../api/client'
import AdvancedHttpSettings, { type AdvancedHttpConfig } from './AdvancedHttpSettings'

type Component = Monitor & { uuid: string; version: number; manualStatus: string; position: number }
type Check = { id: string; componentId: string; endpointId: string; enabled: boolean | number; intervalMinutes: number; expectedStatus: number; version: number; advancedConfig?: AdvancedHttpConfig | null; advancedConfigInvalid?: boolean }
type Endpoint = { id: string; name: string }
type History = { results: Array<{ completedAt: number; status: string; httpStatus: number | null; latencyMs: number }>; retentionDays: number }

type Props = {
  monitor: Monitor | null
  initialType?: MonitorType | undefined
  statusUnavailable?: boolean | undefined
  allTags?: unknown[]
  allGroups?: string[]
  onClose: () => void
  onSaved: () => void
}

function CheckForm({ componentId, check, endpoints, onSaved }: { componentId: string; check?: Check | undefined; endpoints: Endpoint[]; onSaved: () => void }) {
  const [initialCheck] = useState(check)
  const [endpointId, setEndpointId] = useState(check?.endpointId ?? '')
  const [enabled, setEnabled] = useState(Boolean(check?.enabled))
  const [intervalMinutes, setIntervalMinutes] = useState(check?.intervalMinutes ?? 1)
  const [expectedStatus, setExpectedStatus] = useState(check?.expectedStatus ?? 200)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const hasStatusRanges = Boolean(initialCheck?.advancedConfig?.acceptedStatusRanges?.length)
  async function save(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const body = { componentId, endpointId, enabled, intervalMinutes, expectedStatus }
      if (initialCheck) await api.patch(`/admin/checks/${initialCheck.id}`, { ...body, version: initialCheck.version })
      else await api.post('/admin/checks', body)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the check')
    } finally {
      setBusy(false)
    }
  }
  return <form onSubmit={save} className="space-y-3">
    <h3 className="font-bold">HTTP check</h3>
    <Field label="Approved destination" required>
      <select value={endpointId} onChange={event => setEndpointId(event.target.value)} required className="input-sig">
        <option value="">Select a destination</option>
        {endpoints.map(endpoint => <option value={endpoint.id} key={endpoint.id}>{endpoint.name}</option>)}
      </select>
    </Field>
    <Field label="Interval">
      <select value={intervalMinutes} onChange={event => setIntervalMinutes(Number(event.target.value))} className="input-sig">
        <option value={1}>1 minute</option><option value={5}>5 minutes</option>
      </select>
    </Field>
    <Field label="Expected HTTP status">
      <input type="number" min={100} max={599} required disabled={hasStatusRanges || initialCheck?.advancedConfigInvalid} aria-describedby={hasStatusRanges ? 'status-range-explanation' : undefined} value={expectedStatus} onChange={event => setExpectedStatus(Number(event.target.value))} className="input-sig" />
    </Field>
    {hasStatusRanges && <p id="status-range-explanation" className="text-sm">Status ranges in additional HTTP settings determine the accepted status. Remove the ranges and save those settings to use a single expected status.</p>}
    <label><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /> Enabled</label>
    {error && <Alert tone="error">{error}</Alert>}
    <button type="submit" disabled={busy || !endpointId} className="btn btn-primary">Save check</button>
  </form>
}

export default function MonitorFormModal({ monitor, onClose, onSaved, statusUnavailable = false }: Props) {
  const component = monitor as Component | null
  const [initialComponent] = useState(component)
  const [name, setName] = useState(component?.name ?? '')
  const [manualStatus, setManualStatus] = useState(component?.manualStatus ?? 'operational')
  const [position, setPosition] = useState(component?.position ?? 0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const isAdmin = getCurrentUser()?.role === 'admin'
  const managedInGatus = component?.source === 'gatus'
  const history = useQuery<History>({ queryKey: ['monitor-history', component?.id], queryFn: () => api.get(`/admin/monitors/${component!.id}/history`), enabled: !!component && !managedInGatus })
  const checks = useQuery<Check[]>({ queryKey: ['checks'], queryFn: () => api.get('/admin/checks'), enabled: isAdmin && !!component && !managedInGatus, refetchOnMount: 'always' })
  const endpoints = useQuery<Endpoint[]>({ queryKey: ['endpoints'], queryFn: () => api.get('/admin/endpoints'), enabled: isAdmin && !!component && !managedInGatus, refetchOnMount: 'always' })
  const [checkSettings, setCheckSettings] = useState<{ checks: Check[]; endpoints: Endpoint[] } | null>(null)
  useEffect(() => {
    if (!checkSettings && checks.isFetchedAfterMount && endpoints.isFetchedAfterMount && !checks.isError && !endpoints.isError && checks.data && endpoints.data) {
      setCheckSettings({ checks: checks.data, endpoints: endpoints.data })
    }
  }, [checkSettings, checks.isFetchedAfterMount, endpoints.isFetchedAfterMount, checks.isError, endpoints.isError, checks.data, endpoints.data])
  if (managedInGatus) return <Modal title="Monitor" icon="edit" onClose={onClose} flush>
    <div className="p-6 space-y-3"><p className="font-bold">{component.name}</p><p>Managed in Gatus. Change this monitor in Gatus.</p></div>
    <ModalFooter><button type="button" onClick={onClose} className="btn btn-secondary">Close</button></ModalFooter>
  </Modal>
  async function save(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const body = { name, manualStatus, position }
      if (initialComponent) await api.patch(`/admin/components/${initialComponent.uuid}`, { ...body, version: initialComponent.version })
      else await api.post('/admin/components', body)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the service')
    } finally {
      setBusy(false)
    }
  }
  return <Modal title={component ? 'Edit Monitor' : 'New Monitor'} icon="edit" onClose={onClose} flush>
    <div className="p-6 space-y-5">
      {statusUnavailable && <Alert tone="error">Monitor status is unavailable. Your draft is preserved while the latest status is loaded.</Alert>}
      <div style={{ display: statusUnavailable ? 'none' : undefined }}>
      <form onSubmit={save} className="space-y-3">
        <Field label="Name" required><input value={name} onChange={event => setName(event.target.value)} required className="input-sig" /></Field>
        <Field label="Manual health"><select value={manualStatus} onChange={event => setManualStatus(event.target.value)} className="input-sig">
          <option value="operational">Operational</option><option value="degraded">Degraded</option><option value="down">Down</option>
        </select></Field>
        <Field label="Order"><input type="number" min={0} value={position} onChange={event => setPosition(Number(event.target.value))} className="input-sig" /></Field>
        {error && <Alert tone="error">{error}</Alert>}
        <button type="submit" disabled={busy} className="btn btn-primary">Save service</button>
      </form>
      {component && isAdmin && checkSettings && <div style={{ display: checks.isError || endpoints.isError ? 'none' : undefined }}>
        <CheckForm componentId={component.uuid} check={checkSettings.checks.find(item => item.componentId === component.uuid)} endpoints={checkSettings.endpoints} onSaved={onSaved} />
        {checkSettings.checks.filter(item => item.componentId === component.uuid).map(check => check.advancedConfigInvalid
          ? <Alert key={check.id} tone="error">Additional HTTP settings are invalid. Contact an administrator to review the configuration.</Alert>
          : <AdvancedHttpSettings key={check.id} checkId={check.id} version={check.version} config={check.advancedConfig ?? null} onSaved={onSaved} />)}
      </div>}
      {component && isAdmin && (!checks.isFetchedAfterMount || !endpoints.isFetchedAfterMount) && !checks.isError && !endpoints.isError && <p role="status">Loading check settings…</p>}
      {component && isAdmin && (checks.isError || endpoints.isError) && <Alert tone="error">Could not load check settings.</Alert>}
      {component && <section aria-label="Check history">
        <h3 className="font-bold">Recent check history</h3>
        {history.data && <div className="my-2 space-y-1">
          <label htmlFor="check-history-range">History range</label>
          <select id="check-history-range" defaultValue="14" aria-describedby="check-history-availability" className="input-sig">
            <option value="14">14 days</option>
            <option value="30" disabled>30 days</option>
            <option value="90" disabled>90 days</option>
          </select>
          <p id="check-history-availability" className="text-sm">
            History beyond {history.data.retentionDays} days is unavailable. Showing the most recent 20 samples.
          </p>
        </div>}
        {history.data?.results.length === 0 && <p>No samples for this check configuration.</p>}
        {history.data?.results.slice(-20).reverse().map(sample => <p key={sample.completedAt}>{new Date(sample.completedAt).toLocaleString()} · {sample.status} · HTTP {sample.httpStatus ?? '—'} · {sample.latencyMs} ms</p>)}
        {history.isError && <p role="alert">Could not load check history.</p>}
      </section>}
      </div>
      <p className="text-sm">Dependencies, notification channels, and additional monitor types are unavailable.</p>
    </div>
    <ModalFooter><button type="button" onClick={onClose} className="btn btn-secondary">Close</button></ModalFooter>
  </Modal>
}
