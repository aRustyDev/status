import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, ApiError, DataTable, DataTh, EmptyState, ErrorState, LoadingState, Modal, ModalFooter, PageContainer, PageHeader, useTableSort } from '@better-forge/ui'
import { api } from '../api/client'

type Role = 'viewer' | 'operator' | 'admin'
type User = { id: string; email: string; role: Role; version: number }
const roles: { value: Role; label: string; desc: string }[] = [
  { value: 'viewer', label: 'Viewer', desc: 'View the status page' },
  { value: 'operator', label: 'Operator', desc: 'Manage monitoring' },
  { value: 'admin', label: 'Admin', desc: 'Full access' },
]
const rank: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 }

export default function Users({ identityId }: { identityId: string }) {
  const queryClient = useQueryClient()
  const queryKey = ['users', identityId]
  const users = useQuery<User[]>({ queryKey, queryFn: () => api.get('/admin/users') })
  const { rows, sort } = useTableSort(users.data ?? [], { email: user => user.email, role: user => rank[user.role] })
  const [target, setTarget] = useState<{ user: User; role: Role } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function save() {
    if (!target || busy) return
    setBusy(true)
    setError('')
    try {
      await api.patch(`/admin/users/${target.user.id}`, { role: target.role, version: target.user.version })
      setTarget(null)
      setNotice(`Role updated for ${target.user.email}.`)
      await queryClient.invalidateQueries({ queryKey })
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && !err.code) {
        setTarget(null)
        setNotice('The user or your permissions changed. Review the refreshed list before trying again.')
        await queryClient.invalidateQueries({ queryKey })
      } else {
        setError(err instanceof Error ? err.message : 'Could not update role.')
      }
    } finally {
      setBusy(false)
    }
  }

  return <PageContainer>
    <PageHeader title="Users" subtitle={users.data ? `${users.data.length} user${users.data.length === 1 ? '' : 's'}` : undefined} />
    <p className="text-sm mb-4">Cloudflare Access manages invitations, identity and sign-in. People appear here after their first sign-in. Administrators can manage their application roles.</p>
    {notice && <Alert tone="info" onDismiss={() => setNotice('')}>{notice}</Alert>}
    {users.isPending ? <LoadingState label="Loading users…" /> : users.isError ? <ErrorState message="Could not load users." onRetry={() => void users.refetch()} /> : users.data.length === 0 ? <EmptyState title="No users found" /> :
      <div className="rounded-2xl overflow-x-auto" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
        <DataTable sort={sort} className="w-full min-w-[480px] text-sm">
          <thead><tr style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
            <DataTh sortKey="email" resizable className="px-4 py-3 text-left">Email</DataTh>
            <DataTh sortKey="role" resizable className="px-4 py-3 text-left">Role</DataTh>
          </tr></thead>
          <tbody>{rows.map(user => <tr key={user.id} style={{ borderTop: '1px solid var(--m3-outline-variant)' }}>
            <td className="px-4 py-3 font-medium">{user.email}</td>
            <td className="px-4 py-3">{user.id === identityId ? <span>Admin <span className="text-xs">(you)</span></span> :
              <div role="group" aria-label={`Role for ${user.email}`} className="flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--m3-outline-variant)', width: 'fit-content' }}>
                {roles.map(role => <button key={role.value} type="button" title={role.desc} aria-pressed={user.role === role.value} disabled={busy} className={`text-xs font-medium px-3 py-1.5 focus-ring ${user.role === role.value ? 'selection-active' : ''}`} onClick={() => { if (user.role !== role.value) { setNotice(''); setError(''); setTarget({ user, role: role.value }) } }}>{role.label}</button>)}
              </div>}</td>
          </tr>)}</tbody>
        </DataTable>
      </div>}
    {target && <Modal icon="group" title="Change role" onClose={() => { if (!busy) setTarget(null) }}>
      <div className="p-6 space-y-3">
        <p>Change {target.user.email} from {target.user.role} to {target.role}?{rank[target.role] < rank[target.user.role] && ' They will lose access to some areas immediately.'}</p>
        {error && <p role="alert">{error}</p>}
      </div>
      <ModalFooter><button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setTarget(null)}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Change role'}</button></ModalFooter>
    </Modal>}
  </PageContainer>
}
