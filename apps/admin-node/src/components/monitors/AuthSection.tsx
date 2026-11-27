import type { HttpsAuth, HttpsAuthType } from '@bsp/shared'
import type { VaultRef } from '@better-forge/contracts'
import { CredentialSection } from '@better-forge/ui'
import { Field, JSON_MAPPING_FIELDS, type VaultPickerProps } from '@better-forge/ui'

const AUTH_TYPES: { value: HttpsAuthType; label: string }[] = [
  { value: 'none',   label: 'None' },
  { value: 'basic',  label: 'Basic' },
  { value: 'oauth2', label: 'OAuth2' },
  { value: 'cas',    label: 'CAS' },
]

type Section = Record<string, unknown> | undefined

/** Reads the HTTPS auth block of a monitor config, defaulting to no auth. */
export function readAuth(config: Record<string, unknown>): HttpsAuth {
  return (config['auth'] as HttpsAuth | undefined) ?? { type: 'none' as HttpsAuthType }
}

/** HTTPS authentication settings: the scheme switcher plus the credentials each scheme needs. */
export function AuthSection({ auth, onChange, vaultPicker, cloudflare = false, vaultError = false, authProviders }: { auth: HttpsAuth; onChange: (auth: HttpsAuth) => void; vaultPicker: VaultPickerProps; cloudflare?: boolean; vaultError?: boolean; authProviders?: { oauth2?: { id: string; name: string }; cas?: { id: string; name: string } } | undefined }) {
  const authType = auth.type ?? 'none'
  const basic  = auth.basic  as Section
  const oauth2 = auth.oauth2 as Section
  const cas    = auth.cas    as Section

  function setAuthType(t: HttpsAuthType) {
    if (!cloudflare) { onChange({ ...auth, type: t }); return }
    if (t === authType) return
    if (t === 'none') { onChange({ type: 'none' }); return }
    const provider = t === 'oauth2' || t === 'cas' ? authProviders?.[t] : undefined
    onChange({ type: t, [t]: { ...(provider ? { providerId: provider.id } : {}), vault: { vaultId: 0, secretId: 0 } } } as unknown as HttpsAuth)
  }
  function unavailable(t: HttpsAuthType) { return cloudflare && (t === 'oauth2' || t === 'cas') && !authProviders?.[t] }
  function updateBasic(patch: Record<string, unknown>)  { onChange({ ...auth, basic:  { ...(auth.basic  ?? {}), ...patch } } as HttpsAuth) }
  function updateOAuth2(patch: Record<string, unknown>) { onChange({ ...auth, oauth2: { ...(auth.oauth2 ?? {}), ...patch } } as HttpsAuth) }
  function updateCAS(patch: Record<string, unknown>)    { onChange({ ...auth, cas:    { ...(auth.cas    ?? {}), ...patch } } as HttpsAuth) }

  const text = (section: Section, key: string) => (section?.[key] as string | undefined) ?? ''

  return (
    <div className="space-y-4">
      <div className="flex rounded-lg p-1 gap-1" style={{ background: 'var(--m3-surface-container)', border: '1px solid var(--m3-outline-variant)' }}>
        {AUTH_TYPES.map((at) => (
          <button key={at.value} type="button" disabled={unavailable(at.value)} title={unavailable(at.value) ? `${at.label} (unavailable)` : at.label} onClick={() => setAuthType(at.value)}
            className={`flex-1 text-xs font-medium py-1.5 rounded-md transition-all ${authType === at.value ? 'selection-active' : ''}`}
            style={authType === at.value
              ? { background: 'var(--m3-primary-fixed)', color: 'var(--m3-primary)', border: '1px solid color-mix(in srgb, var(--m3-primary) 25%, transparent)' }
              : { color: 'var(--m3-secondary)', border: '1px solid transparent' }
            }
          >
            {at.label}{unavailable(at.value) ? ' (unavailable)' : ''}
          </button>
        ))}
      </div>

      {authType === 'none' && (
        <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>No authentication configured.</p>
      )}

      {authType !== 'none' && cloudflare && (() => {
        const section = authType === 'basic' ? basic : authType === 'oauth2' ? oauth2 : cas
        const ref = section?.['vault'] as VaultRef | undefined
        const provider = authType === 'oauth2' || authType === 'cas' ? authProviders?.[authType] : undefined
        const update = (patch: Record<string, unknown>) => onChange({ type: authType, [authType]: { ...section, ...patch } } as unknown as HttpsAuth)
        const select = (vaultId: number, secretId: number) => update({ vault: { vaultId, secretId } })
        return <div className="space-y-3">
          <p className="text-xs">Choose a User / Password Vault secret.{authType === 'oauth2' && ' The username is the client ID and the password is the client secret.'}</p>
          {authType !== 'basic' && <p className="text-xs">{provider ? `Approved provider: ${provider.name}` : 'This authentication provider is unavailable for the selected destination.'}</p>}
          {authType === 'cas' && <p className="text-xs">CAS supports an approved HTTPS GET destination and a single return redirect. Custom headers and request bodies are unavailable.</p>}
          {authType === 'oauth2' && <Field label="Scope (optional)"><input className="input-sig" value={text(oauth2, 'scope')} onChange={e => update({ scope: e.target.value || undefined })} /></Field>}
          {vaultError && <p role="alert">Could not load Vault secrets. Close and reopen the editor to retry.</p>}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Vault"><select className="input-sig" value={ref?.vaultId || ''} onChange={e => { const id = Number(e.target.value); if (id) vaultPicker.onLoadSecrets(id); select(id, 0) }}><option value="">— select vault —</option>{vaultPicker.vaults.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select></Field>
            <Field label="Secret"><select className="input-sig" value={ref?.secretId || ''} disabled={!ref?.vaultId} onChange={e => select(ref?.vaultId ?? 0, Number(e.target.value))}><option value="">— select secret —</option>{(ref?.vaultId ? vaultPicker.secretsByVault[ref.vaultId] ?? [] : []).filter(s => s.type === 'userpass').map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          </div>
        </div>
      })()}
      {authType === 'basic' && !cloudflare && (
        <CredentialSection {...vaultPicker} vault={basic?.['vault'] as VaultRef | undefined} onVaultChange={(v) => updateBasic(v ? { vault: v, username: undefined, password: undefined } : { vault: v })} mappingFields={JSON_MAPPING_FIELDS.basic}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Username"><input value={text(basic, 'username')} onChange={(e) => updateBasic({ username: e.target.value })} className="input-sig" autoComplete="off" /></Field>
            <Field label="Password"><input type="password" value={text(basic, 'password')} onChange={(e) => updateBasic({ password: e.target.value })} onFocus={(e) => e.target.select()} className="input-sig" autoComplete="new-password" /></Field>
          </div>
        </CredentialSection>
      )}

      {authType === 'oauth2' && !cloudflare && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Token URL"><input value={text(oauth2, 'tokenUrl')} onChange={(e) => updateOAuth2({ tokenUrl: e.target.value })} className="input-sig" placeholder="https://auth.example.com/oauth/token" /></Field>
            <Field label="Scope (optional)"><input value={text(oauth2, 'scope')} onChange={(e) => updateOAuth2({ scope: e.target.value })} className="input-sig" placeholder="read write" /></Field>
          </div>
          <CredentialSection {...vaultPicker} vault={oauth2?.['vault'] as VaultRef | undefined} onVaultChange={(v) => updateOAuth2(v ? { vault: v, clientId: undefined, clientSecret: undefined } : { vault: v })} mappingFields={JSON_MAPPING_FIELDS.oauth2}>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Client ID"><input value={text(oauth2, 'clientId')} onChange={(e) => updateOAuth2({ clientId: e.target.value })} className="input-sig" autoComplete="off" /></Field>
              <Field label="Client Secret"><input type="password" value={text(oauth2, 'clientSecret')} onChange={(e) => updateOAuth2({ clientSecret: e.target.value })} onFocus={(e) => e.target.select()} className="input-sig" autoComplete="new-password" /></Field>
            </div>
          </CredentialSection>
        </>
      )}

      {authType === 'cas' && !cloudflare && (
        <>
          <Field label="CAS Server URL"><input value={text(cas, 'casServerUrl')} onChange={(e) => updateCAS({ casServerUrl: e.target.value })} className="input-sig" placeholder="https://cas.example.com/cas" /></Field>
          <CredentialSection {...vaultPicker} vault={cas?.['vault'] as VaultRef | undefined} onVaultChange={(v) => updateCAS(v ? { vault: v, username: undefined, password: undefined } : { vault: v })} mappingFields={JSON_MAPPING_FIELDS.cas}>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Username"><input value={text(cas, 'username')} onChange={(e) => updateCAS({ username: e.target.value })} className="input-sig" autoComplete="off" /></Field>
              <Field label="Password"><input type="password" value={text(cas, 'password')} onChange={(e) => updateCAS({ password: e.target.value })} onFocus={(e) => e.target.select()} className="input-sig" autoComplete="new-password" /></Field>
            </div>
          </CredentialSection>
        </>
      )}
    </div>
  )
}
