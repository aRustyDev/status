/**
 * Portable HTTP check evaluator. It is deliberately not wired into the scheduler.
 * The caller must obtain endpoints from the deployment-owned registry and pass the
 * fingerprint stored in D1. Secrets, URLs, assertion values, and response bodies
 * are never returned in results. Only approved, fingerprint-matching targets are
 * contacted; redirects are not followed, including redirects to the same origin.
 */
import { endpointFingerprint, type Endpoint } from '../../worker/src/endpoint-config'
import { parseJsonPath, isNumeric } from '../../api/src/workers/assertionRules'

export type HttpAssertion =
  | { type: 'header'; name: string; op: 'exists' | 'not-exists' | 'equals' | 'not-equals' | 'contains'; value?: string; onFail?: 'down' | 'degraded' }
  | { type: 'json'; path: string; op: 'exists' | 'equals' | 'not-equals' | 'contains' | 'lt' | 'gt'; value?: string | number; onFail?: 'down' | 'degraded' }
export type StatusRange = { min: number; max: number }
export type HttpMonitorConfig = {
  endpointId: string
  /** Fingerprint of this endpoint from the deployment-controlled D1 registry. */
  registryFingerprint: string
  /** Valid methods are case-insensitive; sent in upper case. */
  method?: string
  expectedStatus?: number
  acceptedStatusRanges?: StatusRange[]
  headers?: Record<string, string>
  body?: string
  keyword?: string
  assertions?: HttpAssertion[]
  degradedAboveMs?: number
  timeoutMs?: number
  attempts?: number
}
export type HttpMonitorResult = {
  status: 'up' | 'down' | 'degraded'
  responseMs: number | null
  httpStatus: number | null
  /** A stable, non-sensitive reason code, never an exception or remote text. */
  reasons: string[]
  attempts: number
}
export type HttpMonitorEnvironment = {
  /** Must come from parseEndpoints(env.ENDPOINTS), not from the request body. */
  endpoints: ReadonlyMap<string, Endpoint>
  /** Trusted transport must honor redirect: manual and AbortSignal, and route bound endpoints only via the given binding. */
  fetch: (url: string, init: RequestInit, endpoint: Endpoint) => Promise<Response>
}

const MAX_BODY = 1024 * 1024
const MAX_REQUEST_BODY = 64 * 1024
const MAX_ASSERTIONS = 20
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/
const CONFIG_FIELDS = new Set(['endpointId', 'registryFingerprint', 'method', 'expectedStatus', 'acceptedStatusRanges', 'headers', 'body', 'keyword', 'assertions', 'degradedAboveMs', 'timeoutMs', 'attempts'])
const FORBIDDEN_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'proxy-authorization'])
const CODES = { invalid: 'invalid_configuration', unapproved: 'unapproved_destination', stale: 'destination_fingerprint_mismatch', network: 'request_failed', timeout: 'request_timeout' } as const

function fail(reason: string, attempts = 0): HttpMonitorResult {
  return { status: 'down', responseMs: null, httpStatus: null, reasons: [reason], attempts }
}
function validStatus(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599
}
function validate(config: HttpMonitorConfig): boolean {
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => !CONFIG_FIELDS.has(key)) || typeof config.endpointId !== 'string' || !config.endpointId || typeof config.registryFingerprint !== 'string') return false
  if (config.method !== undefined && (typeof config.method !== 'string' || !['GET', 'POST', 'HEAD'].includes(config.method.toUpperCase()))) return false
  if (config.expectedStatus !== undefined && !validStatus(config.expectedStatus)) return false
  if (config.expectedStatus !== undefined && config.acceptedStatusRanges !== undefined) return false
  if (config.acceptedStatusRanges !== undefined && (!Array.isArray(config.acceptedStatusRanges) || config.acceptedStatusRanges.length < 1 || config.acceptedStatusRanges.length > 20 || config.acceptedStatusRanges.some(range => !range || !validStatus(range.min) || !validStatus(range.max) || range.min > range.max))) return false
  if (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1_000 || config.timeoutMs > 300_000)) return false
  if (config.attempts !== undefined && (!Number.isInteger(config.attempts) || config.attempts < 1 || config.attempts > 10)) return false
  if (config.degradedAboveMs !== undefined && (!Number.isInteger(config.degradedAboveMs) || config.degradedAboveMs < 1 || config.degradedAboveMs > 300_000)) return false
  if (config.body !== undefined && (typeof config.body !== 'string' || new TextEncoder().encode(config.body).length > MAX_REQUEST_BODY || (config.method ?? 'GET').toUpperCase() !== 'POST')) return false
  if (config.keyword !== undefined && (typeof config.keyword !== 'string' || config.keyword.length > 1000)) return false
  if (config.headers !== undefined) {
    if (!config.headers || typeof config.headers !== 'object' || Array.isArray(config.headers) || Object.keys(config.headers).length > 100) return false
    for (const [name, value] of Object.entries(config.headers)) {
      if (!HEADER_NAME.test(name) || FORBIDDEN_HEADERS.has(name.toLowerCase()) || typeof value !== 'string' || value.length > 8192 || /[\r\n\0]/.test(value)) return false
    }
  }
  if (config.assertions !== undefined && (!Array.isArray(config.assertions) || config.assertions.length > MAX_ASSERTIONS || config.assertions.some(a => !validAssertion(a)))) return false
  if ((config.method ?? 'GET').toUpperCase() === 'HEAD' && (config.keyword || config.assertions?.some(a => a.type === 'json'))) return false
  return true
}
function validAssertion(assertion: HttpAssertion): boolean {
  if (!assertion || typeof assertion !== 'object' || (assertion.onFail !== undefined && assertion.onFail !== 'down' && assertion.onFail !== 'degraded')) return false
  const allowed = assertion.type === 'header' ? ['type', 'name', 'op', 'value', 'onFail'] : ['type', 'path', 'op', 'value', 'onFail']
  if (Object.keys(assertion).some(key => !allowed.includes(key))) return false
  const ops = assertion.type === 'header' ? ['exists', 'not-exists', 'equals', 'not-equals', 'contains'] : assertion.type === 'json' ? ['exists', 'equals', 'not-equals', 'contains', 'lt', 'gt'] : []
  if (!ops.includes(assertion.op)) return false
  if (assertion.type === 'header' && (typeof assertion.name !== 'string' || !HEADER_NAME.test(assertion.name))) return false
  if (assertion.type === 'json' && (typeof assertion.path !== 'string' || !parseJsonPath(assertion.path))) return false
  if (assertion.op !== 'exists' && assertion.op !== 'not-exists') {
    if (typeof assertion.value !== 'string' && typeof assertion.value !== 'number') return false
    if (String(assertion.value).length > 1000 || (typeof assertion.value === 'number' && !Number.isFinite(assertion.value))) return false
    if ((assertion.op === 'lt' || assertion.op === 'gt') && !isNumeric(assertion.value)) return false
  }
  return true
}

/**
 * Strictly validate persisted, non-secret advanced settings. This is shared by
 * the management API and the scheduled probe so an invalid write cannot create
 * a check that later fails silently. It deliberately excludes request headers,
 * request body, credentials, POST and user-specified destinations.
 */
export function parsePersistedHttpConfig(value: unknown, endpointId: string, registryFingerprint: string, expectedStatus: number): HttpMonitorConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const config = value as Record<string, unknown>
  const allowed = ['method', 'acceptedStatusRanges', 'keyword', 'assertions', 'timeoutMs', 'attempts', 'degradedAboveMs']
  if (Object.keys(config).some(key => !allowed.includes(key))) return null
  if (config.method !== undefined && (typeof config.method !== 'string' || !['GET', 'HEAD'].includes(config.method.toUpperCase()))) return null
  if (Array.isArray(config.acceptedStatusRanges) && config.acceptedStatusRanges.some(range => !range || typeof range !== 'object' || Array.isArray(range) || Object.keys(range).some(key => !['min', 'max'].includes(key)))) return null
  const candidate = { ...config, endpointId, registryFingerprint, ...(config.acceptedStatusRanges === undefined ? { expectedStatus } : {}) } as HttpMonitorConfig
  if (!validate(candidate)) return null
  // With at most 20 enabled checks and batches of four, this bounds the
  // timeout-dominated portion of a full scheduled tick to about 50 seconds.
  // It does not eliminate overlap under platform delays; save fences remain
  // necessary. This is narrower than the full upstream Node runner.
  return (candidate.timeoutMs ?? 10_000) * (candidate.attempts ?? 1) <= 10_000 ? candidate : null
}
function resolvePath(root: unknown, path: string): unknown {
  let value: unknown = root
  for (const segment of parseJsonPath(path) ?? []) {
    if (typeof segment === 'number') {
      if (!Array.isArray(value) || segment >= value.length) return undefined
      value = value[segment]
    } else {
      if (typeof value !== 'object' || value === null || Array.isArray(value) || !Object.hasOwn(value, segment)) return undefined
      value = (value as Record<string, unknown>)[segment]
    }
  }
  return value
}
function compare(op: HttpAssertion['op'], actual: unknown, expected: string | number | undefined): boolean {
  switch (op) {
    case 'exists': return actual !== undefined
    case 'not-exists': return actual === undefined
    case 'equals': return actual !== undefined && typeof actual !== 'object' && String(actual) === String(expected)
    case 'not-equals': return actual === undefined || typeof actual === 'object' || String(actual) !== String(expected)
    case 'contains': return typeof actual === 'string' ? actual.includes(String(expected)) : Array.isArray(actual) && actual.some(value => typeof value !== 'object' && String(value) === String(expected))
    case 'lt': return isNumeric(actual) && Number(actual) < Number(expected)
    case 'gt': return isNumeric(actual) && Number(actual) > Number(expected)
    default: return false
  }
}

/** Bounded streaming read; never allocates an unbounded response body. */
async function readLimited(response: Response, signal: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false }
  const reader = response.body.getReader()
  const abortRead = () => { void reader.cancel().catch(() => undefined) }
  if (signal.aborted) abortRead()
  else signal.addEventListener('abort', abortRead, { once: true })
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) return { text: text + decoder.decode(), truncated: false }
      const remaining = MAX_BODY - size
      if (part.value.byteLength > remaining) {
        text += decoder.decode(part.value.subarray(0, remaining), { stream: true }) + decoder.decode()
        void reader.cancel().catch(() => undefined)
        return { text, truncated: true }
      }
      size += part.value.byteLength
      text += decoder.decode(part.value, { stream: true })
    }
  } finally { signal.removeEventListener('abort', abortRead); reader.releaseLock() }
}

async function oneAttempt(config: HttpMonitorConfig, endpoint: Endpoint, env: HttpMonitorEnvironment): Promise<Omit<HttpMonitorResult, 'attempts'>> {
  const controller = new AbortController()
  const start = Date.now()
  let response: Response | undefined
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 10_000)
  const deadline = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('deadline')), { once: true }))
  try {
    const work = (async () => {
      response = await env.fetch(endpoint.url, { method: (config.method ?? 'GET').toUpperCase(), headers: config.headers, body: config.body, redirect: 'manual', signal: controller.signal }, endpoint)
      const responseMs = Math.max(0, Date.now() - start)
      const httpStatus = response.status
      // Do not permit an accepted 3xx to hide an unapproved redirect destination.
      if (httpStatus >= 300 && httpStatus < 400 && response.headers.has('location')) return { status: 'down' as const, responseMs, httpStatus, reasons: ['redirect_blocked'] }
      const accepted = config.acceptedStatusRanges?.some(range => httpStatus >= range.min && httpStatus <= range.max) ?? (httpStatus === (config.expectedStatus ?? 200))
      if (!accepted) return { status: 'down' as const, responseMs, httpStatus, reasons: ['unexpected_status'] }
      const assertions = config.assertions ?? []
      const needsBody = Boolean(config.keyword) || assertions.some(a => a.type === 'json')
      const body = needsBody ? await readLimited(response, controller.signal) : { text: '', truncated: false }
      let json: unknown
      let jsonError = false
      const declaredSize = Number(response.headers.get('content-length'))
      const jsonTooLarge = body.truncated || (Number.isFinite(declaredSize) && declaredSize > MAX_BODY)
      if (assertions.some(a => a.type === 'json')) {
        if (jsonTooLarge) jsonError = true
        else { try { json = JSON.parse(body.text) } catch { jsonError = true } }
      }
      const failures: { status: 'down' | 'degraded'; reason: string }[] = []
      if (config.keyword && !body.text.includes(config.keyword)) failures.push({ status: 'degraded', reason: 'keyword_missing' })
      for (const assertion of assertions) {
        if (assertion.type === 'json' && jsonError) failures.push({ status: assertion.onFail ?? 'degraded', reason: jsonTooLarge ? 'json_body_too_large' : 'invalid_json_body' })
        else {
          const actual = assertion.type === 'header' ? response.headers.get(assertion.name) ?? undefined : resolvePath(json, assertion.path)
          if (!compare(assertion.op, actual, assertion.value)) failures.push({ status: assertion.onFail ?? 'degraded', reason: assertion.type === 'header' ? 'header_assertion_failed' : 'json_assertion_failed' })
        }
      }
      if (config.degradedAboveMs !== undefined && responseMs > config.degradedAboveMs) failures.push({ status: 'degraded', reason: 'latency_threshold_exceeded' })
      return { status: failures.some(f => f.status === 'down') ? 'down' as const : failures.length ? 'degraded' as const : 'up' as const, responseMs, httpStatus, reasons: failures.map(f => f.reason) }
    })()
    return await Promise.race([work, deadline])
  } catch {
    return { status: 'down', responseMs: Math.max(0, Date.now() - start), httpStatus: null, reasons: [controller.signal.aborted ? CODES.timeout : CODES.network] }
  } finally {
    clearTimeout(timer)
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined)
  }
}

export async function evaluateHttpMonitor(config: HttpMonitorConfig, env: HttpMonitorEnvironment): Promise<HttpMonitorResult> {
  if (!validate(config)) return fail(CODES.invalid)
  const configuredEndpoint = env.endpoints.get(config.endpointId)
  if (!configuredEndpoint || configuredEndpoint.id !== config.endpointId) return fail(CODES.unapproved)
  // Snapshot the deployed target before hashing so mutation cannot change the
  // URL or binding between the fingerprint check and the request.
  const endpoint = { ...configuredEndpoint }
  if (await endpointFingerprint(endpoint) !== config.registryFingerprint) return fail(CODES.stale)
  let result: Omit<HttpMonitorResult, 'attempts'> = fail(CODES.network)
  for (let attempts = 1; attempts <= (config.attempts ?? 1); attempts++) {
    result = await oneAttempt(config, endpoint, env)
    if (result.status !== 'down' || attempts === (config.attempts ?? 1)) return { ...result, attempts }
  }
  return { ...result, attempts: config.attempts ?? 1 }
}
