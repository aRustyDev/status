import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, EmptyState, ErrorState, LoadingState, PageContainer, PageHeader, formatDateTime } from '@better-forge/ui'
import { api } from '../api/client'

// Adapted from @better-forge/ui's BackupsPage (MIT; see THIRD_PARTY_LICENSE_BetterStatusPage).
// Cloudflare exports D1 to private object storage; the Node archive and scheduler APIs do not apply.
type Backup = { id: string; state: 'running' | 'complete' | 'failed' | 'unavailable'; createdAt: number; size?: number; sha256?: string }
type BackupList = { backups: Backup[]; nextCursor: string | null }

export default function BackupsPage() {
  const queryClient = useQueryClient()
  const [cursors, setCursors] = useState<string[]>([])
  const cursor = cursors.at(-1)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const backups = useQuery<BackupList>({ queryKey: ['backups', cursor], queryFn: () => api.get(`/admin/backups${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`), refetchInterval: query => query.state.data?.backups.some(item => item.state === 'running') ? 5000 : false })
  async function create() {
    setBusy('create'); setMessage(null)
    try { await api.post('/admin/backups', {}); setCursors([]); await queryClient.invalidateQueries({ queryKey: ['backups'] }); setMessage({ tone: 'success', text: 'Backup started. Its status will update here.' }) }
    catch (error) { setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Could not start backup.' }) }
    finally { setBusy(null) }
  }
  async function verify(id: string) {
    setBusy(id); setMessage(null)
    try {
      const result = await api.get<{ valid: boolean }>(`/admin/backups/${id}/verify`, { timeoutMs: 120_000 })
      if (result.valid !== true) throw new Error('Backup verification failed.')
      setMessage({ tone: 'success', text: 'The stored backup passed its integrity check. Verify recovery in an isolated database before relying on it.' })
    }
    catch (error) { setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Backup verification failed.' }) }
    finally { setBusy(null) }
  }
  return <PageContainer>
    <PageHeader title="Backups" subtitle="Create, inspect and verify Cloudflare D1 exports." />
    {message && <Alert tone={message.tone} onDismiss={() => setMessage(null)}>{message.text}</Alert>}
    <section className="rounded-2xl p-6 space-y-4" style={{ background: 'var(--m3-surface-container-lowest)', color: 'var(--m3-on-surface)' }}>
      <button type="button" disabled={busy !== null} onClick={() => void create()} className="btn btn-primary">{busy === 'create' ? 'Starting backup…' : 'Create backup'}</button>
      <p className="text-sm" style={{ color: 'var(--m3-secondary)' }}>D1 exports can temporarily lock the database. Downloads contain application data; protect them as sensitive. Cloudflare configuration, credentials, external services and the Gatus database are not included.</p>
      <p className="text-sm" style={{ color: 'var(--m3-secondary)' }}>Restore is unavailable in this console. Follow the <a className="underline" href="https://github.com/aRustyDev/status/blob/main/docs/cloudflare-backups.md" target="_blank" rel="noreferrer">Cloudflare D1 backups and recovery guide</a> to verify and download an export, then test it in an isolated database. For live recovery, stop writers and confirm the target before restoring; a restore can overwrite data.</p>
    </section>
    <section className="rounded-2xl p-6 space-y-2" style={{ background: 'var(--m3-surface-container-lowest)', color: 'var(--m3-on-surface)' }}>
      <h2 className="font-headline text-xl font-semibold">Automatic backups</h2>
      <p className="text-sm" style={{ color: 'var(--m3-secondary)' }}>Scheduling is unavailable. Retention is controlled by the backup bucket lifecycle policy.</p>
      <button type="button" className="btn btn-secondary" disabled>Configure schedule</button>
    </section>
    <section className="rounded-2xl overflow-hidden" style={{ background: 'var(--m3-surface-container-lowest)', color: 'var(--m3-on-surface)' }}>
      <h2 className="font-headline text-xl font-semibold p-6 pb-3">Available backups</h2>
      {backups.isLoading ? <LoadingState label="Loading backups…" /> : backups.isError ? <ErrorState message="Could not load backups." onRetry={() => void backups.refetch()} /> : !backups.data?.backups.length ? <EmptyState variant="inset" icon="cloud_off" title="No backups yet" description="Create a backup to begin." /> : backups.data.backups.map(item => <div key={item.id} className="p-4 px-6 flex flex-wrap items-center justify-between gap-3" style={{ borderTop: '1px solid var(--m3-outline-variant)' }}>
        <div className="min-w-0"><div className="font-mono text-sm break-all">{item.id}</div><div className="text-xs" style={{ color: 'var(--m3-secondary)' }}>{formatDateTime(item.createdAt)} · {item.state}{item.size !== undefined ? ` · ${(item.size / 1024 / 1024).toFixed(2)} MB` : ''}</div>{item.sha256 && <div className="font-mono text-xs break-all">SHA-256: {item.sha256}</div>}</div>
        <div className="flex gap-2"><button type="button" disabled={busy !== null || item.state !== 'complete'} onClick={() => void verify(item.id)} className="btn btn-secondary btn-sm">{busy === item.id ? 'Verifying…' : 'Verify'}</button>{item.state === 'complete' && <a className="btn btn-secondary btn-sm" href={`/api/v1/bsp/admin/backups/${item.id}/download`} download>Download</a>}</div>
      </div>)}
      {(cursor || backups.data?.nextCursor) && <div className="flex gap-2 p-4"><button type="button" className="btn btn-secondary btn-sm" disabled={!cursor} onClick={() => setCursors(previous => previous.slice(0, -1))}>Previous</button><button type="button" className="btn btn-secondary btn-sm" disabled={!backups.data?.nextCursor} onClick={() => { if (backups.data?.nextCursor) setCursors(previous => [...previous, backups.data!.nextCursor!]) }}>Next</button></div>}
    </section>
  </PageContainer>
}
