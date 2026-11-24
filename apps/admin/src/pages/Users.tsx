import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { PageContainer, PageHeader } from '@better-forge/ui'
import { api } from '../api/client'

type User = { id: string; email: string; role: string; version: number }
export default function Users() {
  const queryClient = useQueryClient()
  const users = useQuery<User[]>({ queryKey: ['users'], queryFn: () => api.get('/admin/users') })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function change(user: User, role: string) {
    setBusy(true)
    setError('')
    try {
      await api.patch(`/admin/users/${user.id}`, { role, version: user.version })
      await queryClient.invalidateQueries({ queryKey: ['users'] })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update role')
    } finally {
      setBusy(false)
    }
  }
  return <PageContainer><PageHeader title="Users" />
    <p className="text-sm mb-4">Invitations and password management are unavailable. Cloudflare Access controls sign-in.</p>
    {error && <p role="alert">{error}</p>}
    {users.isError && <p role="alert">Could not load users.</p>}
    {users.data?.map(user => <div key={user.id} className="flex items-center justify-between p-4">
      <span>{user.email}</span>
      <label>Role <select aria-label={`Role for ${user.email}`} value={user.role} disabled={busy} onChange={event => void change(user, event.target.value)} className="input-sig">
        <option value="viewer">Viewer</option><option value="operator">Operator</option><option value="admin">Admin</option>
      </select></label>
    </div>)}
  </PageContainer>
}
