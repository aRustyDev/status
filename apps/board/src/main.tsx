import { StrictMode, useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'

type Role = 'viewer' | 'operator' | 'admin'
type Health = 'operational' | 'degraded' | 'down' | 'unknown' | 'under_maintenance'
type User = { id: string; email: string; role: Role; version: number }
type Component = { id: string; name: string; position: number; manualStatus: Health; status: Health; checkStatus?: string | null; lastCheckedAt?: number | null; underMaintenance?: boolean; version: number }
type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved'
type Update = { id: string; body: string; status: IncidentStatus; postedAt: number }
type Incident = { id: string; title: string; status: IncidentStatus; impact: 'minor' | 'major' | 'critical'; draft: boolean; componentIds: string[]; updates: Update[]; version: number }
type Maintenance = { id: string; name: string; description: string | null; startsAt: number; endsAt: number; componentIds: string[]; state: 'upcoming' | 'active' | 'past' | 'cancelled'; version: number }
type Check = { id: string; componentId: string; endpointId: string; enabled: boolean | number; intervalMinutes: number; expectedStatus: number; version: number }
type Endpoint = { id: string; name: string }
type AuditEvent = { id: string; actorEmail: string; action: string; entityType: string; entityId: string; createdAt: number; details: string | object | null }
type Board = { components: Component[]; activeIncidents: Incident[]; activeMaintenanceWindows: Maintenance[] }

const sessionExpiredMessage = 'Your Access session may have expired. Sign in again, then retry.'
class AccessSessionError extends Error {
  constructor() { super(sessionExpiredMessage) }
}

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'X-Requested-With': 'XMLHttpRequest', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) {
    if (response.status === 401) throw new AccessSessionError()
    const data = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(response.status === 409 ? 'This item changed. Refresh and try again.' : data?.error || `Request failed (${response.status})`)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

function when(value: number) { return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) }
function localDate(value: number) {
  const date = new Date(value)
  return new Date(value - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}
function label(value: string) { return value.replaceAll('_', ' ') }
function Badge({ value }: { value: string }) { return <span className={`badge ${value}`}>{label(value)}</span> }
function Card({ children }: { children: ReactNode }) { return <div className="card">{children}</div> }
function Section({ title, children }: { title: string; children: ReactNode }) { return <section className="section"><h2>{title}</h2>{children}</section> }
function ComponentSelection({ components, selected, onChange, disabled }: { components: Component[]; selected: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  return <fieldset disabled={disabled}><legend>Affected services</legend><p className="hint">Leave empty to apply to all services.</p><div className="choices">{components.map(component => <label key={component.id}><input type="checkbox" checked={selected.includes(component.id)} onChange={event => onChange(event.target.checked ? [...selected, component.id] : selected.filter(id => id !== component.id))} /> {component.name}</label>)}</div></fieldset>
}
function names(ids: string[], components: Component[]) { return ids.length ? ids.map(id => components.find(component => component.id === id)?.name ?? `Service ${id}`).join(', ') : 'All services' }

function App() {
  const [user, setUser] = useState<User | null>(null)
  const [board, setBoard] = useState<Board | null>(null)
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [windows, setWindows] = useState<Maintenance[]>([])
  const [adminComponents, setAdminComponents] = useState<Component[]>([])
  const [adminIncidents, setAdminIncidents] = useState<Incident[]>([])
  const [adminWindows, setAdminWindows] = useState<Maintenance[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [audit, setAudit] = useState<AuditEvent[]>([])
  const [checks, setChecks] = useState<Check[]>([])
  const [endpoints, setEndpoints] = useState<Endpoint[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const isAdminPage = window.location.pathname.startsWith('/admin')
  const canEdit = user?.role === 'operator' || user?.role === 'admin'

  const refresh = useCallback(async () => {
    const [me, status, incidentList, maintenanceList] = await Promise.all([
      api<User>('/auth/me'), api<Board>('/public/status'), api<Incident[]>('/public/incidents'), api<Maintenance[]>('/public/maintenances'),
    ])
    setUser(me); setBoard(status); setIncidents(incidentList); setWindows(maintenanceList)
    if (isAdminPage && me.role !== 'viewer') {
      const [components, allIncidents, allWindows] = await Promise.all([api<Component[]>('/admin/components'), api<Incident[]>('/admin/incidents'), api<Maintenance[]>('/admin/maintenance')])
      setAdminComponents(components); setAdminIncidents(allIncidents); setAdminWindows(allWindows)
      if (me.role === 'admin') {
        const [members, events, configuredChecks, availableEndpoints] = await Promise.all([api<User[]>('/admin/users'), api<AuditEvent[]>('/admin/audit'), api<Check[]>('/admin/checks'), api<Endpoint[]>('/admin/endpoints')])
        setUsers(members); setAudit(events); setChecks(configuredChecks); setEndpoints(availableEndpoints)
      }
    }
    setError('')
  }, [isAdminPage])
  useEffect(() => {
    const load = () => { if (document.visibilityState === 'visible') void refresh().catch(err => setError((err as Error).message)) }
    load()
    const timer = window.setInterval(load, 30_000)
    window.addEventListener('focus', load)
    return () => { clearInterval(timer); window.removeEventListener('focus', load) }
  }, [refresh])
  async function change(path: string, method: string, body: unknown, message: string) {
    setBusy(true); setError(''); setNotice('')
    try {
      await api(path, method, body)
      try { await refresh() } catch (err) { setError(err instanceof AccessSessionError ? `Saved. ${err.message}` : 'Saved, but the board could not refresh. Retry to see the latest data.') }
      setNotice(message)
      return true
    }
    catch (err) { setError((err as Error).message); return false }
    finally { setBusy(false) }
  }
  const services = isAdminPage && canEdit ? adminComponents : board?.components ?? []
  return <><header className="topbar"><div className="top-inner"><a className="brand" href="/">Engineering status</a><nav><a href="/">Status</a>{canEdit && <a href="/admin">Manage</a>}</nav><span className="identity">{user?.email}</span></div></header><main>
    {error && <div className="alert error" role="alert">{error} {error.includes(sessionExpiredMessage) && <a href="/" target="_blank" rel="noopener noreferrer">Sign in in a new tab</a>} <button type="button" onClick={() => void refresh().catch(err => setError((err as Error).message))}>Retry</button></div>}
    {notice && <div className="alert success" role="status">{notice}</div>}
    {!board ? !error && <p>Loading status…</p> : isAdminPage ? !canEdit ? <Card><h1>Access restricted</h1><p>Your account can view the board.</p></Card> : <>
      <div className="heading"><div><p className="eyebrow">Operations</p><h1>Manage status</h1><p>Publish incident updates and schedule maintenance for your team.</p></div><a className="button secondary" href="/">View board</a></div>
      <Section title="Services"><ComponentForm onSubmit={data => change('/admin/components', 'POST', data, 'Service added.')} busy={busy} />{adminComponents.map(component => <ComponentEditor key={component.id} component={component} onSave={data => change(`/admin/components/${component.id}`, 'PATCH', data, 'Service updated.')} busy={busy} />)}</Section>
      <Section title="Incidents"><IncidentForm components={services} busy={busy} onSubmit={data => change('/admin/incidents', 'POST', data, 'Draft created.')} />{adminIncidents.length === 0 && <p className="empty">No incidents yet.</p>}{adminIncidents.map(incident => <IncidentEditor key={incident.id} incident={incident} components={services} busy={busy} change={change} />)}</Section>
      <Section title="Maintenance"><MaintenanceCreate components={services} busy={busy} onSubmit={data => change('/admin/maintenance', 'POST', data, 'Maintenance scheduled.')} />{adminWindows.length === 0 && <p className="empty">No maintenance windows.</p>}{adminWindows.map(window => <MaintenanceEditor key={window.id} window={window} components={services} busy={busy} change={change} />)}</Section>
      {user?.role === 'admin' && <><Section title="HTTP checks"><CheckForm components={services} endpoints={endpoints} busy={busy} onSubmit={data => change('/admin/checks', 'POST', data, 'HTTP check added.')} />{checks.map(check => <CheckForm key={check.id} initial={check} components={services} endpoints={endpoints} busy={busy} onSubmit={data => change(`/admin/checks/${check.id}`, 'PATCH', data, 'HTTP check updated.')} />)}</Section><Section title="Team access">{users.map(member => <Card key={member.id}><div className="row"><span>{member.email}</span><label>Role <select value={member.role} disabled={busy} onChange={event => void change(`/admin/users/${member.id}`, 'PATCH', { role: event.target.value, version: member.version }, 'Role updated.')}><option value="viewer">Viewer</option><option value="operator">Operator</option><option value="admin">Admin</option></select></label></div></Card>)}</Section><Section title="Audit log">{audit.length === 0 ? <p className="empty">No activity yet.</p> : audit.map(event => <Card key={event.id}><div className="row"><span>{event.actorEmail} · {label(event.action)} {label(event.entityType)} #{event.entityId}</span><time>{when(event.createdAt)}</time></div></Card>)}</Section></>}
    </> : <>
      <div className="heading"><div><p className="eyebrow">Service overview</p><h1>Engineering status</h1><p>Current service health and planned work for the team.</p></div></div>
      <Section title="Services">{services.length === 0 ? <p className="empty">No services have been added.</p> : <div className="service-list">{services.map(component => <Card key={component.id}><div className="row"><strong>{component.name}</strong><div className="badges"><Badge value={component.status} />{component.underMaintenance && <Badge value="under_maintenance" />}</div></div>{component.lastCheckedAt && <p className="hint">Last checked {when(component.lastCheckedAt)}</p>}</Card>)}</div>}</Section>
      <Section title="Active incidents">{incidents.filter(incident => incident.status !== 'resolved').length === 0 ? <p className="empty">No active incidents.</p> : incidents.filter(incident => incident.status !== 'resolved').map(incident => <IncidentCard key={incident.id} incident={incident} components={services} />)}</Section>
      <Section title="Planned maintenance">{windows.filter(window => window.state === 'upcoming' || window.state === 'active').length === 0 ? <p className="empty">No planned maintenance.</p> : windows.filter(window => window.state === 'upcoming' || window.state === 'active').map(window => <MaintenanceCard key={window.id} window={window} components={services} />)}</Section>
      <Section title="Recent history">{incidents.filter(incident => incident.status === 'resolved').map(incident => <IncidentCard key={incident.id} incident={incident} components={services} />)}{windows.filter(window => window.state === 'past').map(window => <MaintenanceCard key={window.id} window={window} components={services} />)}{incidents.every(incident => incident.status !== 'resolved') && windows.every(window => window.state !== 'past') && <p className="empty">No recent events.</p>}</Section>
    </>}
  </main></>
}

type Change = (path: string, method: string, body: unknown, message: string) => Promise<boolean>
type Submit = (data: object) => Promise<boolean>

// Capture the version at the first edit. Background refreshes may update the
// displayed record but must neither erase a draft nor silently rebase it.
function useDraft<T extends object>(source: T, version: number) {
  const [draft, setDraft] = useState<{ value: T; version: number } | null>(null)
  function update(patch: Partial<T>) {
    setDraft(previous => ({ value: { ...(previous?.value ?? source), ...patch }, version: previous?.version ?? version }))
  }
  return {
    value: draft?.value ?? source,
    version: draft?.version ?? version,
    dirty: draft !== null,
    stale: draft !== null && draft.version !== version,
    update,
    discard: () => setDraft(null),
  }
}
function DraftConflict({ stale, dirty, busy, discard }: { stale: boolean; dirty: boolean; busy: boolean; discard: () => void }) {
  if (!dirty) return null
  return stale ? <div className="alert error" role="status">This item changed while you were editing. Your draft is preserved; copy it if needed before discarding it to use the latest version. <button type="button" disabled={busy} onClick={discard}>Discard draft and use latest</button></div> : <div className="hint">Unsaved changes. <button type="button" className="secondary" disabled={busy} onClick={discard}>Discard changes</button></div>
}
function ComponentForm({ busy, onSubmit }: { busy: boolean; onSubmit: Submit }) {
  const [name, setName] = useState('')
  return <Card><form className="inline-form" onSubmit={event => { event.preventDefault(); void onSubmit({ name, position: 0, manualStatus: 'operational' }).then(saved => { if (saved) setName('') }) }}><label>Service name<input required disabled={busy} value={name} onChange={event => setName(event.target.value)} placeholder="e.g. API" /></label><button disabled={busy}>Add service</button></form></Card>
}
function ComponentEditor({ component, busy, onSave }: { component: Component; busy: boolean; onSave: Submit }) {
  const draft = useDraft({ name: component.name, health: component.manualStatus, position: component.position }, component.version)
  const { name, health, position } = draft.value
  return <Card><DraftConflict stale={draft.stale} dirty={draft.dirty} busy={busy} discard={draft.discard} /><form className="inline-form" onSubmit={event => { event.preventDefault(); void onSave({ name, manualStatus: health, position, version: draft.version }).then(saved => { if (saved) draft.discard() }) }}><label>Name<input required disabled={busy} value={name} onChange={event => draft.update({ name: event.target.value })} /></label><label>Manual status<select disabled={busy} value={health} onChange={event => draft.update({ health: event.target.value as Health })}><option value="operational">Operational</option><option value="degraded">Degraded</option><option value="down">Down</option></select></label><label>Order<input type="number" disabled={busy} value={position} onChange={event => draft.update({ position: Number(event.target.value) })} /></label><button className="secondary" disabled={busy}>Save</button></form></Card>
}
function IncidentForm({ components, busy, onSubmit }: { components: Component[]; busy: boolean; onSubmit: Submit }) {
  const [title, setTitle] = useState(''); const [body, setBody] = useState(''); const [impact, setImpact] = useState('minor'); const [ids, setIds] = useState<string[]>([])
  return <details className="composer"><summary>New incident</summary><form onSubmit={event => { event.preventDefault(); void onSubmit({ title, body, impact, componentIds: ids }).then(saved => { if (saved) { setTitle(''); setBody(''); setImpact('minor'); setIds([]) } }) }}><label>Title<input required disabled={busy} value={title} onChange={event => setTitle(event.target.value)} /></label><label>Impact<select disabled={busy} value={impact} onChange={event => setImpact(event.target.value)}><option value="minor">Minor</option><option value="major">Major</option><option value="critical">Critical</option></select></label><label>Opening update<textarea required disabled={busy} value={body} onChange={event => setBody(event.target.value)} /></label><ComponentSelection disabled={busy} components={components} selected={ids} onChange={setIds} /><button disabled={busy}>Create draft</button></form></details>
}
function IncidentCard({ incident, components }: { incident: Incident; components: Component[] }) {
  return <Card><div className="row"><h3>{incident.title}</h3><div className="badges"><Badge value={incident.status} /><Badge value={incident.impact} />{incident.draft && <Badge value="draft" />}</div></div><p className="hint">{names(incident.componentIds ?? [], components)}</p>{(incident.updates ?? []).map(update => <div className="timeline" key={update.id}><div className="row"><strong>{label(update.status)}</strong><time>{when(update.postedAt)}</time></div><p>{update.body}</p></div>)}</Card>
}
function IncidentEditor({ incident, components, busy, change }: { incident: Incident; components: Component[]; busy: boolean; change: Change }) {
  const edit = useDraft({ title: incident.title, impact: incident.impact, opening: incident.updates?.[0]?.body ?? '', ids: incident.componentIds ?? [], wasDraft: incident.draft }, incident.version)
  const update = useDraft({ body: '', status: incident.status }, incident.version)
  const { title, impact, opening, ids, wasDraft } = edit.value
  return <><IncidentCard incident={incident} components={components} /><div className="actions"><details><summary>Edit incident</summary><DraftConflict stale={edit.stale} dirty={edit.dirty} busy={busy} discard={edit.discard} /><form onSubmit={event => { event.preventDefault(); void change(`/admin/incidents/${incident.id}`, 'PATCH', { title, impact, componentIds: ids, version: edit.version, ...(wasDraft ? { body: opening } : {}) }, 'Incident updated.').then(saved => { if (saved) edit.discard() }) }}><label>Title<input required disabled={busy} value={title} onChange={event => edit.update({ title: event.target.value })} /></label><label>Impact<select disabled={busy} value={impact} onChange={event => edit.update({ impact: event.target.value as Incident['impact'] })}><option value="minor">Minor</option><option value="major">Major</option><option value="critical">Critical</option></select></label>{(incident.draft || (edit.dirty && wasDraft)) && <label>Opening update<textarea required disabled={busy} value={opening} onChange={event => edit.update({ opening: event.target.value })} /></label>}<ComponentSelection disabled={busy} components={components} selected={ids} onChange={value => edit.update({ ids: value })} /><button disabled={busy}>Save incident</button></form></details>{incident.draft && <button disabled={busy || edit.dirty} onClick={() => void change(`/admin/incidents/${incident.id}/publish`, 'POST', { version: incident.version }, 'Incident published.')}>Publish</button>}{!incident.draft && <details><summary>Post update</summary><DraftConflict stale={update.stale} dirty={update.dirty} busy={busy} discard={update.discard} /><form onSubmit={event => { event.preventDefault(); void change(`/admin/incidents/${incident.id}/updates`, 'POST', { ...update.value, version: update.version }, 'Update posted.').then(saved => { if (saved) update.discard() }) }}><label>Update<textarea required disabled={busy} value={update.value.body} onChange={event => update.update({ body: event.target.value })} /></label><label>Status<select disabled={busy} value={update.value.status} onChange={event => update.update({ status: event.target.value as IncidentStatus })}><option value="investigating">Investigating</option><option value="identified">Identified</option><option value="monitoring">Monitoring</option><option value="resolved">Resolved</option></select></label><button disabled={busy}>Post update</button></form></details>}</div></>
}
type CheckValues = { componentId: string; endpointId: string; enabled: boolean; intervalMinutes: number; expectedStatus: number }
const emptyCheck: CheckValues = { componentId: '', endpointId: '', enabled: true, intervalMinutes: 1, expectedStatus: 200 }
function CheckForm({ initial, components, endpoints, busy, onSubmit }: { initial?: Check; components: Component[]; endpoints: Endpoint[]; busy: boolean; onSubmit: Submit }) {
  const source = initial ? { componentId: initial.componentId, endpointId: initial.endpointId, enabled: Boolean(initial.enabled), intervalMinutes: initial.intervalMinutes, expectedStatus: initial.expectedStatus } : emptyCheck
  const draft = useDraft<CheckValues>(source, initial?.version ?? 0)
  const { componentId, endpointId, enabled, intervalMinutes, expectedStatus } = draft.value
  return <Card><DraftConflict stale={draft.stale} dirty={draft.dirty} busy={busy} discard={draft.discard} /><form onSubmit={event => { event.preventDefault(); void onSubmit({ componentId, endpointId, enabled, intervalMinutes, expectedStatus, ...(initial ? { version: draft.version } : {}) }).then(saved => { if (saved) draft.discard() }) }}><h3>{initial ? 'Edit check' : 'Add HTTP check'}</h3>{endpoints.length === 0 && <p className="hint">No approved endpoints are configured.</p>}<div className="date-row"><label>Service<select required disabled={busy} value={componentId} onChange={event => draft.update({ componentId: event.target.value })}><option value="">Select service</option>{components.map(component => <option key={component.id} value={component.id}>{component.name}</option>)}</select></label><label>Approved endpoint<select required disabled={busy} value={endpointId} onChange={event => draft.update({ endpointId: event.target.value })}><option value="">Select endpoint</option>{endpoints.map(endpoint => <option key={endpoint.id} value={endpoint.id}>{endpoint.name}</option>)}</select></label></div><div className="date-row"><label>Interval<select disabled={busy} value={intervalMinutes} onChange={event => draft.update({ intervalMinutes: Number(event.target.value) })}><option value={1}>1 minute</option><option value={5}>5 minutes</option></select></label><label>Expected HTTP status<input required disabled={busy} type="number" min="100" max="599" value={expectedStatus} onChange={event => draft.update({ expectedStatus: Number(event.target.value) })} /></label></div><label className="check-option"><input type="checkbox" disabled={busy} checked={enabled} onChange={event => draft.update({ enabled: event.target.checked })} /> Enabled</label><button disabled={busy || endpoints.length === 0}>{initial ? 'Save check' : 'Add check'}</button></form></Card>
}
function MaintenanceCard({ window, components }: { window: Maintenance; components: Component[] }) {
  return <Card><div className="row"><h3>{window.name}</h3><Badge value={window.state} /></div>{window.description && <p>{window.description}</p>}<p className="hint">{when(window.startsAt)} – {when(window.endsAt)} · {names(window.componentIds ?? [], components)}</p></Card>
}
type MaintenanceValues = { name: string; description: string; start: string; end: string; ids: string[] }
const emptyMaintenance: MaintenanceValues = { name: '', description: '', start: '', end: '', ids: [] }
function MaintenanceFields({ components, busy, values, update, submit, editing }: { components: Component[]; busy: boolean; values: MaintenanceValues; update: (patch: Partial<MaintenanceValues>) => void; submit: () => void; editing: boolean }) {
  const { name, description, start, end, ids } = values
  function handleSubmit(event: FormEvent) { event.preventDefault(); submit() }
  return <form onSubmit={handleSubmit}><label>Title<input required disabled={busy} value={name} onChange={event => update({ name: event.target.value })} /></label><label>Description<textarea disabled={busy} value={description} onChange={event => update({ description: event.target.value })} /></label><div className="date-row"><label>Starts<input required disabled={busy} type="datetime-local" value={start} onChange={event => update({ start: event.target.value })} /></label><label>Ends<input required disabled={busy} type="datetime-local" value={end} onChange={event => update({ end: event.target.value })} /></label></div><ComponentSelection disabled={busy} components={components} selected={ids} onChange={value => update({ ids: value })} /><button disabled={busy}>{editing ? 'Save changes' : 'Schedule maintenance'}</button></form>
}
function maintenanceBody(value: MaintenanceValues) {
  return { name: value.name, description: value.description, startsAt: new Date(value.start).getTime(), endsAt: new Date(value.end).getTime(), componentIds: value.ids }
}
function MaintenanceCreate({ components, busy, onSubmit }: { components: Component[]; busy: boolean; onSubmit: Submit }) {
  const [values, setValues] = useState(emptyMaintenance)
  return <MaintenanceFields components={components} busy={busy} values={values} update={patch => setValues(previous => ({ ...previous, ...patch }))} submit={() => void onSubmit(maintenanceBody(values)).then(saved => { if (saved) setValues(emptyMaintenance) })} editing={false} />
}
function MaintenanceEditor({ window, components, busy, change }: { window: Maintenance; components: Component[]; busy: boolean; change: Change }) {
  const draft = useDraft<MaintenanceValues>({ name: window.name, description: window.description ?? '', start: localDate(window.startsAt), end: localDate(window.endsAt), ids: window.componentIds ?? [] }, window.version)
  const editable = window.state !== 'past' && window.state !== 'cancelled'
  return <><MaintenanceCard window={window} components={components} /><DraftConflict stale={draft.stale} dirty={draft.dirty} busy={busy} discard={draft.discard} /><div className="actions">{(editable || draft.dirty) && <details><summary>Edit maintenance</summary><MaintenanceFields components={components} busy={busy || !editable} values={draft.value} update={draft.update} submit={() => void change(`/admin/maintenance/${window.id}`, 'PATCH', { ...maintenanceBody(draft.value), version: draft.version }, 'Maintenance updated.').then(saved => { if (saved) draft.discard() })} editing /></details>}{window.state === 'upcoming' && <button className="secondary" disabled={busy || draft.dirty} onClick={() => void change(`/admin/maintenance/${window.id}/cancel`, 'POST', { version: window.version }, 'Maintenance cancelled.')}>Cancel window</button>}{window.state === 'active' && <button className="secondary" disabled={busy || draft.dirty} onClick={() => void change(`/admin/maintenance/${window.id}/end`, 'POST', { version: window.version }, 'Maintenance ended.')}>End early</button>}</div></>
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
