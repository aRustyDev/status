import { useState, useEffect, useRef } from 'react'
import { api } from '../../api/client'
import { DEFAULT_CERT_WARN_DAYS, DEFAULT_EXPIRY_WARN_DAYS, DEFAULT_LATENCY_ALERT, supportsLatencyAlert } from '@bsp/shared'
import type { Action, HttpAssertion, Monitor, MonitorAction, MonitorType, NotificationChannel, MonitorTag } from '@bsp/shared'
import { ModalFooter, ModalHeader, ModalShell } from '@better-forge/ui'
import { YamlViewModal } from '../YamlViewModal'
import { AuthSection, readAuth } from './AuthSection'
import { SidePanelFrame, SideTabStrip, type SideTab } from '@better-forge/ui'
import { ActionsSection, ChannelsSection, CredentialsSection, DependenciesSection, PANEL_META, RequestSection, hasAccountCredentials, hasDatabaseCredentials, usesCredentials, type SidePanelKey } from './MonitorSidePanel'
import { HttpAssertionsFields } from './HttpAssertionsFields'
import { MonitorTypeConfigFields } from './MonitorTypeConfigFields'
import { Field, type SecretSummary, type VaultSummary } from '@better-forge/ui'
import { DATABASE_DEFAULT_PORTS, DATABASE_DEFAULT_QUERIES, isDatabaseType } from './monitorTypes'
import { MonitorTypePicker } from './MonitorTypePicker'
import { ScheduleSection } from './ScheduleSection'
import { AutoIncidentSection, type AutoIncidentValues } from './AutoIncidentSection'
import { LatencyAlertSection, type LatencyAlertValues } from './LatencyAlertSection'
import { TagsSection } from './TagsSection'
import { GroupCombobox } from './GroupCombobox'
import { TestResultPanel, type TestResult } from './TestResultPanel'
import { Alert } from '@better-forge/ui'

export interface CloudflareProfile {
  isAdmin: boolean
  statusUnavailable?: boolean | undefined
  settingsUnavailable?: boolean | undefined
  retrySettings?: (() => void) | undefined
  endpoints: { id: string; name: string }[]
  check?: { id: string; version: number; endpointId: string; enabled: boolean | number; intervalMinutes: number; expectedStatus: number; advancedConfig?: Record<string, unknown> | null; advancedConfigInvalid?: boolean } | undefined
  manualStatus: string
  position: number
  history?: React.ReactNode
  save: (draft: { name: string; manualStatus: string; position: number; check?: Record<string, unknown> }) => Promise<void>
  test: (draft: { endpointId: string; expectedStatus: number; advancedConfig: Record<string, unknown> }) => Promise<TestResult>
}

interface Props {
  cloudflare?: CloudflareProfile | undefined
  monitor: Monitor | null
  /** Type preselected when creating a monitor; ignored when editing. */
  initialType?: MonitorType | undefined
  allTags?: MonitorTag[]
  allGroups?: string[]
  onClose: () => void
  onSaved: () => void
}

const defaultConfigs: Record<MonitorType, Record<string, unknown>> = {
  https:     { url: 'https://', method: 'GET', expectedStatus: 200 },
  ping:      { host: '', mode: 'tcp', port: 80 },
  dns:       { hostname: '', recordType: 'A' },
  sqlserver: { host: '', port: 1433, database: '', user: '', password: '', tls: 'verify', query: 'SELECT 1' },
  postgresql: { host: '', port: 5432, database: '', user: '', password: '', tls: 'verify', query: 'SELECT 1' },
  mysql:     { host: '', port: 3306, database: '', user: '', password: '', tls: 'verify', query: 'SELECT 1' },
  mongodb:   { host: '', port: 27017, database: '', user: '', password: '', tls: 'verify', query: '{"ping":1}' },
  oracle:    { host: '', port: 1521, database: '', user: '', password: '', tls: 'verify', query: 'SELECT 1 FROM DUAL' },
  redis:     { host: '', port: 6379 },
  mail:      { protocol: 'smtp', host: '', port: 587, security: 'starttls' },
  ssh:       { host: '', port: 22 },
  tls:       { host: '', port: 443, warnDays: DEFAULT_CERT_WARN_DAYS },
  domain:    { domain: '', warnDays: DEFAULT_EXPIRY_WARN_DAYS },
  docker:    { endpoint: 'unix:///var/run/docker.sock', container: '' },
  webhook:   {},
}

/** The links the server would refuse, found before anything is saved. */
function actionLinkProblem(links: MonitorAction[] | null): string | null {
  if (!links) return null
  const seen = new Set<string>()
  for (const link of links) {
    const key = `${link.actionId}:${link.onStatus}`
    if (seen.has(key)) return 'An action can be linked once per status.'
    seen.add(key)
    for (const minutes of [link.delayMinutes, link.cooldownMinutes]) {
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > 10080) return 'Action delay and cooldown must be whole minutes from 0 to 10080.'
    }
  }
  return null
}

export default function MonitorFormModal({ monitor, initialType = 'https', allTags = [], allGroups = [], onClose, onSaved, cloudflare }: Props) {
  const isEdit = !!monitor
  // The form fields are initialized once; its optimistic revision must come
  // from the same snapshot even if a background query later refreshes.
  const [initialCloudflareCheck] = useState(cloudflare?.check)
  const [manualStatus, setManualStatus] = useState(cloudflare?.manualStatus ?? 'operational')
  const [position, setPosition] = useState(cloudflare?.position ?? 0)
  const [endpointId, setEndpointId] = useState(cloudflare?.check?.endpointId ?? '')
  const [enabled, setEnabled] = useState(Boolean(cloudflare?.check?.enabled))
  const [showYaml, setShowYaml] = useState(false)
  const [name, setName]               = useState(monitor?.name ?? '')
  const [type, setType]               = useState<MonitorType>(monitor?.type as MonitorType ?? initialType)
  const [intervalSecs, setIntervalSecs] = useState(cloudflare?.check ? cloudflare.check.intervalMinutes * 60 : monitor?.intervalSecs ?? 60)
  const [timeoutMs, setTimeoutMs]     = useState(cloudflare?.check ? Number(cloudflare.check.advancedConfig?.timeoutMs ?? 5000) : monitor?.timeoutMs ?? 10000)
  const [config, setConfig]           = useState<Record<string, unknown>>(
    cloudflare ? { method: 'GET', expectedStatus: cloudflare.check?.expectedStatus ?? 200, ...cloudflare.check?.advancedConfig } : monitor ? (monitor.config as unknown as Record<string, unknown>) : (defaultConfigs[initialType] as Record<string, unknown>),
  )
  const [retries, setRetries]           = useState(cloudflare?.check ? Number(cloudflare.check.advancedConfig?.attempts ?? 1) : monitor?.retries ?? 1)
  const [failureThreshold, setFailureThreshold]   = useState(monitor?.failureThreshold ?? 1)
  const [recoveryThreshold, setRecoveryThreshold] = useState(monitor?.recoveryThreshold ?? 1)
  const [autoIncident, setAutoIncident] = useState<AutoIncidentValues>({
    autoIncidentMinutes: monitor?.autoIncidentMinutes ?? null,
    autoIncidentMode: monitor?.autoIncidentMode ?? 'draft',
    autoIncidentTemplateId: monitor?.autoIncidentTemplateId ?? null,
  })
  const [latencyAlert, setLatencyAlert] = useState<LatencyAlertValues>({
    latencyAlertFactor: monitor?.latencyAlertFactor ?? null,
    latencyAlertWindowMinutes: monitor?.latencyAlertWindowMinutes ?? DEFAULT_LATENCY_ALERT.windowMinutes,
    latencyAlertMinDeltaMs: monitor?.latencyAlertMinDeltaMs ?? DEFAULT_LATENCY_ALERT.minDeltaMs,
    latencyAlertSustain: monitor?.latencyAlertSustain ?? DEFAULT_LATENCY_ALERT.sustain,
  })
  const [tags, setTags]                 = useState<MonitorTag[]>(monitor?.tags ?? [])
  const [group, setGroup]               = useState(monitor?.group ?? '')
  // A new database monitor cannot work without credentials, so their panel starts open.
  const [sidePanel, setSidePanel] = useState<SidePanelKey | null>(!monitor && isDatabaseType(initialType) ? 'credentials' : null)
  const [webhookToken, setWebhookToken] = useState<string | null>(monitor?.webhookToken ?? null)
  const [resettingToken, setResettingToken] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const testRevision = useRef(0)

  const [vaults, setVaults]                 = useState<VaultSummary[]>([])
  const [secretsByVault, setSecretsByVault] = useState<Record<number, SecretSummary[]>>({})
  const [channels, setChannels]             = useState<NotificationChannel[]>([])
  const [selectedChannelIds, setSelectedChannelIds] = useState<Set<number>>(new Set())
  // Actions are managed by admins only: for anyone else the list does not load and the tab stays hidden.
  const [availableActions, setAvailableActions] = useState<Action[] | null>(null)
  const [actionLinks, setActionLinks]           = useState<MonitorAction[] | null>(monitor ? null : [])
  const [allMonitors, setAllMonitors]       = useState<{ id: number; name: string }[]>([])
  const [selectedDependsOnIds, setSelectedDependsOnIds] = useState<Set<number>>(new Set())

  useEffect(() => {
    if (cloudflare) return
    api.get<VaultSummary[]>('/admin/vaults').then(setVaults).catch(() => {})
    api.get<NotificationChannel[]>('/admin/notifications/channels').then(setChannels).catch(() => {})
    api.get<{ id: number; name: string }[]>('/admin/monitors').then(setAllMonitors).catch(() => {})
    api.get<Action[]>('/admin/actions').then(setAvailableActions).catch(() => {})
    if (monitor) {
      api.get<number[]>(`/admin/notifications/monitor/${monitor.id}/channels`)
        .then((ids) => setSelectedChannelIds(new Set(ids)))
        .catch(() => {})
      api.get<MonitorAction[]>(`/admin/actions/monitor/${monitor.id}`).then(setActionLinks).catch(() => {})
      api.get<{ dependsOnIds: number[] }>(`/admin/monitors/${monitor.id}/dependencies`)
        .then((r) => setSelectedDependsOnIds(new Set(r.dependsOnIds)))
        .catch(() => {})
    }
  }, [monitor, cloudflare])

  // Pre-load secrets for any vault already configured in the monitor being edited
  // The initial monitor configuration is immutable for the lifetime of the modal.
  useEffect(() => {
    if (!monitor || cloudflare) return
    const cfg = monitor.config as unknown as Record<string, unknown>
    const authCfg = cfg['auth'] as Record<string, unknown> | undefined
    const ids = [
      (authCfg?.['basic'] as Record<string, unknown> | undefined)?.['vault'],
      (authCfg?.['oauth2'] as Record<string, unknown> | undefined)?.['vault'],
      (authCfg?.['cas'] as Record<string, unknown> | undefined)?.['vault'],
      cfg['vault'],
    ]
      .filter(Boolean)
      .map((v) => (v as { vaultId: number }).vaultId)
      .filter((id) => id > 0)
    for (const id of ids) loadSecrets(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadSecrets(vaultId: number) {
    if (secretsByVault[vaultId]) return
    try {
      const secrets = await api.get<SecretSummary[]>(`/admin/vaults/${vaultId}/secrets`)
      setSecretsByVault((prev) => ({ ...prev, [vaultId]: secrets }))
    } catch { /* ignore */ }
  }

  function handleTypeChange(newType: MonitorType) {
    invalidateCloudflareTest()
    setType(newType)
    setConfig(defaultConfigs[newType] as Record<string, unknown>)
    if (isDatabaseType(newType)) setSidePanel('credentials')
    else if (sidePanel === 'latency' && !supportsLatencyAlert(newType)) setSidePanel(null)
    else if ((sidePanel === 'credentials' && !usesCredentials(newType)) || (newType !== 'https' && (sidePanel === 'auth' || sidePanel === 'request' || sidePanel === 'checks'))) setSidePanel(null)
  }

  /** Switches the engine of a Database monitor, keeping what was typed; only a default port and test query follow the engine. */
  function handleEngineChange(engine: MonitorType) {
    const oldPort = DATABASE_DEFAULT_PORTS[type]
    const oldQuery = DATABASE_DEFAULT_QUERIES[type]
    setType(engine)
    setConfig((prev) => ({
      ...prev,
      ...(prev['port'] === oldPort ? { port: DATABASE_DEFAULT_PORTS[engine] } : {}),
      ...(prev['query'] === oldQuery ? { query: DATABASE_DEFAULT_QUERIES[engine] } : {}),
    }))
  }

  function updateConfig(key: string, value: unknown) {
    invalidateCloudflareTest()
    setConfig((prev) => ({ ...prev, [key]: value }))
  }

  function useExpectedStatus() {
    invalidateCloudflareTest()
    setConfig((prev) => {
      const { acceptedStatusRanges: _ranges, ...rest } = prev
      return rest
    })
  }

  function invalidateCloudflareTest() {
    if (!cloudflare) return
    testRevision.current += 1
    setTestResult(null)
  }

  /** Errors propagate so the webhook section can show why the token was not rotated. */
  async function handleResetToken() {
    if (!monitor) return
    setResettingToken(true)
    try {
      const updated = await api.post<{ webhookToken: string }>(`/admin/monitors/${monitor.id}/reset-token`, {})
      setWebhookToken(updated.webhookToken)
    } finally {
      setResettingToken(false)
    }
  }

  async function handleTest() {
    if (!isTestable) return
    const revision = testRevision.current
    setTesting(true)
    setTestResult(null)
    try {
      // monitorId lets the server test with the stored value of a secret the form only shows masked.
      const result = cloudflare ? await cloudflare.test({ endpointId, expectedStatus: Number(config['expectedStatus'] ?? 200), advancedConfig: cloudflareConfig() }) : await api.post<TestResult>('/admin/monitors/test', { type, config, timeoutMs, ...(isEdit ? { monitorId: monitor.id } : {}) })
      if (!cloudflare || revision === testRevision.current) setTestResult(result)
    } catch (err) {
      if (!cloudflare || revision === testRevision.current) setTestResult({ overall: 'error', steps: [{ label: 'Test request failed', status: 'error', detail: err instanceof Error ? err.message : String(err) }], totalMs: 0 })
    } finally {
      setTesting(false)
    }
  }

  /** Skipped when the links did not load: saving an empty list would wipe the ones the monitor already has. */
  async function saveActionLinks(monitorId: number) {
    if (availableActions === null || actionLinks === null) return
    if (!isEdit && actionLinks.length === 0) return
    await api.put(`/admin/actions/monitor/${monitorId}`, { actions: actionLinks })
  }

  function comparable(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(comparable).join(',')}]`
    if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${comparable(item)}`).join(',')}}`
    return JSON.stringify(value) ?? 'null'
  }

  function cloudflareConfig(): Record<string, unknown> {
    const { expectedStatus: _expectedStatus, ...advanced } = config
    return { ...advanced, timeoutMs, attempts: retries }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    // "Done" after webhook creation — just close and refresh
    if (type === 'webhook' && !isEdit && webhookToken) { onSaved(); return }

    setError('')
    if (cloudflare) {
      setLoading(true)
      try {
        const advanced = cloudflareConfig()
        if (timeoutMs * retries > 10000) throw new Error('Timeout multiplied by attempts must not exceed 10,000 ms.')
        if (config['method'] === 'HEAD' && (config['keyword'] || ((config['assertions'] as HttpAssertion[] | undefined) ?? []).some(assertion => assertion.type === 'json'))) throw new Error('HEAD responses have no body. Remove the keyword and JSON checks or use GET.')
        const previous = initialCloudflareCheck
        if (previous && !endpointId) throw new Error('Select an approved destination for this check.')
        const previousAdvanced = { method: 'GET', ...previous?.advancedConfig, timeoutMs: Number(previous?.advancedConfig?.timeoutMs ?? 5000), attempts: Number(previous?.advancedConfig?.attempts ?? 1) }
        const advancedUnchanged = comparable(advanced) === comparable(previousAdvanced)
        const basicUnchanged = previous && endpointId === previous.endpointId && enabled === Boolean(previous.enabled) && intervalSecs === previous.intervalMinutes * 60 && Number(config['expectedStatus'] ?? 200) === previous.expectedStatus
        if (previous?.advancedConfigInvalid && !(basicUnchanged && advancedUnchanged)) throw new Error('Check settings are invalid. Contact an administrator to review the configuration.')
        const check = cloudflare.isAdmin && endpointId && !(basicUnchanged && advancedUnchanged) ? { ...(previous ? { id: previous.id, version: previous.version } : {}), endpointId, enabled, intervalMinutes: intervalSecs / 60, expectedStatus: Number(config['expectedStatus'] ?? 200), advancedConfig: previous && advancedUnchanged ? previous.advancedConfig ?? null : advanced } : undefined
        await cloudflare.save({ name, manualStatus, position, ...(check ? { check } : {}) })
        onSaved()
      } catch (err) { setError(err instanceof Error ? err.message : 'Save failed') } finally { setLoading(false) }
      return
    }
    if (isDatabaseType(type) && !hasDatabaseCredentials(config)) {
      setSidePanel('credentials')
      setError(config['mode'] === 'connectionString' ? 'Choose the Vault secret that holds the connection string.' : 'Enter the database user and password, or choose a secret from Vault.')
      return
    }
    const linkProblem = actionLinkProblem(actionLinks)
    if (linkProblem) {
      setSidePanel('actions')
      setError(linkProblem)
      return
    }
    setLoading(true)
    try {
      const body = { name, type, intervalSecs, timeoutMs, retries, failureThreshold, recoveryThreshold, ...autoIncident, ...latencyAlert, ...(supportsLatencyAlert(type) ? {} : { latencyAlertFactor: null }), config, tags, group: group.trim() || null }
      if (isEdit) {
        await api.patch(`/admin/monitors/${monitor.id}`, body)
        await api.put(`/admin/notifications/monitor/${monitor.id}/channels`, { channelIds: [...selectedChannelIds] })
        await api.put(`/admin/monitors/${monitor.id}/dependencies`, { dependsOnIds: [...selectedDependsOnIds] })
        await saveActionLinks(monitor.id)
      } else {
        const created = await api.post<{ id: number; webhookToken?: string | null }>('/admin/monitors', body)
        if (created.webhookToken) setWebhookToken(created.webhookToken)
        await api.put(`/admin/notifications/monitor/${created.id}/channels`, { channelIds: [...selectedChannelIds] })
        await api.put(`/admin/monitors/${created.id}/dependencies`, { dependsOnIds: [...selectedDependsOnIds] })
        await saveActionLinks(created.id)
        if (created.webhookToken) setWebhookToken(created.webhookToken)
        if (type !== 'webhook') { onSaved(); return }
        // webhook: stay open so user can copy the URL before closing
        setLoading(false)
        return
      }
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setLoading(false)
    }
  }

  const auth = readAuth(config)
  const authType = auth.type ?? 'none'
  const headerCount = Object.keys((config['headers'] as Record<string, string> | undefined) ?? {}).length
  const assertions = (config['assertions'] as HttpAssertion[] | undefined) ?? []
  const degradedAboveMs = config['degradedAboveMs'] as number | undefined
  const keyword = (config['keyword'] as string | undefined) ?? ''
  const checkCount = assertions.length + (degradedAboveMs !== undefined ? 1 : 0) + (keyword ? 1 : 0)
  const vaultPicker = { vaults, secretsByVault, onLoadSecrets: loadSecrets }
  const isTestable = type !== 'webhook'
  const webhookCreated = type === 'webhook' && !isEdit && !!webhookToken

  const sideTabs: SideTab<SidePanelKey>[] = cloudflare ? (cloudflare.isAdmin ? [{ key: 'checks', badge: checkCount > 0 ? String(checkCount) : null }] : []) : [
    ...(usesCredentials(type) ? [
      { key: 'credentials' as const, badge: isDatabaseType(type) ? (hasDatabaseCredentials(config) ? '✓' : '!') : (hasAccountCredentials(config) ? '✓' : null) },
    ] : []),
    ...(type === 'https' ? [
      { key: 'auth' as const,    badge: authType !== 'none' ? authType.slice(0, 1).toUpperCase() : null },
      { key: 'request' as const, badge: headerCount > 0 ? String(headerCount) : null },
      { key: 'checks' as const,  badge: checkCount > 0 ? String(checkCount) : null },
    ] : []),
    { key: 'tags',         badge: tags.length > 0 ? String(tags.length) : null },
    { key: 'channels',     badge: selectedChannelIds.size > 0 ? String(selectedChannelIds.size) : null },
    ...(availableActions !== null && actionLinks !== null ? [{ key: 'actions' as const, badge: actionLinks.length > 0 ? String(actionLinks.length) : null }] : []),
    { key: 'dependencies', badge: selectedDependsOnIds.size > 0 ? String(selectedDependsOnIds.size) : null },
    { key: 'incident',     badge: autoIncident.autoIncidentMinutes !== null ? String(autoIncident.autoIncidentMinutes) : null },
    // Only a type whose response time is the time a service took to answer has something to compare.
    ...(supportsLatencyAlert(type) ? [{ key: 'latency' as const, badge: latencyAlert.latencyAlertFactor !== null ? `${latencyAlert.latencyAlertFactor}×` : null }] : []),
  ]

  return (
    <ModalShell align="top" onClose={onClose} label={isEdit ? 'Edit Monitor' : 'New Monitor'}>
      <div
        className="rounded-2xl my-8 flex flex-col lg:flex-row"
        style={{
          width: sidePanel ? 'min(1024px, calc(100vw - 32px))' : 'min(604px, calc(100vw - 32px))',
          background: 'var(--m3-surface-container-low)',
          border: '1px solid var(--m3-outline-variant)',
          transition: 'width 0.2s ease',
        }}
      >
      <div className={`flex-none min-w-0 w-full ${sidePanel ? 'lg:w-[560px]' : 'lg:w-[calc(100%-44px)]'}`}>
        {/* Header */}
        <ModalHeader icon="radio_button_checked" title={isEdit ? 'Edit Monitor' : 'New Monitor'} onClose={onClose} />

        {cloudflare?.statusUnavailable && <div className="p-6"><Alert tone="error">{cloudflare.settingsUnavailable ? 'Check settings are unavailable. Your draft is preserved.' : 'Monitor status is unavailable. Your draft is preserved while the latest status is loaded.'}</Alert>{cloudflare.retrySettings && <button type="button" className="btn btn-secondary mt-2" onClick={cloudflare.retrySettings}>Retry check settings</button>}</div>}
        <form onSubmit={handleSubmit} style={{ display: cloudflare?.statusUnavailable ? 'none' : undefined }}>
        <div className="p-6 space-y-4">
          {error && <Alert tone="error">{error}</Alert>}

          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} required className="input-sig" placeholder="My Service" />
          </Field>

          {!cloudflare && <Field label="Group">
            {({ id }) => <GroupCombobox id={id} value={group} groups={allGroups} onChange={setGroup} />}
          </Field>}


          {(!cloudflare || cloudflare.isAdmin) && <MonitorTypePicker value={type} onChange={handleTypeChange} allowedTypes={cloudflare ? ['https'] : undefined} />}

          {cloudflare ? <>
            <details><summary>Service settings</summary>
              <Field label="Manual health"><select value={manualStatus} onChange={e => setManualStatus(e.target.value)} className="input-sig"><option value="operational">Operational</option><option value="degraded">Degraded</option><option value="down">Down</option></select></Field>
              <Field label="Order"><input type="number" min={0} value={position} onChange={e => setPosition(Number(e.target.value))} className="input-sig" /></Field>
            </details>
            {cloudflare.check?.advancedConfigInvalid && <Alert tone="error">Check settings are invalid. Contact an administrator to review the configuration.</Alert>}
            {cloudflare.isAdmin && <>
              <Field label="Approved destination"><select value={endpointId} onChange={e => { invalidateCloudflareTest(); setEndpointId(e.target.value) }} className="input-sig"><option value="">No check</option>{cloudflare.endpoints.map(endpoint => <option key={endpoint.id} value={endpoint.id}>{endpoint.name}</option>)}</select></Field>
              {endpointId && <>
                <div className="grid grid-cols-2 gap-3"><Field label="Method"><select value={String(config['method'] ?? 'GET')} onChange={e => updateConfig('method', e.target.value)} className="input-sig"><option>GET</option><option>HEAD</option></select></Field>
                <Field label="Expected status"><input type="number" min={100} max={599} required disabled={Array.isArray(config['acceptedStatusRanges']) && config['acceptedStatusRanges'].length > 0} value={Number(config['expectedStatus'] ?? 200)} onChange={e => updateConfig('expectedStatus', Number(e.target.value))} className="input-sig" /></Field></div>
                {Array.isArray(config['acceptedStatusRanges']) && config['acceptedStatusRanges'].length > 0 && <div className="text-sm space-y-2">
                  <p>This check accepts status ranges: {config['acceptedStatusRanges'].map((range: { min: number; max: number }) => `${range.min}–${range.max}`).join(', ')}. The expected status is not used while these ranges are configured.</p>
                  <button type="button" className="btn btn-secondary" onClick={useExpectedStatus}>Use a single expected status</button>
                </div>}
                <label><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> Enabled</label>
              </>}
            </>}
            {cloudflare.history}
          </> : <MonitorTypeConfigFields
            type={type} config={config} updateConfig={updateConfig} onEngineChange={handleEngineChange}
            webhook={{ token: webhookToken, canReset: isEdit, resetting: resettingToken, onReset: handleResetToken }} />}

          <div style={{ borderTop: '1px solid var(--m3-outline-variant)' }} />

          {(!cloudflare || (cloudflare.isAdmin && endpointId)) && <ScheduleSection
            cloudflare={!!cloudflare}
            values={{ intervalSecs, timeoutMs, retries, failureThreshold, recoveryThreshold }}
            onChange={(p) => {
              if (p.intervalSecs !== undefined) setIntervalSecs(p.intervalSecs)
              if (p.timeoutMs !== undefined) { invalidateCloudflareTest(); setTimeoutMs(p.timeoutMs) }
              if (p.retries !== undefined) { invalidateCloudflareTest(); setRetries(p.retries) }
              if (p.failureThreshold !== undefined) setFailureThreshold(p.failureThreshold)
              if (p.recoveryThreshold !== undefined) setRecoveryThreshold(p.recoveryThreshold)
            }}
          />}

          {/* ── Test result panel ─────────────────────────────────────────── */}
          {testResult && <TestResultPanel result={testResult} />}

        </div>

        <ModalFooter
          start={<>
            {isEdit && !cloudflare && (
              <button type="button" onClick={() => setShowYaml(true)} title="The saved monitor as YAML" className="btn btn-secondary">
                <span className="material-symbols-outlined" aria-hidden="true">data_object</span>
                YAML
              </button>
            )}
            {isTestable && (!cloudflare || (cloudflare.isAdmin && endpointId)) && (
              <button type="button" onClick={handleTest} disabled={testing || loading} className="btn btn-outline">
                {testing
                  ? <><span className="material-symbols-outlined animate-spin" aria-hidden="true">progress_activity</span> Testing…</>
                  : <><span className="material-symbols-outlined" aria-hidden="true">play_arrow</span> Test</>
                }
              </button>
            )}
          </>}
        >
          <button type="button" onClick={onClose} className="btn btn-secondary">
            {webhookCreated ? 'Close' : 'Cancel'}
          </button>
          <button type="submit" disabled={loading} className="btn btn-primary">
            {loading ? 'Saving…' : webhookCreated ? 'Done' : isEdit ? 'Save Changes' : 'Create Monitor'}
          </button>
        </ModalFooter>
        </form>
      </div>{/* inner scrollable column */}

      {/* ── Side panel ─────────────────────────────────────────────────── */}
      {sidePanel && (
        <SidePanelFrame meta={PANEL_META[sidePanel]} layout="responsive" className={cloudflare?.statusUnavailable ? 'hidden' : undefined}>
          {sidePanel === 'request' && <RequestSection config={config} updateConfig={updateConfig} />}
          {sidePanel === 'checks' && (
            <HttpAssertionsFields
              keyword={keyword}
              onKeywordChange={(value) => updateConfig('keyword', value)}
              assertions={assertions}
              degradedAboveMs={degradedAboveMs}
              onAssertionsChange={(list) => updateConfig('assertions', list.length > 0 ? list : undefined)}
              onDegradedAboveMsChange={(ms) => updateConfig('degradedAboveMs', ms)}
            />
          )}
          {sidePanel === 'credentials' && <CredentialsSection config={config} updateConfig={updateConfig} vaultPicker={vaultPicker} userKey={isDatabaseType(type) ? 'user' : 'username'} />}
          {sidePanel === 'auth' && <AuthSection auth={auth} onChange={(next) => updateConfig('auth', next)} vaultPicker={vaultPicker} />}
          {sidePanel === 'tags' && <TagsSection tags={tags} allTags={allTags} onChange={setTags} />}
          {sidePanel === 'channels' && <ChannelsSection channels={channels} selected={selectedChannelIds} onChange={setSelectedChannelIds} />}
          {sidePanel === 'actions' && availableActions !== null && actionLinks !== null && (
            <ActionsSection actions={availableActions} links={actionLinks} onChange={setActionLinks} />
          )}
          {sidePanel === 'dependencies' && (
            <DependenciesSection
              monitors={allMonitors.filter((m) => m.id !== monitor?.id)}
              selected={selectedDependsOnIds}
              onChange={setSelectedDependsOnIds}
            />
          )}
          {sidePanel === 'incident' && (
            <AutoIncidentSection values={autoIncident} onChange={(p) => setAutoIncident((prev) => ({ ...prev, ...p }))} />
          )}
          {sidePanel === 'latency' && (
            <LatencyAlertSection values={latencyAlert} onChange={(p) => setLatencyAlert((prev) => ({ ...prev, ...p }))} baselineMs={monitor?.latencyBaselineP95 ?? null} />
          )}
        </SidePanelFrame>
      )}

      {/* ── Vertical tab strip ──────────────────────────────────────────── */}
      <SideTabStrip tabs={sideTabs} meta={PANEL_META} active={sidePanel} onToggle={setSidePanel} layout="responsive" className={cloudflare?.statusUnavailable ? 'hidden' : undefined} />

      </div>{/* outer flex row */}
      {showYaml && monitor && <YamlViewModal kind="Monitor" objectKey={monitor.key} title={monitor.name} onClose={() => setShowYaml(false)} />}
    </ModalShell>
  )
}
