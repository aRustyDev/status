import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Alert } from '@better-forge/ui'
import { api } from '../../api/client'
import { ActionsSection, type ActionLink } from '../../../../admin-node/src/components/monitors/MonitorSidePanel'

type Link = ActionLink<string>
type Action = { id: string; name: string; enabled: boolean | number }
type LinkSettings = { links: Link[]; version: number }

export function CloudflareActionsPanel({ componentId }: { componentId?: string | undefined }) {
  if (!componentId) return <p>Save the monitor first, then reopen it to configure actions.</p>
  return <LoadedActionsPanel componentId={componentId} />
}

function LoadedActionsPanel({ componentId }: { componentId: string }) {
  const actions = useQuery<Action[]>({ queryKey: ['monitor-actions-catalog'], queryFn: () => api.get('/admin/actions'), refetchOnMount: 'always', refetchOnWindowFocus: false, refetchOnReconnect: false })
  const links = useQuery<LinkSettings>({ queryKey: ['monitor-action-links', componentId], queryFn: () => api.get(`/admin/actions/monitor/${componentId}`), refetchOnMount: 'always', refetchOnWindowFocus: false, refetchOnReconnect: false })
  if (!actions.isFetchedAfterMount || !links.isFetchedAfterMount || actions.isError || links.isError || !actions.data || !links.data) {
    if (actions.isError || links.isError) return <><Alert tone="error">Could not load monitor actions.</Alert><button type="button" className="btn btn-secondary" onClick={() => { void actions.refetch(); void links.refetch() }}>Retry actions</button></>
    return <p role="status">Loading actions…</p>
  }
  return <ActionLinkEditor componentId={componentId} actions={actions.data} initial={links.data} />
}

function ActionLinkEditor({ componentId, actions, initial }: { componentId: string; actions: Action[]; initial: LinkSettings }) {
  const [links, setLinks] = useState(initial.links)
  const [version, setVersion] = useState(initial.version)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  async function save() {
    const unique = new Set(links.map(link => JSON.stringify([link.actionId, link.onStatus])))
    if (unique.size !== links.length) { setError('An action can be linked only once per status.'); return }
    if (links.some(link => !actions.some(action => action.id === link.actionId))) { setError('Remove unavailable actions before saving.'); return }
    if (links.some(link => !Number.isInteger(link.delayMinutes) || !Number.isInteger(link.cooldownMinutes) || link.delayMinutes < 0 || link.delayMinutes > 10080 || link.cooldownMinutes < 0 || link.cooldownMinutes > 10080)) { setError('Delay and cooldown must be whole minutes from 0 to 10080.'); return }
    setBusy(true)
    setError('')
    setSaved(false)
    try {
      const result = await api.put<LinkSettings>(`/admin/actions/monitor/${componentId}`, { links, version })
      setLinks(result.links)
      setVersion(result.version)
      setSaved(true)
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save monitor actions.') }
    finally { setBusy(false) }
  }
  return <div className="space-y-3">
    <p className="text-xs">Save action links separately from monitor settings. The first valid check establishes a baseline; actions run on later status changes. Existing degraded triggers remain active until the action is unlinked from this monitor.</p>
    <ActionsSection actions={actions} links={links} onChange={value => { setLinks(value); setSaved(false); setError('') }} />
    {error && <Alert tone="error">{error}</Alert>}
    {saved && <p role="status">Monitor actions saved.</p>}
    <button type="button" disabled={busy} className="btn btn-primary" onClick={() => void save()}>Save actions</button>
  </div>
}
