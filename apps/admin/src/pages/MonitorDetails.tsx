import { useQuery } from '@tanstack/react-query'
import { useToast } from '@better-forge/ui'
import { useNavigate, useParams } from 'react-router-dom'
import type { Monitor } from '@bsp/shared'
import { api } from '../api/client'
import MonitorFormModal from '../components/monitors/MonitorFormModal'
import { useNow } from '../relativeTime'

export default function MonitorDetails() {
  const { id } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const now = useNow()
  const monitors = useQuery<Monitor[]>({ queryKey: ['monitors'], queryFn: () => api.get('/admin/monitors', { timeoutMs: 15_000 }), refetchInterval: 30_000 })
  const monitor = monitors.data?.find(item => String(item.id) === id)
  const statusUnavailable = monitors.isError || (monitors.dataUpdatedAt > 0 && now - monitors.dataUpdatedAt >= 60_000)
  if (monitors.isPending) return <p>Loading monitor…</p>
  if (!monitor) return <p>Monitor unavailable.</p>
  return <MonitorFormModal monitor={monitor} statusUnavailable={statusUnavailable} onClose={() => navigate('/admin/monitors')} onSaved={() => { toast.success('Changes saved'); navigate('/admin/monitors') }} />
}
