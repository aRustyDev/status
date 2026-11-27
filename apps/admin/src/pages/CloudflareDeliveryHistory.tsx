// Adapts the incorporated upstream Delivery History page for Workers delivery records.
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { Alert, DataTable, DataTh, EmptyTableRow, ErrorState, LoadingState, PageContainer, PageHeader, Pagination, formatDateTime } from '@better-forge/ui'
import { api } from '../api/client'

type Tab = 'notifications' | 'actions'
type Attempt = { attemptNumber: number; completedAt: number; result: string }
type Delivery = {
  id: string; createdAt: number; updatedAt: number; monitorName: string | null; monitorStatus: string | null
  state: string; channelId?: string; channelName?: string; channelType?: string; event?: string
  attemptCount?: number; errorCode?: string | null; canRetry?: boolean; actionId?: string; actionName?: string
  attempts?: Attempt[]
}
type List = { items: Delivery[]; total: number; page: number; pages: number; filters: { id: string; name: string }[] }

const labels: Record<string, string> = {
  pending: 'Pending', sending: 'Sending', sent: 'Delivered', failed: 'Failed',
  executing: 'Executing', completed: 'Completed', unavailable: 'Unavailable', uncertain: 'Uncertain',
  alert: 'Alert', recovery: 'Recovery', test: 'Test', delivery_failed: 'Delivery failed',
}
const label = (value: string) => labels[value] ?? value

function HistoryTab({ tab }: { tab: Tab }) {
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')
  const [source, setSource] = useState('')
  const [event, setEvent] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [retryError, setRetryError] = useState(false)
  const qc = useQueryClient()
  const params = new URLSearchParams({ page: String(page), limit: '20' })
  if (status) params.set('status', status)
  if (source) params.set(tab === 'notifications' ? 'channelId' : 'actionId', source)
  if (event) params.set('event', event)
  const path = `/admin/delivery-history/${tab}`
  const list = useQuery<List>({ queryKey: ['delivery-history', tab, page, status, source, event], queryFn: () => api.get(`${path}?${params}`), refetchInterval: 30_000 })
  const detail = useQuery<Delivery>({ queryKey: ['delivery-history-detail', tab, expanded], queryFn: () => api.get(`${path}/${encodeURIComponent(expanded!)}`), enabled: expanded !== null, refetchInterval: 30_000 })
  useEffect(() => {
    if (list.data && page > list.data.pages) {
      setPage(list.data.pages)
      setExpanded(null)
    }
  }, [list.data, page])
  const retry = useMutation({
    mutationFn: (id: string) => api.post(`${path}/${encodeURIComponent(id)}/retry`, {}),
    onSuccess: async () => { setRetryError(false); await Promise.all([qc.invalidateQueries({ queryKey: ['delivery-history', tab] }), qc.invalidateQueries({ queryKey: ['delivery-history-detail', tab] })]) },
    onError: async () => { setRetryError(true); await Promise.all([qc.invalidateQueries({ queryKey: ['delivery-history', tab] }), qc.invalidateQueries({ queryKey: ['delivery-history-detail', tab] })]) },
  })
  function changeFilter(setter: (value: string) => void, value: string) {
    setter(value)
    setPage(1)
    setExpanded(null)
  }
  const notification = tab === 'notifications'
  const statuses = notification ? ['pending', 'sending', 'sent', 'failed'] : ['pending', 'executing', 'completed', 'unavailable', 'uncertain']
  return <section className="space-y-4 pt-2">
    <div className="flex flex-wrap gap-2">
      <select aria-label="Status" className="input-sig text-sm" value={status} onChange={e => changeFilter(setStatus, e.target.value)}>
        <option value="">All statuses</option>{statuses.map(value => <option key={value} value={value}>{label(value)}</option>)}
      </select>
      <select aria-label={notification ? 'Channel' : 'Action'} className="input-sig text-sm" value={source} onChange={e => changeFilter(setSource, e.target.value)}>
        <option value="">{notification ? 'All channels' : 'All actions'}</option>{list.data?.filters.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      {notification && <select aria-label="Event" className="input-sig text-sm" value={event} onChange={e => changeFilter(setEvent, e.target.value)}>
        <option value="">All events</option>{['alert', 'recovery', 'test'].map(value => <option key={value} value={value}>{label(value)}</option>)}
      </select>}
    </div>
    {retryError && <Alert tone="error">Could not queue the retry. Check that the delivery is still eligible.</Alert>}
    <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
      {list.isLoading ? <LoadingState label="Loading delivery history…" /> : list.isError ? <ErrorState message="Could not load delivery history." onRetry={() => void list.refetch()} /> : <div className="overflow-x-auto"><DataTable className="w-full text-sm min-w-[700px]">
        <thead><tr>{['Time', 'Monitor', notification ? 'Channel' : 'Action', notification ? 'Event' : 'Monitor status', ...(notification ? ['Attempts'] : []), 'Status', ''].map((heading, index) => <DataTh key={heading || index} className="px-4 py-3 text-left">{heading || <span className="sr-only">Details</span>}</DataTh>)}</tr></thead>
        <tbody>{list.data?.items.map(item => <DeliveryRows key={item.id} item={item} notification={notification} expanded={expanded === item.id} detail={expanded === item.id ? detail : null} retrying={retry.isPending || detail.isFetching} onToggle={() => { setExpanded(expanded === item.id ? null : item.id); setRetryError(false) }} onRetry={() => retry.mutate(item.id)} />)}
          {!list.data?.items.length && <EmptyTableRow colSpan={notification ? 7 : 6} icon="outbox" title="No deliveries found" />}
        </tbody>
      </DataTable></div>}
    </div>
    {list.data && <Pagination page={page} pageCount={list.data.pages} onPageChange={next => { setPage(next); setExpanded(null) }} summary={`Page ${page} of ${list.data.pages} · ${list.data.total} ${notification ? 'deliveries' : 'runs'}`} />}
  </section>
}

function DeliveryRows({ item, notification, expanded, detail, retrying, onToggle, onRetry }: {
  item: Delivery; notification: boolean; expanded: boolean; detail: { data: Delivery | undefined; isLoading: boolean; isError: boolean; refetch: () => unknown } | null
  retrying: boolean; onToggle: () => void; onRetry: () => void
}) {
  const sourceName = (notification ? item.channelName : item.actionName) ?? 'Unknown'
  const monitorName = item.monitorName ?? 'Channel test'
  const detailsId = `history-details-${item.id}`
  return <>
    <tr style={{ borderTop: '1px solid var(--m3-outline-variant)' }}>
      <td className="px-4 py-3 whitespace-nowrap">{formatDateTime(item.createdAt)}</td>
      <td className="px-4 py-3">{monitorName}</td><td className="px-4 py-3">{sourceName}</td>
      <td className="px-4 py-3">{label(notification ? item.event ?? '' : item.monitorStatus ?? '')}</td>
      {notification && <td className="px-4 py-3">{item.attemptCount}</td>}
      <td className="px-4 py-3">{label(item.state)}</td>
      <td className="px-4 py-3"><button type="button" className="btn-icon" aria-expanded={expanded} aria-controls={expanded ? detailsId : undefined} aria-label={`${expanded ? 'Hide' : 'Show'} details for ${monitorName} via ${sourceName}`} onClick={onToggle}><span className="material-symbols-outlined" aria-hidden="true">{expanded ? 'expand_less' : 'expand_more'}</span></button></td>
    </tr>
    {expanded && <tr id={detailsId}><td colSpan={notification ? 7 : 6} className="px-4 py-4" style={{ background: 'var(--m3-surface-container)' }}>
      {detail?.isLoading ? <LoadingState label="Loading details…" /> : detail?.isError ? <ErrorState message="Could not load details." onRetry={() => void detail.refetch()} /> : detail?.data && <>
        {detail.data.errorCode && <p>{label(detail.data.errorCode)}</p>}
        {notification && <div><p className="font-semibold">Attempts</p>{detail.data.attempts?.length ? detail.data.attempts.map(attempt => <p key={attempt.attemptNumber} className="text-sm">#{attempt.attemptNumber} · {label(attempt.result)} · {formatDateTime(attempt.completedAt)}</p>) : <p>No individual attempt details available.</p>}</div>}
        {!notification && <p>Updated {formatDateTime(detail.data.updatedAt)}. {detail.data.state === 'uncertain' && 'The external system may have acted.'}</p>}
        {notification && detail.data.canRetry && <button type="button" className="btn btn-primary mt-3" disabled={retrying} onClick={onRetry}>{retrying ? 'Retrying…' : 'Retry now'}</button>}
      </>}
    </td></tr>}
  </>
}

export default function CloudflareDeliveryHistory() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tab: Tab = searchParams.get('tab') === 'actions' ? 'actions' : 'notifications'
  return <PageContainer><PageHeader title="Delivery history" subtitle="Inspect delivery attempts and errors.">
    <div role="tablist" aria-label="Delivery history sections" className="flex gap-6" style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
      {(['notifications', 'subscribers', 'actions'] as const).map(item => <button key={item} type="button" role="tab" disabled={item === 'subscribers'} aria-selected={item === tab} aria-controls={item === tab ? 'delivery-history-panel' : undefined} id={`delivery-history-tab-${item}`} onClick={() => { if (item !== 'subscribers') setSearchParams({ tab: item }) }} className="inline-flex items-center gap-2 px-0.5 pb-3 -mb-px text-sm font-semibold focus-ring disabled:opacity-50" style={{ borderBottom: `2px solid ${item === tab ? 'var(--m3-on-surface)' : 'transparent'}` }}>{item === 'notifications' ? 'Notifications' : item === 'actions' ? 'Actions' : 'Subscribers (unavailable)'}</button>)}
    </div>
  </PageHeader><div role="tabpanel" id="delivery-history-panel" aria-labelledby={`delivery-history-tab-${tab}`}><HistoryTab key={tab} tab={tab} /></div></PageContainer>
}
