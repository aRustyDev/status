import { useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Monitor, MonitorTag, MonitorType } from '@bsp/shared'
import { Alert, getCurrentUser, Modal, ModalFooter } from '@better-forge/ui'
import { api } from '../../api/client'
import { useCapabilities } from '../../capabilities'
import LegacyMonitorFormModal from './LegacyMonitorFormModal'
import { CloudflareActionsPanel } from './CloudflareActionsPanel'
import UpstreamMonitorFormModal, { type CloudflareProfile } from '../../../../admin-node/src/components/monitors/MonitorFormModal'

type Component = Monitor & { uuid: string; version: number; manualStatus: string; position: number; channelIds?: string[]; dependsOnIds?: number[] }
type Check = NonNullable<CloudflareProfile['check']> & { componentId: string }
type History = { results: Array<{ completedAt: number; status: string; httpStatus: number | null; latencyMs: number }>; retentionDays: number }

type Props = {
  monitor: Monitor | null
  initialType?: MonitorType | undefined
  statusUnavailable?: boolean | undefined
  allTags?: MonitorTag[]
  allGroups?: string[]
  onClose: () => void
  onSaved: () => void
}

export default function MonitorFormModal(props: Props) {
  const capabilities = useCapabilities()
  return capabilities.monitorModal ? <CloudflareMonitorFormModal {...props} /> : <LegacyMonitorFormModal {...props} />
}

function CloudflareMonitorFormModal({ monitor, allTags = [], onClose, onSaved, statusUnavailable = false }: Props) {
  const capabilities = useCapabilities()
  const component = monitor as Component | null
  const initialComponent = useRef(component).current
  const isAdmin = getCurrentUser()?.role === 'admin'
  const managedInGatus = component?.source === 'gatus'
  const checks = useQuery<Check[]>({ queryKey: ['checks'], queryFn: () => api.get('/admin/checks', { timeoutMs: 15_000 }), enabled: isAdmin && !managedInGatus, refetchOnMount: 'always' })
  const endpoints = useQuery<CloudflareProfile['endpoints']>({ queryKey: ['endpoints'], queryFn: () => api.get('/admin/endpoints', { timeoutMs: 15_000 }), enabled: isAdmin && !managedInGatus, refetchOnMount: 'always' })
  const alertChannels = useQuery<NonNullable<CloudflareProfile['alertChannels']>>({ queryKey: ['monitor-alert-channels'], queryFn: () => api.get('/admin/monitor-alert-channels', { timeoutMs: 15_000 }), enabled: isAdmin && !!capabilities.notifications && !managedInGatus, refetchOnMount: 'always' })
  const dependencyMonitors = useQuery<Component[]>({ queryKey: ['dependency-monitors'], queryFn: () => api.get('/admin/monitors', { timeoutMs: 15_000 }), enabled: isAdmin && !!capabilities.dependencies && !managedInGatus, refetchOnMount: 'always' })
  const history = useQuery<History>({ queryKey: ['monitor-history', component?.id], queryFn: () => api.get(`/admin/monitors/${component!.id}/history`), enabled: !!component && !managedInGatus })

  if (managedInGatus) return <LegacyMonitorFormModal monitor={monitor} statusUnavailable={statusUnavailable} onClose={onClose} onSaved={onSaved} />

  // Do not unmount a populated editor when a background refresh fails: its
  // in-progress form is the only copy of the operator's draft. Hide it until
  // both check settings and the monitor status are available again.
  const settingsUnavailable = isAdmin && (checks.isError || endpoints.isError || (!!capabilities.notifications && alertChannels.isError) || (!!capabilities.dependencies && dependencyMonitors.isError))
  if (settingsUnavailable && (!checks.data || !endpoints.data)) return <Modal title={component ? 'Edit Monitor' : 'New Monitor'} icon="edit" onClose={onClose} flush>
    <div className="p-6 space-y-3"><Alert tone="error">Could not load check settings.</Alert><button type="button" className="btn btn-secondary" onClick={() => { void Promise.all([checks.refetch(), endpoints.refetch()]) }}>Retry check settings</button></div>
    <ModalFooter><button type="button" className="btn btn-secondary" onClick={onClose}>Close</button></ModalFooter>
  </Modal>
  if (isAdmin && !!capabilities.notifications && alertChannels.isError && !alertChannels.data) return <Modal title={component ? 'Edit Monitor' : 'New Monitor'} icon="edit" onClose={onClose} flush><div className="p-6 space-y-3"><Alert tone="error">Could not load alert channels.</Alert><button type="button" className="btn btn-secondary" onClick={() => { void alertChannels.refetch() }}>Retry alert channels</button></div><ModalFooter><button type="button" className="btn btn-secondary" onClick={onClose}>Close</button></ModalFooter></Modal>
  if (isAdmin && !!capabilities.dependencies && dependencyMonitors.isError && !dependencyMonitors.data) return <Modal title={component ? 'Edit Monitor' : 'New Monitor'} icon="edit" onClose={onClose} flush><div className="p-6 space-y-3"><Alert tone="error">Could not load monitors for dependencies.</Alert><button type="button" className="btn btn-secondary" onClick={() => { void dependencyMonitors.refetch() }}>Retry monitors</button></div><ModalFooter><button type="button" className="btn btn-secondary" onClick={onClose}>Close</button></ModalFooter></Modal>
  if (isAdmin && !!capabilities.dependencies && !dependencyMonitors.isFetchedAfterMount) return <p role="status">Loading monitors…</p>
  if (isAdmin && (!checks.isFetchedAfterMount || !endpoints.isFetchedAfterMount || (!!capabilities.notifications && !alertChannels.isFetchedAfterMount))) return <p role="status">Loading check settings…</p>

  const profile: CloudflareProfile = {
    isAdmin,
    monitorAuth: !!capabilities.monitorAuth,
    monitorRequest: !!capabilities.monitorRequest,
    monitorAlerts: isAdmin && !!capabilities.notifications,
    monitorActions: isAdmin && !!capabilities.actions,
    actionsPanel: isAdmin && capabilities.actions ? <CloudflareActionsPanel componentId={component?.uuid} /> : undefined,
    monitorDependencies: isAdmin && !!capabilities.dependencies,
    dependencyMonitors: (dependencyMonitors.data ?? []).filter(item => item.source !== 'gatus'),
    dependsOnIds: initialComponent?.dependsOnIds ?? [],
    alertChannels: alertChannels.data ?? [],
    alertChannelIds: initialComponent?.channelIds ?? [],
    listVaults: () => api.get('/admin/vaults'),
    listVaultSecrets: vaultId => api.get(`/admin/vaults/${vaultId}/secrets`),
    statusUnavailable: statusUnavailable || settingsUnavailable,
    settingsUnavailable,
    alertSettingsUnavailable: !!capabilities.notifications && alertChannels.isError,
    retrySettings: settingsUnavailable ? () => { void Promise.all([checks.refetch(), endpoints.refetch(), ...(capabilities.notifications ? [alertChannels.refetch()] : []), ...(capabilities.dependencies ? [dependencyMonitors.refetch()] : [])]) } : undefined,
    endpoints: endpoints.data ?? [],
    check: checks.data?.find(item => item.componentId === component?.uuid),
    manualStatus: component?.manualStatus ?? 'operational',
    position: component?.position ?? 0,
    history: component && <section aria-label="Check history">
      <h3 className="font-bold">Recent check history</h3>
      {history.data && <p className="text-sm">History beyond {history.data.retentionDays} days is unavailable. Showing the most recent 20 samples.</p>}
      {history.data?.results.length === 0 && <p>No samples for this check configuration.</p>}
      {history.data?.results.slice(-20).reverse().map(sample => <p key={sample.completedAt}>{new Date(sample.completedAt).toLocaleString()} · {sample.status} · HTTP {sample.httpStatus ?? '—'} · {sample.latencyMs} ms</p>)}
      {history.isError && <p role="alert">Could not load check history.</p>}
    </section>,
    save: async draft => {
      const body = { ...draft, ...(initialComponent ? { version: initialComponent.version } : {}) }
      if (initialComponent) await api.patch(`/admin/monitors/${initialComponent.id}`, body)
      else await api.post('/admin/monitors', body)
    },
    test: draft => api.post('/admin/monitors/test', draft, { timeoutMs: 15_000 }),
  }
  return <UpstreamMonitorFormModal monitor={monitor} allTags={allTags} cloudflare={profile} onClose={onClose} onSaved={onSaved} />
}
