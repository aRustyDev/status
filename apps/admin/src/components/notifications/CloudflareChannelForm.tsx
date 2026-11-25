// Adapted from the BetterStatusPage notification channel editor for Workers channels.
import { useEffect, useId, useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Alert, ApiError, ModalFooter, ModalHeader, ModalShell, Switch } from '@better-forge/ui'
import { ChannelTypePicker } from './ChannelTypePicker'
import { CHANNEL_TYPE_ORDER, type ChannelType } from './channelTypes'
import { api } from '../../api/client'

export type Channel = { id:string; name:string; type?:'webhook'|'email'; endpointId?:string; recipientId?:string; vaultId?:number; secretId?:number; enabled:number; version:number; associationVersion:number; checkIds:string[] }
type Choice = {id:string;name:string}
type CheckChoice = Choice & {componentId:string;version:number}
type Vault = {id:number;name:string}
type Secret = {id:number;name:string;type:string}

export default function CloudflareChannelForm({channel,initialType,onClose,onSaved}:{channel:Channel|null;initialType?:'email'|'webhook';onClose:()=>void;onSaved:()=>Promise<void>}) {
  const [name,setName]=useState(channel?.name??''), [type,setType]=useState<'email'|'webhook'>(channel?.type??initialType??'webhook'), [recipientId,setRecipientId]=useState(channel?.recipientId??''), [endpointId,setEndpointId]=useState(channel?.endpointId??''), [vaultId,setVaultId]=useState(channel?.vaultId??0), [secretId,setSecretId]=useState(channel?.secretId??0)
  const [enabled,setEnabled]=useState(channel?.enabled!==0), [initialCheckIds]=useState<string[]>(() => [...(channel?.checkIds??[])]), [checkIds,setCheckIds]=useState<string[]>(() => [...(channel?.checkIds??[])]), [busy,setBusy]=useState(false), [error,setError]=useState('')
  const titleId = useId()
  const [testing,setTesting] = useState(false)
  const [testMessage,setTestMessage] = useState<{ok:boolean;text:string}|null>(null)
  const destinations=useQuery<Choice[]>({queryKey:['worker-channel-destinations'],queryFn:()=>api.get('/admin/notifications/destinations')})
  const emailDestinations=useQuery<Choice[]>({queryKey:['worker-email-destinations'],queryFn:()=>api.get('/admin/notifications/email-destinations')})
  const checks=useQuery<CheckChoice[]>({queryKey:['worker-channel-checks'],queryFn:()=>api.get('/admin/notifications/checks'),refetchOnMount:'always'})
  const [checkSnapshots,setCheckSnapshots]=useState<Record<string,CheckChoice>>({})
  useEffect(()=>{
    if (!checks.isFetchedAfterMount || !checks.data) return
    setCheckSnapshots(current=>{
      const next={...current}
      for (const check of checks.data) if (checkIds.includes(check.id) && !next[check.id]) next[check.id]=check
      return next
    })
  },[checks.isFetchedAfterMount,checks.data,checkIds])
  const missingCheckSnapshots=checkIds.filter(id=>!checkSnapshots[id] || !checks.data?.some(check=>check.id===id))
  const vaults=useQuery<Vault[]>({queryKey:['vaults'],queryFn:()=>api.get('/admin/vaults')})
  const secrets=useQuery<Secret[]>({queryKey:['vault-secrets',vaultId],queryFn:()=>api.get(`/admin/vaults/${vaultId}/secrets`),enabled:type==='webhook' && vaultId>0})
  const dirty = !!channel && (
    name !== channel.name || type !== (channel.type ?? 'webhook') ||
    recipientId !== (channel.recipientId ?? '') || endpointId !== (channel.endpointId ?? '') ||
    vaultId !== (channel.vaultId ?? 0) || secretId !== (channel.secretId ?? 0) ||
    enabled !== (channel.enabled !== 0) || checkIds.length !== initialCheckIds.length ||
    checkIds.some(id => !initialCheckIds.includes(id))
  )
  const emailAvailable = !!emailDestinations.data?.length && !emailDestinations.isError
  const webhookAvailable = !!destinations.data?.length && !destinations.isError && !!vaults.data?.length && !vaults.isError
  const disabledTypes = CHANNEL_TYPE_ORDER.filter(item => {
    if (item === 'email') return !emailAvailable
    if (item === 'webhook') return !webhookAvailable
    return true
  })
  async function testSaved() {
    if (!channel || dirty) return
    setTesting(true)
    setTestMessage(null)
    try {
      await api.post(`/admin/notifications/channels/${channel.id}/test`, {version:channel.version})
      setTestMessage({ok:true,text:'Test sent successfully.'})
    } catch {
      setTestMessage({ok:false,text:'Test failed. Check the destination and channel settings, then try again.'})
    } finally {
      setTesting(false)
    }
  }
  async function submit(event:FormEvent) {
    event.preventDefault(); setError(''); setBusy(true)
    try {
      if (missingCheckSnapshots.length) throw new Error('Selected monitors are unavailable. Remove them or retry loading.')
      const expectedChecks=checkIds.map(id=>({id,componentId:checkSnapshots[id]!.componentId,version:checkSnapshots[id]!.version}))
      const payload=type==='email' ? {name,type,recipientId,enabled,checkIds,expectedChecks,...(channel?{version:channel.version,expectedCheckIds:initialCheckIds,expectedAssociationVersion:channel.associationVersion}:{})} : {name,endpointId,vaultId,secretId,enabled,checkIds,expectedChecks,...(channel?{version:channel.version,expectedCheckIds:initialCheckIds,expectedAssociationVersion:channel.associationVersion}:{})}
      if (channel) await api.patch(`/admin/notifications/channels/${channel.id}`,payload)
      else await api.post('/admin/notifications/channels',payload)
      await onSaved()
    } catch (error) {
      setError(error instanceof ApiError && error.status===409 && error.message==='Monitor choices are out of date. Refresh the page and try again.'
        ? 'Monitor choices are out of date. Refresh the page and try again.'
        : 'Could not save channel. Check your selections and reload if it was changed.')
    }
    finally { setBusy(false) }
  }
  return <ModalShell align="top" onClose={busy ? undefined : onClose} labelledBy={titleId}>
    <div className="rounded-2xl my-8" style={{width:'min(620px, calc(100vw - 32px))',background:'var(--m3-surface-container-low)',border:'1px solid var(--m3-outline-variant)'}}>
    <ModalHeader icon="notifications" titleId={titleId} title={channel?'Edit channel':'New Notification Channel'} onClose={onClose} />
    <form onSubmit={event=>void submit(event)}><div className="p-6 space-y-3">
    <label className="block">Channel name<input className="input-sig w-full" value={name} maxLength={100} required onChange={event=>setName(event.target.value)} /></label>
    <ChannelTypePicker value={type} hints={{email: 'Approved email recipient', webhook: 'Approved HTTPS destination'}} disabled={!!channel} disabledTypes={disabledTypes} onChange={(value:ChannelType)=>{if (value === 'email' || value === 'webhook') setType(value)}} />
    {type==='email' ? <>
      <label className="block">Approved email recipient<select className="input-sig w-full" required value={recipientId} onChange={event=>setRecipientId(event.target.value)}><option value="">— select recipient —</option>{emailDestinations.data?.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {emailDestinations.isLoading && <p role="status">Loading email recipients…</p>}
      {emailDestinations.isError && <p role="alert">Could not load approved email recipients. <button type="button" className="underline" onClick={()=>void emailDestinations.refetch()}>Retry</button></p>}
      {emailDestinations.data?.length===0 && <p>No approved email recipients are configured. Contact the deployment administrator.</p>}
      <p className="text-sm">The sender and recipients are configured by the deployment administrator.</p>
    </> : <>
    <label className="block">Approved webhook destination<select className="input-sig w-full" required value={endpointId} onChange={event=>setEndpointId(event.target.value)}><option value="">— select destination —</option>{destinations.data?.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <p className="text-sm">Destinations are configured by the deployment administrator. Only HTTPS endpoints are supported. The Vault token must be at most 4096 characters and use only letters, digits, hyphen, dot, underscore, tilde, plus, slash, and optional trailing equals signs.</p>
    <label className="block">Vault<select className="input-sig w-full" required value={vaultId||''} onChange={event=>{setVaultId(Number(event.target.value));setSecretId(0)}}><option value="">— select vault —</option>{vaults.data?.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
    <label className="block">Secure Value secret<select className="input-sig w-full" required disabled={!vaultId} value={secretId||''} onChange={event=>setSecretId(Number(event.target.value))}><option value="">— select secret —</option>{secrets.data?.filter(s=>s.type==='value').map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
    </>}
    <Switch label="Enabled" checked={enabled} onChange={setEnabled} />
    <fieldset><legend>Monitors</legend><p className="text-sm">Select local monitors with checks. Gatus-managed monitors remain read-only.</p>{!checks.isFetchedAfterMount && <p role="status">Loading monitors…</p>}{checks.isFetchedAfterMount && !checks.isError && checks.data?.map(check=><label className="flex gap-2" key={check.id}><input type="checkbox" checked={checkIds.includes(check.id)} onChange={event=>{ const selected=event.target.checked; setCheckIds(current=>selected?[...current,check.id]:current.filter(id=>id!==check.id)); setCheckSnapshots(current=>{const next={...current};if(selected)next[check.id]=check;else delete next[check.id];return next}) }} />{check.name}</label>)}
      {checkIds.filter(id=>checks.isFetchedAfterMount && !checks.isError && !checks.data?.some(check=>check.id===id)).map(id=><p key={id} role="alert">A selected monitor is unavailable. <button type="button" className="underline" onClick={()=>{setCheckIds(current=>current.filter(value=>value!==id));setCheckSnapshots(current=>{const next={...current};delete next[id];return next})}}>Remove unavailable monitor</button></p>)}
    </fieldset>
    {((type==='webhook' && (destinations.isError||vaults.isError||secrets.isError))||checks.isError) && <p role="alert">Could not load channel choices. Close and try again.</p>}{error && <p role="alert">{error}</p>}
    {testMessage && <Alert tone={testMessage.ok?'success':'error'}>{testMessage.text}</Alert>}
    {channel && dirty && <p className="text-xs">Save changes before testing the saved settings.</p>}
  </div><ModalFooter start={channel ? <button type="button" className="btn btn-secondary" disabled={testing || dirty || busy} onClick={()=>void testSaved()}>{testing?'Testing…':'Send test (saved settings)'}</button> : undefined}><button className="btn btn-secondary" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy||!checks.isFetchedAfterMount||checks.isError||missingCheckSnapshots.length>0||(type==='email' ? !recipientId||emailDestinations.isLoading||emailDestinations.isError : !endpointId||!vaultId||!secretId||destinations.isLoading||destinations.isError||vaults.isLoading||vaults.isError||secrets.isLoading||secrets.isError)}>{channel?'Save Channel':'Create Channel'}</button></ModalFooter></form></div></ModalShell>
}
