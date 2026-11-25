// Adapts the upstream Notifications page to the supported Workers providers.
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, ConfirmModal, DataTable, DataTh, ErrorState, LoadingState, PageContainer, PageHeader, QuickStartPanel, useTableSort, type QuickStartOption } from '@better-forge/ui'
import { api } from '../api/client'
import CloudflareChannelForm, { type Channel } from '../components/notifications/CloudflareChannelForm'
import { CHANNEL_TYPES } from '../components/notifications/channelTypes'

type ChannelType = 'email' | 'webhook'
type Choice = { id: string; name: string }
type Delivery = { channelId: string; checkId: string; status: string; state: string; attempts: number; errorCode: string | null; updatedAt: number }

export default function CloudflareNotifications() {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<Channel | 'new' | null>(null)
  const [initialType, setInitialType] = useState<ChannelType>('webhook')
  const [removing, setRemoving] = useState<Channel | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const channels = useQuery<Channel[]>({ queryKey: ['worker-channels'], queryFn: () => api.get('/admin/notifications/channels') })
  const deliveries = useQuery<Delivery[]>({ queryKey: ['worker-channel-deliveries'], queryFn: () => api.get('/admin/notifications/deliveries') })
  const destinations = useQuery<Choice[]>({ queryKey: ['worker-channel-destinations'], queryFn: () => api.get('/admin/notifications/destinations') })
  const emailDestinations = useQuery<Choice[]>({ queryKey: ['worker-email-destinations'], queryFn: () => api.get('/admin/notifications/email-destinations') })
  const vaults = useQuery<Choice[]>({ queryKey: ['vaults'], queryFn: () => api.get('/admin/vaults') })
  const { rows, sort } = useTableSort(channels.data ?? [], {
    name: channel => channel.name,
    type: channel => channel.type ?? 'webhook',
    status: channel => channel.enabled,
  })
  const options: QuickStartOption<ChannelType>[] = []
  if (destinations.data?.length && vaults.data?.length) options.push({ key: 'webhook', label: CHANNEL_TYPES.webhook.label, hint: 'Approved HTTPS destination', icon: CHANNEL_TYPES.webhook.icon(18) })
  if (emailDestinations.data?.length) options.push({ key: 'email', label: CHANNEL_TYPES.email.label, hint: 'Approved email recipient', icon: CHANNEL_TYPES.email.icon(18) })
  const choicesLoading = destinations.isLoading || emailDestinations.isLoading || vaults.isLoading
  const choicesError = destinations.isError || emailDestinations.isError || vaults.isError

  function openCreate(type: ChannelType = 'webhook') {
    setInitialType(type)
    setEditing('new')
  }

  async function remove() {
    if (!removing) return
    setMessage('')
    setBusy(true)
    try {
      await api.delete(`/admin/notifications/channels/${removing.id}`, { version: removing.version, expectedAssociationVersion: removing.associationVersion })
      setRemoving(null)
      await qc.invalidateQueries({ queryKey: ['worker-channels'] })
    } catch {
      setMessage('Could not delete channel. Reload and try again.')
    } finally {
      setBusy(false)
    }
  }

  return <PageContainer>
    <PageHeader title="Notifications" subtitle="Alert channels fired when a monitor changes status" actions={<>
      <button type="button" className="btn btn-primary" onClick={() => openCreate(options[0]?.key ?? 'webhook')}>
        <span className="material-symbols-outlined" aria-hidden="true">add</span> Add Channel
      </button>
      <button type="button" className="btn btn-secondary" disabled title="SMTP settings are unavailable">SMTP Settings</button>
    </>} />
    <Alert tone="info">Create notification channels here, then assign them to individual monitors via the monitor editor. Email recipients and webhook destinations are configured by the deployment administrator. Other providers and alert policies are unavailable.</Alert>
    {message && <p role="alert">{message}</p>}
    {channels.isLoading ? <LoadingState label="Loading channels…" /> : channels.isError ? <ErrorState message="Could not load notification channels." onRetry={() => void channels.refetch()} /> : channels.data?.length === 0 ? <>
      {options.length > 0 && <QuickStartPanel title="Where should alerts go?" description="Pick a channel type. You can assign it to monitors afterwards." options={options} onPick={openCreate} />}
      {options.length === 0 && (choicesLoading ? <p role="status">Loading available channel types…</p> : choicesError ? <p role="alert">Could not load available channel types. <button type="button" className="underline" onClick={() => { if (destinations.isError) void destinations.refetch(); if (emailDestinations.isError) void emailDestinations.refetch(); if (vaults.isError) void vaults.refetch() }}>Retry</button></p> : <p>No channels yet. Configure an approved destination to create one.</p>)}
    </> : <div className="rounded-2xl overflow-x-auto" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
      <DataTable sort={sort} className="w-full min-w-[600px] text-sm">
        <thead><tr style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
          <DataTh sortKey="name" className="px-4 py-3 text-left">Name</DataTh>
          <DataTh sortKey="type" className="px-4 py-3 text-left">Type</DataTh>
          <DataTh className="px-4 py-3 text-left">Monitors with checks</DataTh>
          <DataTh sortKey="status" className="px-4 py-3 text-left">Status</DataTh>
          <DataTh className="px-4 py-3 text-right"><span className="sr-only">Actions</span></DataTh>
        </tr></thead>
        <tbody>{rows.map(channel => <tr key={channel.id} style={{ borderTop: '1px solid var(--m3-outline-variant)' }}>
          <td className="px-4 py-3 font-medium">{channel.name}</td>
          <td className="px-4 py-3">{channel.type === 'email' ? 'Email' : 'Webhook'}</td>
          <td className="px-4 py-3">{channel.checkIds.length}</td>
          <td className="px-4 py-3">{channel.enabled ? 'Enabled' : 'Disabled'}</td>
          <td className="px-4 py-3 text-right"><div className="flex justify-end gap-2">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(channel)}>Edit</button>
            <button type="button" className="btn-icon" aria-label={`Delete channel ${channel.name}`} onClick={() => { setMessage(''); setRemoving(channel) }}>×</button>
          </div></td>
        </tr>)}</tbody>
      </DataTable>
    </div>}
    <section className="mt-6"><h2 className="font-headline font-bold">Recent delivery attempts</h2><p className="text-sm">An unavailable credential or destination fails closed; check Vault and deployment settings. A first unhealthy monitor result can send an alert; a first healthy result establishes a baseline.</p>
      {deliveries.isError && <p role="alert">Could not load delivery status.</p>}
      {deliveries.data?.length === 0 && <p>No deliveries yet.</p>}
      {deliveries.data?.map((delivery, index) => <p key={`${delivery.channelId}-${delivery.checkId}-${delivery.updatedAt}-${index}`} className="text-sm">{channels.data?.find(channel => channel.id === delivery.channelId)?.name ?? 'Channel'}: {delivery.status}, {delivery.state}{delivery.errorCode ? ` (${delivery.errorCode})` : ''} · attempts {delivery.attempts}</p>)}
    </section>
    {editing && <CloudflareChannelForm channel={editing === 'new' ? null : editing} initialType={initialType} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await qc.invalidateQueries({ queryKey: ['worker-channels'] }) }} />}
    {removing && <ConfirmModal title="Delete channel" message={`Delete "${removing.name}"? Its pending delivery records will also be removed.${message ? ` ${message}` : ''}`} confirmLabel="Delete" pending={busy} pendingLabel="Deleting…" onConfirm={() => void remove()} onCancel={() => { if (!busy) setRemoving(null) }} />}
  </PageContainer>
}
