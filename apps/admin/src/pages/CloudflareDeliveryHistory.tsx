import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { DataTable, DataTh, EmptyTableRow, ErrorState, LoadingState, PageContainer, PageHeader, Pagination, formatDateTime } from '@better-forge/ui'
import { api } from '../api/client'

type Action = { id: string; name: string }
type Check = { id: string; name: string }
type Run = { actionId: string; checkId: string; scheduledAt: number; status: string; state: 'pending' | 'executing' | 'completed' | 'unavailable' | 'uncertain'; updatedAt: number }

const stateLabels: Record<Run['state'], string> = {
  pending: 'Pending',
  executing: 'Executing',
  completed: 'Completed',
  unavailable: 'Unavailable',
  uncertain: 'Uncertain',
}

export default function CloudflareDeliveryHistory() {
  const [state, setState] = useState('')
  const [actionId, setActionId] = useState('')
  const [page, setPage] = useState(1)
  const runs = useQuery<Run[]>({ queryKey: ['worker-action-runs'], queryFn: () => api.get('/admin/actions/runs'), refetchInterval: 30_000 })
  const actions = useQuery<Action[]>({ queryKey: ['worker-actions'], queryFn: () => api.get('/admin/actions') })
  const checks = useQuery<Check[]>({ queryKey: ['worker-action-checks'], queryFn: () => api.get('/admin/actions/checks') })
  const filtered = (runs.data ?? []).filter(run => (!state || run.state === state) && (!actionId || run.actionId === actionId))
  const pages = Math.max(1, Math.ceil(filtered.length / 20))
  const currentPage = Math.min(page, pages)
  const visible = filtered.slice((currentPage - 1) * 20, currentPage * 20)

  return <PageContainer>
    <PageHeader title="Delivery history" subtitle="Inspect recent action outcomes.">
      <div role="tablist" aria-label="Delivery history sections" className="flex gap-6" style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
        <button type="button" role="tab" aria-selected="false" disabled>Notifications</button>
        <button type="button" role="tab" aria-selected="false" disabled>Subscribers</button>
        <button type="button" role="tab" id="delivery-history-tab-actions" aria-selected="true" aria-controls="delivery-history-panel" className="pb-3 font-semibold" style={{ borderBottom: '2px solid var(--m3-on-surface)' }}>Actions</button>
      </div>
    </PageHeader>
    <section role="tabpanel" id="delivery-history-panel" aria-labelledby="delivery-history-tab-actions" className="space-y-4 pt-2">
      <p className="text-sm">The latest 100 action runs are shown. An uncertain outcome may mean the destination acted. Inspect it before taking further action.</p>
      <div className="grid grid-cols-2 gap-2 max-w-xl">
        <select aria-label="Outcome" className="input-sig text-sm" value={state} onChange={event => { setState(event.target.value); setPage(1) }}>
          <option value="">All outcomes</option>
          {Object.entries(stateLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select aria-label="Action" className="input-sig text-sm" value={actionId} onChange={event => { setActionId(event.target.value); setPage(1) }}>
          <option value="">All actions</option>
          {actions.data?.map(action => <option key={action.id} value={action.id}>{action.name}</option>)}
        </select>
      </div>
      {(actions.isError || checks.isError) && <p role="alert">Some action or monitor names could not be loaded.</p>}
      <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
        {runs.isLoading ? <LoadingState label="Loading runs…" /> : runs.isError ? <ErrorState message="Could not load action runs." onRetry={() => void runs.refetch()} /> :
          <div className="overflow-x-auto"><DataTable className="w-full min-w-[700px] text-sm">
            <thead><tr style={{ background: 'var(--m3-surface-container)' }}>{['Scheduled', 'Monitor', 'Action', 'Trigger', 'Outcome', 'Updated'].map(label => <DataTh key={label} className="px-4 py-3 text-left font-mono text-xs uppercase">{label}</DataTh>)}</tr></thead>
            <tbody>
              {visible.map((run, index) => <tr key={`${run.actionId}-${run.checkId}-${run.scheduledAt}-${index}`}>
                <td className="px-4 py-3">{formatDateTime(run.scheduledAt)}</td>
                <td className="px-4 py-3">{checks.data?.find(check => check.id === run.checkId)?.name ?? run.checkId}</td>
                <td className="px-4 py-3">{actions.data?.find(action => action.id === run.actionId)?.name ?? run.actionId}</td>
                <td className="px-4 py-3">{run.status}</td>
                <td className="px-4 py-3">{stateLabels[run.state]}</td>
                <td className="px-4 py-3">{formatDateTime(run.updatedAt)}</td>
              </tr>)}
              {visible.length === 0 && <EmptyTableRow colSpan={6} icon="bolt" title={state || actionId ? 'No runs match these filters.' : 'No runs yet'} description="Action outcomes appear here when monitors change status." />}
            </tbody>
          </DataTable></div>}
      </div>
      {runs.data && <Pagination hideWhenSingle={false} page={currentPage} pageCount={pages} onPageChange={setPage} summary={`Page ${currentPage} of ${pages} · ${filtered.length} runs`} />}
    </section>
  </PageContainer>
}
