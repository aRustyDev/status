// Adapts the upstream Actions page and Vault picker to the supported Workers webhook provider.
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, Modal, ModalFooter } from '@better-forge/ui'
import { api } from '../api/client'
import { useCapabilities } from '../capabilities'
import { deliveryHistoryUrl } from '../deliveryHistoryUrl'

type Action = { id:string; name:string; endpointId:string; triggerStatus:string; vaultId:number; secretId:number; enabled:number; version:number; checkIds:string[] }
type Choice = {id:string;name:string}
type Check = Choice & {componentId:string;configVersion:number}
type CheckSnapshot = Pick<Check,'id'|'componentId'|'configVersion'>
type Vault = {id:number;name:string}
type Secret = {id:number;name:string;type:string}
type Delivery = {actionId:string;checkId:string;status:string;state:string;updatedAt:number}

export default function CloudflareActions() {
  const capabilities = useCapabilities()
  const qc=useQueryClient(), [editing,setEditing]=useState<Action|'new'|null>(null), [removing,setRemoving]=useState<Action|null>(null)
  const [busy,setBusy]=useState(false), [message,setMessage]=useState('')
  const actions=useQuery<Action[]>({queryKey:['worker-actions'],queryFn:()=>api.get('/admin/actions')})
  const deliveries=useQuery<Delivery[]>({queryKey:['worker-action-runs'],queryFn:()=>api.get('/admin/actions/runs')})
  async function remove() {
    if (!removing) return
    setMessage(''); setBusy(true)
    try { await api.delete(`/admin/actions/${removing.id}`,{version:removing.version}); setRemoving(null); await qc.invalidateQueries({queryKey:['worker-actions']}) }
    catch { setMessage('Could not delete action. Reload and try again.') }
    finally { setBusy(false) }
  }
  return <div className="p-4 md:p-6 space-y-5">
    <div className="flex flex-wrap justify-between gap-3"><div><h1 className="font-headline font-bold text-xl">Actions</h1><p className="text-sm">Run approved HTTP actions when selected monitors change status.</p></div><div className="flex gap-2">{capabilities.supportedRoutes.includes('/admin/delivery-history') && <a href={deliveryHistoryUrl('actions')} className="btn btn-secondary">Run history</a>}<button className="btn btn-primary" onClick={()=>setEditing('new')}>Add Action</button></div></div>
    <p className="text-sm">Action names are visible metadata. Actions use a Vault Secure Value as a Bearer token. Other action providers, templates and manual test runs are unavailable. Actions can change external systems; each event is attempted at most once.</p>
    {message && <p role="status">{message}</p>}
    {actions.isLoading && <p>Loading actions…</p>}{actions.isError && <p role="alert">Could not load actions. <button onClick={()=>void actions.refetch()}>Retry</button></p>}
    {actions.data?.length===0 && <p>No actions yet.</p>}
    <div className="space-y-2">{actions.data?.map(action=><div key={action.id} className="p-4 rounded-xl flex flex-wrap items-center gap-3" style={{background:'var(--m3-surface-container)',border:'1px solid var(--m3-outline-variant)'}}>
      <div className="flex-1"><p className="font-semibold">{action.name}</p><p className="text-xs">HTTP POST · {action.enabled?'Enabled':'Disabled'} · {action.checkIds.length} monitor(s)</p></div>
      <button className="btn btn-secondary btn-sm" onClick={()=>setEditing(action)}>Edit</button><button className="btn-icon" aria-label={`Delete action ${action.name}`} onClick={()=>{setMessage('');setRemoving(action)}}>×</button>
    </div>)}</div>
    <section><h2 className="font-headline font-bold">Recent action runs</h2><p className="text-sm">Initial monitor results do not run actions. Unavailable credentials or destinations fail closed. An uncertain result may mean the external system acted; inspect it before taking further action.</p>
      {deliveries.isError && <p role="alert">Could not load delivery status.</p>}
      {deliveries.data?.length===0 && <p>No action runs yet.</p>}
      {deliveries.data?.map((delivery,index)=><p key={`${delivery.actionId}-${delivery.checkId}-${delivery.updatedAt}-${index}`} className="text-sm">{actions.data?.find(c=>c.id===delivery.actionId)?.name ?? 'Action'}: {delivery.status}, {delivery.state}</p>)}
    </section>
    {editing && <ActionForm action={editing==='new'?null:editing} onClose={()=>setEditing(null)} onSaved={async()=>{setEditing(null);await qc.invalidateQueries({queryKey:['worker-actions']})}} />}
    {removing && <Modal icon="delete" title="Delete action" onClose={()=>{if(!busy)setRemoving(null)}}><div className="p-6"><p>Delete {removing.name}? Its pending runs and history will also be removed.</p>{message && <p role="alert">{message}</p>}</div><ModalFooter><button className="btn btn-secondary" disabled={busy} onClick={()=>setRemoving(null)}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={()=>void remove()}>Delete</button></ModalFooter></Modal>}
  </div>
}

function ActionForm({action,onClose,onSaved}:{action:Action|null;onClose:()=>void;onSaved:()=>Promise<void>}) {
  const [name,setName]=useState(action?.name??''), [endpointId,setEndpointId]=useState(action?.endpointId??''), [vaultId,setVaultId]=useState(action?.vaultId??0), [secretId,setSecretId]=useState(action?.secretId??0)
  const [triggerStatus,setTriggerStatus]=useState(action?.triggerStatus??'down')
  const [enabled,setEnabled]=useState(action?.enabled!==0), [checkIds,setCheckIds]=useState<string[]>(action?.checkIds??[]), [busy,setBusy]=useState(false), [error,setError]=useState('')
  const [checkSnapshots,setCheckSnapshots]=useState<CheckSnapshot[]>([]), initialChecksLoaded=useRef(false)
  const destinations=useQuery<Choice[]>({queryKey:['worker-action-destinations'],queryFn:()=>api.get('/admin/actions/destinations')})
  const checks=useQuery<Check[]>({queryKey:['worker-action-checks'],queryFn:()=>api.get('/admin/actions/checks'),refetchOnMount:'always'})
  const vaults=useQuery<Vault[]>({queryKey:['vaults'],queryFn:()=>api.get('/admin/vaults')})
  const secrets=useQuery<Secret[]>({queryKey:['vault-secrets',vaultId],queryFn:()=>api.get(`/admin/vaults/${vaultId}/secrets`),enabled:vaultId>0})
  useEffect(()=>{
    if (!checks.isFetchedAfterMount || !checks.data || initialChecksLoaded.current) return
    initialChecksLoaded.current=true
    setCheckSnapshots(checks.data.filter(check=>checkIds.includes(check.id)).map(({id,componentId,configVersion})=>({id,componentId,configVersion})))
  },[checks.isFetchedAfterMount,checks.data,checkIds])
  const missingCheckSnapshots=checkIds.filter(id=>!checkSnapshots.some(snapshot=>snapshot.id===id) || !checks.data?.some(check=>check.id===id))
  async function submit(event:FormEvent) {
    event.preventDefault(); setError(''); setBusy(true)
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
  return <Modal icon="actions" title={action?'Edit action':'Add Action'} onClose={onClose}><form onSubmit={event=>void submit(event)}><div className="p-6 space-y-3">
    <label className="block">Action name<input className="input-sig w-full" value={name} maxLength={100} required onChange={event=>setName(event.target.value)} /></label>
    <label className="block">Approved action destination<select className="input-sig w-full" required value={endpointId} onChange={event=>setEndpointId(event.target.value)}><option value="">— select destination —</option>{destinations.data?.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <p className="text-sm">Destinations are configured by the deployment administrator. Only HTTPS endpoints are supported. The Vault token must be at most 4096 characters and use only letters, digits, hyphen, dot, underscore, tilde, plus, slash, and optional trailing equals signs.</p>
    <label className="block">Vault<select className="input-sig w-full" required value={vaultId||''} onChange={event=>{setVaultId(Number(event.target.value));setSecretId(0)}}><option value="">— select vault —</option>{vaults.data?.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
    <label className="block">Secure Value secret<select className="input-sig w-full" required disabled={!vaultId} value={secretId||''} onChange={event=>setSecretId(Number(event.target.value))}><option value="">— select secret —</option>{secrets.data?.filter(s=>s.type==='value').map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
    <p className="text-sm">Monitor-specific action settings override this trigger. Existing degraded triggers can remain active until the action is unlinked from that monitor.</p>
    <label className="block">Trigger on<select className="input-sig w-full" value={triggerStatus} onChange={event=>setTriggerStatus(event.target.value)}><option value="down">Down</option><option value="degraded">Degraded</option><option value="up">Up</option><option value="all">Any status change</option></select></label>
    <label className="flex gap-2"><input type="checkbox" checked={enabled} onChange={event=>setEnabled(event.target.checked)} />Enabled</label>
    <fieldset><legend>Monitors</legend><p className="text-sm">Select local monitors with checks. Gatus-managed monitors remain read-only.</p>{!checks.isFetchedAfterMount && <p role="status">Loading monitors…</p>}{checks.isFetchedAfterMount && !checks.isError && checks.data?.map(check=><label className="flex gap-2" key={check.id}><input type="checkbox" checked={checkIds.includes(check.id)} onChange={event=>{const selected=event.target.checked;setCheckIds(current=>selected?[...current,check.id]:current.filter(id=>id!==check.id));setCheckSnapshots(current=>selected?[...current,{id:check.id,componentId:check.componentId,configVersion:check.configVersion}]:current.filter(item=>item.id!==check.id))}} />{check.name}</label>)}
      {checkIds.filter(id=>checks.isFetchedAfterMount && !checks.isError && !checks.data?.some(check=>check.id===id)).map(id=><p key={id} role="alert">A selected monitor is unavailable. <button type="button" className="underline" onClick={()=>{setCheckIds(current=>current.filter(value=>value!==id));setCheckSnapshots(current=>current.filter(snapshot=>snapshot.id!==id))}}>Remove unavailable monitor</button></p>)}
    </fieldset>
    {(destinations.isError||checks.isError||vaults.isError||secrets.isError) && <p role="alert">Could not load action choices. Close and try again.</p>}{error && <p role="alert">{error}</p>}
  </div><ModalFooter><button className="btn btn-secondary" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy||!checks.isFetchedAfterMount||checks.isError||missingCheckSnapshots.length>0||!endpointId||!vaultId||!secretId}>{action?'Save Action':'Create Action'}</button></ModalFooter></form></Modal>
}
