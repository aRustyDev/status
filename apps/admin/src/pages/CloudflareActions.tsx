// Adapts the upstream Actions page and Vault picker to the supported Workers webhook provider.
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, ApiError, ConfirmModal, DataTable, DataTh, EmptyTableRow, ErrorState, LoadingState, ModalFooter, ModalHeader, ModalShell, PageContainer, PageHeader, Switch, useTableSort } from '@better-forge/ui'
import { Link } from 'react-router-dom'
import { deliveryHistoryUrl } from '../deliveryHistoryUrl'
import { api } from '../api/client'
import { useCapabilities } from '../capabilities'

type Action = { id:string; name:string; endpointId:string; triggerStatus:string; vaultId:number; secretId:number; enabled:number; version:number; checkIds:string[] }
type Choice = {id:string;name:string}
type Check = Choice & {componentId:string;configVersion:number}
type CheckSnapshot = Pick<Check,'id'|'componentId'|'configVersion'>
type Vault = {id:number;name:string}
type Secret = {id:number;name:string;type:string}
type Delivery = {actionId:string;checkId:string;status:string;state:string;updatedAt:number}

export default function CloudflareActions({readOnly=false,previewWriter=false}: {readOnly?:boolean;previewWriter?:boolean}) {
  const capabilities = useCapabilities()
  const qc=useQueryClient(), [editing,setEditing]=useState<Action|'new'|null>(null), [removing,setRemoving]=useState<Action|null>(null)
  const [busy,setBusy]=useState(false), [message,setMessage]=useState('')
  const actions=useQuery<Action[]>({queryKey:['worker-actions'],queryFn:()=>api.get('/admin/actions')})
  const deliveries=useQuery<Delivery[]>({queryKey:['worker-action-runs'],queryFn:()=>api.get('/admin/actions/runs')})
  const destinations = useQuery<Choice[]>({ queryKey: ['worker-action-destinations'], queryFn: () => api.get('/admin/actions/destinations') })
  const { rows, sort } = useTableSort(actions.data ?? [], {
    name: action => action.name,
    destination: action => destinations.data?.find(item => item.id === action.endpointId)?.name ?? action.endpointId,
    status: action => action.enabled,
  })
  async function remove() {
    if (!removing) return
    setMessage(''); setBusy(true)
    try { await api.delete(`/admin/actions/${removing.id}`,{version:removing.version}); setRemoving(null); await qc.invalidateQueries({queryKey:['worker-actions']}) }
    catch { setMessage('Could not delete action. Reload and try again.') }
    finally { setBusy(false) }
  }
  return <PageContainer>
    <PageHeader title="Actions" subtitle="HTTP requests sent when a monitor changes status" actions={<>
      {capabilities.supportedRoutes.includes('/admin/delivery-history') && <Link to={deliveryHistoryUrl('actions')} className="btn btn-secondary"><span className="material-symbols-outlined" aria-hidden="true">history</span> Run history</Link>}
      <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}><span className="material-symbols-outlined" aria-hidden="true">add</span> Add Action</button>
    </>} />
    {destinations.data?.some(destination => destination.id === 'issue14-isolated-sink')
      ? <Alert tone="warning">{readOnly ? 'Read-only isolated preview for editor testing. Saving and Action execution are disabled. Use only synthetic Vault values; do not enter real secrets.' : 'Isolated preview for editor testing only. Actions do not execute here. Use only synthetic Vault values; do not enter real secrets.'}</Alert>
      : <Alert tone="info">Actions send approved HTTPS requests using Vault credentials. Link actions to monitors and configure delays and cooldowns in the monitor editor. Each event is attempted at most once.</Alert>}
    {message && !removing && <p role="alert">{message}</p>}
    {actions.isLoading ? <LoadingState label="Loading actions…" /> : actions.isError ? <ErrorState message="Could not load actions." onRetry={() => void actions.refetch()} /> :
      <div className="rounded-2xl overflow-x-auto" style={{background:'var(--m3-surface-container-low)',border:'1px solid var(--m3-outline-variant)'}}>
        {destinations.isError && <p role="alert">Could not load destination names. <button type="button" onClick={() => void destinations.refetch()}>Retry</button></p>}
        <DataTable sort={sort} className="w-full min-w-[640px] text-sm">
          <thead><tr style={{borderBottom:'1px solid var(--m3-outline-variant)'}}>
            <DataTh sortKey="name" className="px-4 py-3 text-left">Name</DataTh>
            <DataTh sortKey="destination" className="px-4 py-3 text-left">Destination</DataTh>
            <DataTh className="px-4 py-3 text-left">Monitors with checks</DataTh>
            <DataTh sortKey="status" className="px-4 py-3 text-left">Status</DataTh>
            <DataTh className="px-4 py-3 text-right"><span className="sr-only">Actions</span></DataTh>
          </tr></thead>
          <tbody>
            {rows.length === 0 && <EmptyTableRow colSpan={5} icon="bolt" title="No actions yet" description="Add an action to send an HTTP request when a monitor changes status." />}
            {rows.map(action => <tr key={action.id} style={{borderTop:'1px solid var(--m3-outline-variant)'}}>
              <td className="px-4 py-3 font-medium">{action.name}</td>
              <td className="px-4 py-3">HTTP POST · {destinations.data?.find(item => item.id === action.endpointId)?.name ?? action.endpointId}</td>
              <td className="px-4 py-3">{action.checkIds.length}</td>
              <td className="px-4 py-3">{action.enabled ? 'Enabled' : 'Disabled'}</td>
              <td className="px-4 py-3 text-right"><div className="flex justify-end gap-2">
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(action)}>Edit</button>
                <button type="button" className="btn-icon" disabled={readOnly} aria-label={`Delete action ${action.name}`} onClick={() => { setMessage(''); setRemoving(action) }}>×</button>
              </div></td>
            </tr>)}
          </tbody>
        </DataTable>
      </div>}
    <section><h2 className="font-headline font-bold">Recent action runs</h2><p className="text-sm">Initial monitor results do not run actions. Unavailable credentials or destinations fail closed. An uncertain result may mean the external system acted; inspect it before taking further action.</p>
      {deliveries.isError && <p role="alert">Could not load delivery status.</p>}
      {deliveries.data?.length===0 && <p>No action runs yet.</p>}
      {deliveries.data?.map((delivery,index)=><p key={`${delivery.actionId}-${delivery.checkId}-${delivery.updatedAt}-${index}`} className="text-sm">{actions.data?.find(c=>c.id===delivery.actionId)?.name ?? 'Action'}: {delivery.status}, {delivery.state}</p>)}
    </section>
    {editing && <ActionForm readOnly={readOnly} previewWriter={previewWriter} action={editing==='new'?null:editing} onClose={()=>setEditing(null)} onSaved={async()=>{setEditing(null);await qc.invalidateQueries({queryKey:['worker-actions']})}} />}
    {removing && <ConfirmModal title="Delete action" message={`Delete "${removing.name}"? Its pending runs and history will also be removed.${message ? ` ${message}` : ''}`} confirmLabel="Delete" pending={busy} pendingLabel="Deleting…" onConfirm={() => void remove()} onCancel={() => { if (!busy) setRemoving(null) }} />}
  </PageContainer>
}

function ActionForm({action,onClose,onSaved,readOnly,previewWriter}:{action:Action|null;onClose:()=>void;onSaved:()=>Promise<void>;readOnly:boolean;previewWriter:boolean}) {
  const titleId = useId()
  const [name,setName]=useState(action?.name??''), [endpointId,setEndpointId]=useState(action?.endpointId??''), [vaultId,setVaultId]=useState(action?.vaultId??0), [secretId,setSecretId]=useState(action?.secretId??0)
  const [triggerStatus,setTriggerStatus]=useState(action?.triggerStatus??'down')
  const [enabled,setEnabled]=useState(action?.enabled!==0), [checkIds,setCheckIds]=useState<string[]>(action?.checkIds??[]), [busy,setBusy]=useState(false), [error,setError]=useState('')
  const [checkSnapshots,setCheckSnapshots]=useState<CheckSnapshot[]>([]), initialChecksLoaded=useRef(false)
  const destinations=useQuery<Choice[]>({queryKey:['worker-action-destinations'],queryFn:()=>api.get('/admin/actions/destinations')})
  const checks=useQuery<Check[]>({queryKey:['worker-action-checks'],queryFn:()=>api.get('/admin/actions/checks'),refetchOnMount:'always'})
  const vaults=useQuery<Vault[]>({queryKey:['vaults'],queryFn:()=>api.get('/admin/vaults')})
  const secrets=useQuery<Secret[]>({queryKey:['vault-secrets',vaultId],queryFn:()=>api.get(`/admin/vaults/${vaultId}/secrets`),enabled:vaultId>0})
  const fixtureDefaultsSet=useRef({destination:false,vault:false,secret:false})
  useEffect(()=>{
    if (!previewWriter || action) return
    if (!fixtureDefaultsSet.current.destination && destinations.data?.length===1 && destinations.data[0]?.id==='issue14-isolated-sink') { fixtureDefaultsSet.current.destination=true; setEndpointId('issue14-isolated-sink') }
    if (!fixtureDefaultsSet.current.vault && vaults.data?.length===1 && vaults.data[0]?.id===238010605399733) { fixtureDefaultsSet.current.vault=true; setVaultId(238010605399733) }
    if (!fixtureDefaultsSet.current.secret && vaultId===238010605399733 && secrets.data?.length===1 && secrets.data[0]?.id===218386432287168 && secrets.data[0]?.type==='value') { fixtureDefaultsSet.current.secret=true; setSecretId(218386432287168) }
  },[previewWriter,action,destinations.data,vaults.data,vaultId,secrets.data])
  useEffect(()=>{
    if (!checks.isFetchedAfterMount || !checks.data || initialChecksLoaded.current) return
    initialChecksLoaded.current=true
    setCheckSnapshots(checks.data.filter(check=>checkIds.includes(check.id)).map(({id,componentId,configVersion})=>({id,componentId,configVersion})))
  },[checks.isFetchedAfterMount,checks.data,checkIds])
  const missingCheckSnapshots=checkIds.filter(id=>!checkSnapshots.some(snapshot=>snapshot.id===id) || !checks.data?.some(check=>check.id===id))
  async function submit(event:FormEvent) {
    event.preventDefault(); if (busy) return; setError(''); setBusy(true)
    try {
      if (!checks.isFetchedAfterMount || checks.isError || missingCheckSnapshots.length) throw new Error('Selected monitors are unavailable')
      const payload={name,endpointId,vaultId,secretId,enabled,checkIds,checkSnapshots,triggerStatus,...(action?{version:action.version}:{})}
      if (action) await api.patch(`/admin/actions/${action.id}`,payload)
      else await api.post('/admin/actions',payload)
      await onSaved()
    } catch (error) {
      setError(error instanceof ApiError && error.status===409 && error.message==='Monitor choices are out of date. Refresh the page and try again.'
        ? 'Monitor choices are out of date. Refresh the page and try again.'
        : 'Could not save action. Check your selections and reload if it was changed.')
    }
    finally { setBusy(false) }
  }
  return <ModalShell align="top" onClose={busy ? undefined : onClose} labelledBy={titleId}><div className="rounded-2xl my-8 w-full max-w-xl" style={{background:'var(--m3-surface)'}}><ModalHeader icon="bolt" titleId={titleId} title={action?'Edit Action':'New Action'} onClose={() => { if (!busy) onClose() }} /><form onSubmit={event=>void submit(event)}><fieldset disabled={busy}><div className="p-6 space-y-3">
    <label className="block">Action name<input className="input-sig w-full" value={name} maxLength={100} required onChange={event=>setName(event.target.value)} /></label>
    <label className="block">Approved action destination<select className="input-sig w-full" required value={endpointId} onChange={event=>setEndpointId(event.target.value)}><option value="">— select destination —</option>{destinations.data?.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <p className="text-sm">Destinations are configured by the deployment administrator. Only HTTPS endpoints are supported. The Vault token must be at most 4096 characters and use only letters, digits, hyphen, dot, underscore, tilde, plus, slash, and optional trailing equals signs.</p>
    <label className="block">Vault<select className="input-sig w-full" required value={vaultId||''} onChange={event=>{setVaultId(Number(event.target.value));setSecretId(0)}}><option value="">— select vault —</option>{vaults.data?.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
    <label className="block">Secure Value secret<select className="input-sig w-full" required disabled={!vaultId} value={secretId||''} onChange={event=>setSecretId(Number(event.target.value))}><option value="">— select secret —</option>{secrets.data?.filter(s=>s.type==='value').map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
    <p className="text-sm">Monitor-specific action settings override this trigger. Existing degraded triggers can remain active until the action is unlinked from that monitor.</p>
    <label className="block">Trigger on<select className="input-sig w-full" value={triggerStatus} onChange={event=>setTriggerStatus(event.target.value)}><option value="down">Down</option><option value="degraded">Degraded</option><option value="up">Up</option><option value="all">Any status change</option></select></label>
    <Switch label="Enabled" checked={enabled} onChange={setEnabled} />
    <fieldset><legend>Monitors</legend><p className="text-sm">Select local monitors with checks. Gatus-managed monitors remain read-only.</p>{!checks.isFetchedAfterMount && <p role="status">Loading monitors…</p>}{checks.isFetchedAfterMount && !checks.isError && checks.data?.map(check=><label className="flex gap-2" key={check.id}><input type="checkbox" checked={checkIds.includes(check.id)} onChange={event=>{const selected=event.target.checked;setCheckIds(current=>selected?[...current,check.id]:current.filter(id=>id!==check.id));setCheckSnapshots(current=>selected?[...current,{id:check.id,componentId:check.componentId,configVersion:check.configVersion}]:current.filter(item=>item.id!==check.id))}} />{check.name}</label>)}
      {checkIds.filter(id=>checks.isFetchedAfterMount && !checks.isError && !checks.data?.some(check=>check.id===id)).map(id=><p key={id} role="alert">A selected monitor is unavailable. <button type="button" className="underline" onClick={()=>{setCheckIds(current=>current.filter(value=>value!==id));setCheckSnapshots(current=>current.filter(snapshot=>snapshot.id!==id))}}>Remove unavailable monitor</button></p>)}
    </fieldset>
    {(destinations.isError||checks.isError||vaults.isError||secrets.isError) && <p role="alert">Could not load action choices. Close and try again.</p>}{error && <p role="alert">{error}</p>}
  </div></fieldset><ModalFooter><button className="btn btn-secondary" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={readOnly||busy||!checks.isFetchedAfterMount||checks.isError||missingCheckSnapshots.length>0||destinations.isLoading||destinations.isError||vaults.isLoading||vaults.isError||secrets.isLoading||secrets.isError||!endpointId||!vaultId||!secretId}>{action?'Save Action':'Create Action'}</button></ModalFooter></form></div></ModalShell>
}
