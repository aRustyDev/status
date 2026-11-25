// Adapted from @better-forge/ui's VaultPage (BetterStatusPage upstream, MIT).
// Its Node API client, reveal and external-provider operations are unavailable here.
import { useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, Modal, ModalFooter } from '@better-forge/ui'
import { api } from '../api/client'

type SecretType = 'value' | 'userpass' | 'json'
type Vault = { id: number; name: string; type: 'local' }
type Secret = { id: number; vaultId: number; name: string; type: SecretType; version: number }
const labels: Record<SecretType, string> = { value: 'Secure Value', userpass: 'User / Password', json: 'JSON' }

export default function VaultPage() {
  const qc = useQueryClient()
  const [selected, setSelected] = useState<number | null>(null)
  const [createVault, setCreateVault] = useState(false)
  const [editing, setEditing] = useState<Secret | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Vault | Secret | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const vaults = useQuery<Vault[]>({ queryKey: ['vaults'], queryFn: () => api.get('/admin/vaults') })
  const secrets = useQuery<Secret[]>({ queryKey: ['vault-secrets', selected], queryFn: () => api.get(`/admin/vaults/${selected}/secrets`), enabled: selected !== null })
  const vault = vaults.data?.find(item => item.id === selected)
  async function remove() {
    if (!deleting) return
    setBusy(true); setError('')
    try {
      if ('vaultId' in deleting) {
        await api.delete(`/admin/vaults/${deleting.vaultId}/secrets/${deleting.id}`, { version: deleting.version })
        await qc.invalidateQueries({ queryKey: ['vault-secrets', deleting.vaultId] })
      } else {
        await api.delete(`/admin/vaults/${deleting.id}`)
        if (selected === deleting.id) setSelected(null)
        await qc.invalidateQueries({ queryKey: ['vaults'] })
      }
      setDeleting(null)
    } catch (err) {
      if ('vaultId' in deleting && err instanceof ApiError && err.status === 409) {
        setDeleting(null)
        setError('Secret changed. Review the updated secret before deleting it.')
        await qc.invalidateQueries({ queryKey: ['vault-secrets', deleting.vaultId] })
      } else setError('Could not delete. Check the record and try again.')
    }
    finally { setBusy(false) }
  }
  return <div className="flex flex-col md:flex-row h-full md:overflow-hidden fade-up">
    <aside aria-label="Vaults" className="w-full md:w-64 flex flex-col shrink-0 border-b md:border-b-0 md:border-r" style={{ borderColor: 'var(--m3-outline-variant)', background: 'var(--m3-surface-container-low)' }}>
      <div className="flex items-center justify-between px-4 py-4"><h1 className="font-headline font-bold">Vaults</h1><button className="btn btn-primary btn-sm" aria-label="Create vault" onClick={() => { setError(''); setCreateVault(true) }}>+</button></div>
      <div className="p-2 space-y-1">
        {vaults.isLoading && <p>Loading vaults…</p>}
        {vaults.isError && <p role="alert">Could not load vaults. <button onClick={() => void vaults.refetch()}>Retry</button></p>}
        {vaults.data?.length === 0 && <p className="text-sm p-3">No vaults yet</p>}
        {vaults.data?.map(item => <div key={item.id} className="flex items-center rounded-xl">
          <button className="flex-1 text-left p-3" aria-current={selected === item.id ? 'true' : undefined} onClick={() => setSelected(item.id)}>{item.name}</button>
          <button className="btn-icon" aria-label={`Delete vault ${item.name}`} onClick={() => { setError(''); setDeleting(item) }}>×</button>
        </div>)}
      </div>
    </aside>
    <main className="flex-1 min-w-0 p-4 md:p-6 overflow-auto">
      {error && !deleting && <p role="alert">{error}</p>}
      {vault ? <>
        <div className="flex flex-wrap justify-between items-center gap-3"><div><h2 className="font-headline font-bold text-lg">{vault.name}</h2><span className="text-xs">Local</span></div><button className="btn btn-primary" onClick={() => { setError(''); setEditing('new') }}>New Secret</button></div>
        <p className="text-sm my-4">Names are visible metadata; do not put credentials in names. Secret values cannot be revealed. Rotate a secret to replace its value. Available integrations depend on deployment settings.</p>
        {secrets.isLoading && <p>Loading secrets…</p>}
        {secrets.isError && <p role="alert">Could not load secrets. <button onClick={() => void secrets.refetch()}>Retry</button></p>}
        {secrets.data?.length === 0 && <p>No secrets in this vault.</p>}
        <div className="space-y-2">{secrets.data?.map(secret => <div key={secret.id} className="flex flex-wrap items-center gap-3 p-4 rounded-xl" style={{ background: 'var(--m3-surface-container)', border: '1px solid var(--m3-outline-variant)' }}><div className="flex-1"><p className="font-semibold">{secret.name}</p><p className="text-xs">{labels[secret.type]}</p></div><button className="btn btn-secondary btn-sm" aria-label={`Rotate ${secret.name}`} onClick={() => { setError(''); setEditing(secret) }}>Rotate</button><button className="btn-icon" aria-label={`Delete secret ${secret.name}`} onClick={() => { setError(''); setDeleting(secret) }}>×</button></div>)}</div>
      </> : <p className="text-sm text-center py-16">Select a vault to view its secrets</p>}
    </main>
    {createVault && <CreateVault onClose={() => setCreateVault(false)} onCreated={async item => { await qc.invalidateQueries({ queryKey: ['vaults'] }); setSelected(item.id); setCreateVault(false) }} />}
    {editing && selected !== null && <SecretForm key={editing === 'new' ? 'new' : editing.id} vaultId={selected} secret={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={async () => { await qc.invalidateQueries({ queryKey: ['vault-secrets', selected] }); setEditing(null) }} />}
    {deleting && <Modal icon="delete" title={'vaultId' in deleting ? 'Delete secret' : 'Delete vault'} onClose={() => { if (!busy) setDeleting(null) }}><div className="p-6"><p>Delete {deleting.name}? {'vaultId' in deleting ? 'Any references will stop working.' : 'This also deletes all secrets in the vault.'} This cannot be undone.</p>{error && <p role="alert">{error}</p>}</div><ModalFooter><button className="btn btn-secondary" disabled={busy} onClick={() => setDeleting(null)}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={() => void remove()}>Delete</button></ModalFooter></Modal>}
  </div>
}

function CreateVault({ onClose, onCreated }: { onClose: () => void; onCreated: (vault: Vault) => Promise<void> }) {
  const [name, setName] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); setError(''); try { await onCreated(await api.post<Vault>('/admin/vaults', { name, type: 'local' })) } catch { setError('Could not create vault. Check the name and try again.') } finally { setBusy(false) } }
  return <Modal icon="shield_lock" title="Create vault" onClose={onClose}><form onSubmit={event => void submit(event)}><div className="p-6 space-y-3"><label className="block">Vault name<input className="input-sig w-full" value={name} onChange={event => setName(event.target.value)} required maxLength={100} /></label><p className="text-sm">Local encrypted storage. External vault providers are unavailable.</p>{error && <p role="alert">{error}</p>}</div><ModalFooter><button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="btn btn-primary" disabled={busy}>Create Vault</button></ModalFooter></form></Modal>
}

function SecretForm({ vaultId, secret, onClose, onSaved }: { vaultId: number; secret: Secret | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(''); const [type, setType] = useState<SecretType>(secret?.type ?? 'value')
  const [value, setValue] = useState(''); const [username, setUsername] = useState(''); const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('')
    let payload: Record<string, unknown>
    if (type === 'json') { try { const parsed: unknown = JSON.parse(value); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); payload = { json: value } } catch { setError('Enter a valid JSON object.'); return } }
    else payload = type === 'userpass' ? { userpass: { username, password } } : { value }
    setBusy(true)
    try {
      if (secret) await api.patch(`/admin/vaults/${vaultId}/secrets/${secret.id}`, { ...payload, version: secret.version })
      else await api.post(`/admin/vaults/${vaultId}/secrets`, { name, type, ...payload })
      setValue(''); setUsername(''); setPassword(''); await onSaved()
    } catch { setError('Could not save secret. Check the record and try again.') }
    finally { setBusy(false) }
  }
  return <Modal icon="key" title={secret ? `Rotate ${secret.name}` : 'New Secret'} onClose={onClose}><form onSubmit={event => void submit(event)}><div className="p-6 space-y-3">
    {!secret && <><label className="block">Secret name<input className="input-sig w-full" value={name} onChange={event => setName(event.target.value)} required maxLength={100} /></label><label className="block">Type<select className="input-sig w-full" value={type} onChange={event => { setType(event.target.value as SecretType); setValue(''); setUsername(''); setPassword('') }}><option value="value">Secure Value</option><option value="userpass">User / Password</option><option value="json">JSON</option></select></label></>}
    {type === 'userpass' ? <><label className="block">Username<input className="input-sig w-full" value={username} onChange={event => setUsername(event.target.value)} autoComplete="off" required /></label><label className="block">Password<input className="input-sig w-full" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" required /></label></> : <label className="block">{type === 'json' ? 'JSON object' : 'Value'}{type === 'json' ? <textarea className="input-sig w-full" value={value} onChange={event => setValue(event.target.value)} required /> : <input className="input-sig w-full" type="password" value={value} onChange={event => setValue(event.target.value)} autoComplete="new-password" required />}</label>}
    {error && <p role="alert">{error}</p>}
  </div><ModalFooter><button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="btn btn-primary" disabled={busy}>{secret ? 'Rotate Secret' : 'Save Secret'}</button></ModalFooter></form></Modal>
}
