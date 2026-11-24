import { useState } from 'react'
import type { HttpAssertion } from '@bsp/shared'
import { Alert } from '@better-forge/ui'
import { api } from '../../api/client'

/** Supported non-secret subset of upstream HTTP settings. */
export type AdvancedHttpConfig = {
  method?: 'GET' | 'HEAD'
  acceptedStatusRanges?: { min: number; max: number }[]
  keyword?: string
  assertions?: HttpAssertion[]
  timeoutMs?: number
  attempts?: number
  degradedAboveMs?: number
}
type Props = { checkId: string; version: number; config: AdvancedHttpConfig | null; onSaved: () => void }

/** A separately versioned operation: it never writes check or component fields. */
export default function AdvancedHttpSettings({ checkId, version, config, onSaved }: Props) {
  const [initialVersion] = useState(version)
  const [enabled, setEnabled] = useState(config !== null)
  const [method, setMethod] = useState<'GET' | 'HEAD'>(config?.method ?? 'GET')
  const [ranges, setRanges] = useState(config?.acceptedStatusRanges ?? [])
  const [keyword, setKeyword] = useState(config?.keyword ?? '')
  const [assertions, setAssertions] = useState<HttpAssertion[]>(config?.assertions ?? [])
  const [timeoutMs, setTimeoutMs] = useState(config?.timeoutMs ?? 10_000)
  const [attempts, setAttempts] = useState(config?.attempts ?? 1)
  const [degradedAboveMs, setDegradedAboveMs] = useState(config?.degradedAboveMs?.toString() ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (enabled && method === 'HEAD' && (keyword || assertions.some(assertion => assertion.type === 'json'))) {
      setError('HEAD responses have no body; remove the keyword and JSON assertions or use GET.')
      return
    }
    if (enabled && timeoutMs * attempts > 10_000) {
      setError('Timeout multiplied by attempts must not exceed 10,000 ms for scheduled checks.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const advancedConfig: AdvancedHttpConfig | null = enabled ? {
        method, timeoutMs, attempts,
        ...(ranges.length ? { acceptedStatusRanges: ranges } : {}),
        ...(keyword ? { keyword } : {}),
        ...(assertions.length ? { assertions } : {}),
        ...(degradedAboveMs ? { degradedAboveMs: Number(degradedAboveMs) } : {}),
      } : null
      await api.put(`/admin/checks/${checkId}/advanced`, { version: initialVersion, advancedConfig })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save advanced settings')
    } finally { setBusy(false) }
  }

  function changeAssertion(index: number, assertion: HttpAssertion) {
    setAssertions(items => items.map((item, at) => at === index ? assertion : item))
  }

  return <form onSubmit={save} className="space-y-3" aria-label="Additional HTTP settings">
    <h3 className="font-bold">Additional HTTP settings</h3>
    <p className="text-sm">These settings cover part of upstream HTTP monitoring. GET and HEAD use approved destinations; request credentials, request bodies, POST and redirects are not supported. Comparison values must not contain secrets. For scheduled checks, timeout multiplied by attempts cannot exceed 10,000 ms.</p>
    <label><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /> Use additional HTTP settings</label>
    {enabled && <div className="space-y-3">
      <label className="block">Method <select value={method} onChange={event => setMethod(event.target.value as 'GET' | 'HEAD')} className="input-sig"><option>GET</option><option>HEAD</option></select></label>
      <p className="text-sm">Without a range, the expected status in the HTTP check above is used.</p>
      {ranges.map((range, index) => <fieldset key={index} className="space-y-1"><legend>Status range {index + 1}</legend>
        <label>From <input type="number" min={100} max={599} required value={range.min} onChange={event => setRanges(items => items.map((item, at) => at === index ? { ...item, min: Number(event.target.value) } : item))} className="input-sig" /></label>
        <label>To <input type="number" min={range.min} max={599} required value={range.max} onChange={event => setRanges(items => items.map((item, at) => at === index ? { ...item, max: Number(event.target.value) } : item))} className="input-sig" /></label>
        <button type="button" onClick={() => setRanges(items => items.filter((_, at) => at !== index))}>Remove status range {index + 1}</button>
      </fieldset>)}
      <button type="button" disabled={ranges.length >= 20} onClick={() => setRanges(items => [...items, { min: 200, max: 299 }])}>Add status range</button>
      <label className="block">Required response keyword <input value={keyword} maxLength={1000} onChange={event => setKeyword(event.target.value)} className="input-sig" /></label>
      {assertions.map((assertion, index) => <fieldset key={index} className="space-y-1"><legend>Response assertion {index + 1}</legend>
        <label>Field type <select value={assertion.type} onChange={event => changeAssertion(index, event.target.value === 'header'
          ? { type: 'header', name: '', op: 'exists', ...(assertion.onFail ? { onFail: assertion.onFail } : {}) }
          : { type: 'json', path: '$', op: 'exists', ...(assertion.onFail ? { onFail: assertion.onFail } : {}) })} className="input-sig"><option value="header">Header</option><option value="json">JSON path</option></select></label>
        {assertion.type === 'header'
          ? <label>Header name <input required value={assertion.name} maxLength={200} onChange={event => changeAssertion(index, { ...assertion, name: event.target.value })} className="input-sig" /></label>
          : <label>JSON path <input required value={assertion.path} maxLength={200} onChange={event => changeAssertion(index, { ...assertion, path: event.target.value })} className="input-sig" /></label>}
        <label>Comparison <select value={assertion.op} onChange={event => {
          const op = event.target.value
          if (assertion.type === 'header') changeAssertion(index, { ...assertion, op: op as Extract<HttpAssertion, { type: 'header' }>['op'] })
          else changeAssertion(index, { ...assertion, op: op as Extract<HttpAssertion, { type: 'json' }>['op'] })
        }} className="input-sig">
          <option value="exists">Exists</option>{assertion.type === 'header' && <option value="not-exists">Is absent</option>}
          <option value="equals">Equals</option><option value="not-equals">Does not equal</option><option value="contains">Contains</option>
          {assertion.type === 'json' && <><option value="lt">Less than</option><option value="gt">Greater than</option></>}
        </select></label>
        {assertion.op !== 'exists' && assertion.op !== 'not-exists' && <label>Comparison value <input required value={assertion.value ?? ''} maxLength={1000} onChange={event => changeAssertion(index, { ...assertion, value: event.target.value })} className="input-sig" /></label>}
        <label>When it fails <select value={assertion.onFail ?? 'degraded'} onChange={event => changeAssertion(index, { ...assertion, onFail: event.target.value as 'degraded' | 'down' })} className="input-sig"><option value="degraded">Degraded</option><option value="down">Down</option></select></label>
        <button type="button" onClick={() => setAssertions(items => items.filter((_, at) => at !== index))}>Remove assertion {index + 1}</button>
      </fieldset>)}
      <button type="button" disabled={assertions.length >= 20} onClick={() => setAssertions(items => [...items, { type: 'header', name: '', op: 'exists' }])}>Add response assertion</button>
      <label className="block">Timeout (ms) <input type="number" min={1000} max={10000} required value={timeoutMs} onChange={event => setTimeoutMs(Number(event.target.value))} className="input-sig" /></label>
      <label className="block">Attempts <input type="number" min={1} max={10} required value={attempts} onChange={event => setAttempts(Number(event.target.value))} className="input-sig" /></label>
      <label className="block">Degraded above (ms) <input type="number" min={1} max={300000} value={degradedAboveMs} onChange={event => setDegradedAboveMs(event.target.value)} className="input-sig" /></label>
    </div>}
    {error && <Alert tone="error">{error}</Alert>}
    <button type="submit" disabled={busy} className="btn btn-primary">Save additional HTTP settings</button>
  </form>
}
