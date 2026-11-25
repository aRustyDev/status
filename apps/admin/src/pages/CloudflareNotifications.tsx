// Adapts the upstream Notifications page and Vault picker to the supported Workers webhook provider.
import { useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Modal, ModalFooter } from '@better-forge/ui'
import { api } from '../api/client'

type Channel = { id:string; name:string; endpointId:string; vaultId:number; secretId:number; enabled:number; version:number; checkIds:string[] }
type Choice = {id:string;name:string}
type Vault = {id:number;name:string}
type Secret = {id:number;name:string;type:string}
type Delivery = {channelId:string;checkId:string;status:string;state:string;attempts:number;errorCode:string|null;updatedAt:number}

export default function CloudflareNotifications() {
  const qc=useQueryClient(), [editing,setEditing]=useState<Channel|'new'|null>(null), [removing,setRemoving]=useState<Channel|null>(null)
  const [busy,setBusy]=useState(false), [message,setMessage]=useState('')
  const channels=useQuery<Channel[]>({queryKey:['worker-channels'],queryFn:()=>api.get('/admin/notifications/channels')})
  const deliveries=useQuery<Delivery[]>({queryKey:['worker-channel-deliveries'],queryFn:()=>api.get('/admin/notifications/deliveries')})
  async function test(channel:Channel) {
    setMessage(''); setBusy(true)
    try { await api.post(`/admin/notifications/channels/${channel.id}/test`,{version:channel.version}); setMessage('Test sent successfully.') }
    catch { setMessage('Test failed. Check the destination and Vault secret, then try again.') }
    finally { setBusy(false) }
  }
  async function remove() {
    if (!removing) return
    setMessage(''); setBusy(true)
    try { await api.delete(`/admin/notifications/channels/${removing.id}`,{version:removing.version}); setRemoving(null); await qc.invalidateQueries({queryKey:['worker-channels']}) }
    catch { setMessage('Could not delete channel. Reload and try again.') }
    finally { setBusy(false) }
  }
  return <div className="p-4 md:p-6 space-y-5">
    <div className="flex flex-wrap justify-between gap-3"><div><h1 className="font-headline font-bold text-xl">Notifications</h1><p className="text-sm">Send monitor status changes to approved webhook destinations.</p></div><button className="btn btn-primary" onClick={()=>setEditing('new')}>Add Channel</button></div>
    <p className="text-sm">Channel names are visible metadata. Webhook channels use a Vault Secure Value as a Bearer token. Other channel providers and alert policies are unavailable. Delivery retries may produce duplicates.</p>
    {message && <p role="status">{message}</p>}
    {channels.isLoading && <p>Loading channels…</p>}{channels.isError && <p role="alert">Could not load channels. <button onClick={()=>void channels.refetch()}>Retry</button></p>}
    {channels.data?.length===0 && <p>No channels yet.</p>}
    <div className="space-y-2">{channels.data?.map(channel=><div key={channel.id} className="p-4 rounded-xl flex flex-wrap items-center gap-3" style={{background:'var(--m3-surface-container)',border:'1px solid var(--m3-outline-variant)'}}>
      <div className="flex-1"><p className="font-semibold">{channel.name}</p><p className="text-xs">Webhook · {channel.enabled?'Enabled':'Disabled'} · {channel.checkIds.length} monitor(s)</p></div>
      <button className="btn btn-secondary btn-sm" disabled={busy} onClick={()=>void test(channel)}>Send test</button><button className="btn btn-secondary btn-sm" onClick={()=>setEditing(channel)}>Edit</button><button className="btn-icon" aria-label={`Delete channel ${channel.name}`} onClick={()=>{setMessage('');setRemoving(channel)}}>×</button>
    </div>)}</div>
    <section><h2 className="font-headline font-bold">Recent delivery attempts</h2><p className="text-sm">An unavailable credential or destination fails closed; check Vault and deployment settings. Initial monitor results do not send an alert.</p>
      {deliveries.isError && <p role="alert">Could not load delivery status.</p>}
      {deliveries.data?.length===0 && <p>No deliveries yet.</p>}
      {deliveries.data?.map((delivery,index)=><p key={`${delivery.channelId}-${delivery.checkId}-${delivery.updatedAt}-${index}`} className="text-sm">{channels.data?.find(c=>c.id===delivery.channelId)?.name ?? 'Channel'}: {delivery.status}, {delivery.state}{delivery.errorCode ? ` (${delivery.errorCode})` : ''} · attempts {delivery.attempts}</p>)}
    </section>
    {editing && <ChannelForm channel={editing==='new'?null:editing} onClose={()=>setEditing(null)} onSaved={async()=>{setEditing(null);await qc.invalidateQueries({queryKey:['worker-channels']})}} />}
    {removing && <Modal icon="delete" title="Delete channel" onClose={()=>{if(!busy)setRemoving(null)}}><div className="p-6"><p>Delete {removing.name}? Its pending delivery records will also be removed.</p>{message && <p role="alert">{message}</p>}</div><ModalFooter><button className="btn btn-secondary" disabled={busy} onClick={()=>setRemoving(null)}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={()=>void remove()}>Delete</button></ModalFooter></Modal>}
  </div>
}

function ChannelForm({channel,onClose,onSaved}:{channel:Channel|null;onClose:()=>void;onSaved:()=>Promise<void>}) {
  const [name,setName]=useState(channel?.name??''), [endpointId,setEndpointId]=useState(channel?.endpointId??''), [vaultId,setVaultId]=useState(channel?.vaultId??0), [secretId,setSecretId]=useState(channel?.secretId??0)
  const [enabled,setEnabled]=useState(channel?.enabled!==0), [checkIds,setCheckIds]=useState<string[]>(channel?.checkIds??[]), [busy,setBusy]=useState(false), [error,setError]=useState('')
  const destinations=useQuery<Choice[]>({queryKey:['worker-channel-destinations'],queryFn:()=>api.get('/admin/notifications/destinations')})
  const checks=useQuery<Choice[]>({queryKey:['worker-channel-checks'],queryFn:()=>api.get('/admin/notifications/checks')})
  const vaults=useQuery<Vault[]>({queryKey:['vaults'],queryFn:()=>api.get('/admin/vaults')})
  const secrets=useQuery<Secret[]>({queryKey:['vault-secrets',vaultId],queryFn:()=>api.get(`/admin/vaults/${vaultId}/secrets`),enabled:vaultId>0})
  async function submit(event:FormEvent) {
    event.preventDefault(); setError(''); setBusy(true)
    try {
      const payload={name,endpointId,vaultId,secretId,enabled,checkIds,...(channel?{version:channel.version}:{})}
      if (channel) await api.patch(`/admin/notifications/channels/${channel.id}`,payload)
      else await api.post('/admin/notifications/channels',payload)
      await onSaved()
    } catch { setError('Could not save channel. Check your selections and reload if it was changed.') }
    finally { setBusy(false) }
  }
  return <Modal icon="notifications" title={channel?'Edit channel':'Add Channel'} onClose={onClose}><form onSubmit={event=>void submit(event)}><div className="p-6 space-y-3">
    <label className="block">Channel name<input className="input-sig w-full" value={name} maxLength={100} required onChange={event=>setName(event.target.value)} /></label>
    <label className="block">Approved webhook destination<select className="input-sig w-full" required value={endpointId} onChange={event=>setEndpointId(event.target.value)}><option value="">— select destination —</option>{destinations.data?.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <p className="text-sm">Destinations are configured by the deployment administrator. Only HTTPS endpoints are supported. The Vault token must be at most 4096 characters and use only letters, digits, hyphen, dot, underscore, tilde, plus, slash, and optional trailing equals signs.</p>
    <label className="block">Vault<select className="input-sig w-full" required value={vaultId||''} onChange={event=>{setVaultId(Number(event.target.value));setSecretId(0)}}><option value="">— select vault —</option>{vaults.data?.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
    <label className="block">Secure Value secret<select className="input-sig w-full" required disabled={!vaultId} value={secretId||''} onChange={event=>setSecretId(Number(event.target.value))}><option value="">— select secret —</option>{secrets.data?.filter(s=>s.type==='value').map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
    <label className="flex gap-2"><input type="checkbox" checked={enabled} onChange={event=>setEnabled(event.target.checked)} />Enabled</label>
    <fieldset><legend>Monitors</legend><p className="text-sm">Select local monitors with checks. Gatus-managed monitors remain read-only.</p>{checks.data?.map(check=><label className="flex gap-2" key={check.id}><input type="checkbox" checked={checkIds.includes(check.id)} onChange={event=>setCheckIds(current=>event.target.checked?[...current,check.id]:current.filter(id=>id!==check.id))} />{check.name}</label>)}</fieldset>
    {(destinations.isError||checks.isError||vaults.isError||secrets.isError) && <p role="alert">Could not load channel choices. Close and try again.</p>}{error && <p role="alert">{error}</p>}
  </div><ModalFooter><button className="btn btn-secondary" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy||!endpointId||!vaultId||!secretId}>{channel?'Save Channel':'Create Channel'}</button></ModalFooter></form></Modal>
}
