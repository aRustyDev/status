import { useQuery } from '@tanstack/react-query'
import { PageContainer, PageHeader } from '@better-forge/ui'
import { api } from '../api/client'

type AuditEvent = { id: string; actorEmail: string; action: string; entityType: string; entityId: string; createdAt: number }
export default function AuditLog() {
  const events = useQuery<AuditEvent[]>({ queryKey: ['audit'], queryFn: () => api.get('/admin/audit') })
  return <PageContainer><PageHeader title="Audit Log" />
    {events.isError && <p role="alert">Could not load audit history.</p>}
    {events.data?.map(event => <div key={event.id} className="p-3">
      <span>{event.actorEmail} · {event.action} {event.entityType} {event.entityId}</span>
      <time className="ml-4">{new Date(event.createdAt).toLocaleString()}</time>
    </div>)}
  </PageContainer>
}
