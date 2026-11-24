import { useQuery } from '@tanstack/react-query'
import { useToast } from '@better-forge/ui'
import { useNavigate, useParams } from 'react-router-dom'
import type { Monitor } from '@bsp/shared'
import { api } from '../api/client'
import MonitorFormModal from '../components/monitors/MonitorFormModal'

export default function MonitorDetails() {
  const { id } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const monitors = useQuery<Monitor[]>({ queryKey: ['monitors'], queryFn: () => api.get('/admin/monitors') })
  const monitor = monitors.data?.find(item => String(item.id) === id)
  if (monitors.isPending) return <p>Loading monitor…</p>
  if (!monitor) return <p>Monitor unavailable.</p>
  return <MonitorFormModal monitor={monitor} onClose={() => navigate('/admin/monitors')} onSaved={() => { toast.success('Changes saved'); navigate('/admin/monitors') }} />
}
