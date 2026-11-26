import { emailDestinations, validEmailAddress } from './email-channel'
import { boundedBody } from './idempotency'

export interface SubscriberEnv {
  DB: D1Database
  PREVIEW_SUBSCRIBER_SCOPE?: string
  PREVIEW_SUBSCRIBER_REQUIRED?: string
  PREVIEW_SLOT?: string
  PREVIEW_TARGET?: string
  PREVIEW_RELEASE?: string
  SUBSCRIBER_EMAIL_READY?: string
  SUBSCRIBER_EMAIL_FROM?: string
  SUBSCRIBER_EMAIL_DESTINATIONS?: string
  SUBSCRIBER_EMAIL?: SendEmail
  SUBSCRIBER_PUBLIC_URL?: string
}
type User = { id: string; email: string; role: string }
type Settings = { enabled: number; allow_email: number; allowed_events: string; allow_component_scope: number; updated_at: number }
type Subscriber = { id: number; user_id: string; email: string; status: string; events: string; monitor_ids: string; created_at: number; confirmed_at: number | null; last_notified_at: number | null; last_error: string | null }
type Body = Record<string, unknown>
const eventTypes = ['incident.created', 'incident.updated', 'incident.resolved', 'maintenance.scheduled']

export class SubscriberError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
const fail = (status: number, message: string): never => { throw new SubscriberError(status, message) }
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })
const query = (env: SubscriberEnv, sql: string, ...values: unknown[]) => env.DB.prepare(sql).bind(...values)
/** Only trusted Worker configuration chooses a namespace; invalid preview config fails closed. */
export function subscriberScope(env: Pick<SubscriberEnv, 'PREVIEW_SUBSCRIBER_SCOPE' | 'PREVIEW_SUBSCRIBER_REQUIRED'>): string | null {
  const scope = env.PREVIEW_SUBSCRIBER_SCOPE
  if (scope === undefined && env.PREVIEW_SUBSCRIBER_REQUIRED !== 'true') return null
  if (scope === undefined) throw new Error('Missing preview subscriber scope')
  if (!/^[0-9a-f]{64}$/.test(scope)) throw new Error('Invalid preview subscriber scope')
  return scope
}
function subscriberTable(scope: string | null): string { return scope ? 'preview_subscribers' : 'subscribers' }
function publicUrl(env: SubscriberEnv): string {
  try {
    const url = new URL(env.SUBSCRIBER_PUBLIC_URL ?? '')
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return ''
    return url.origin
  } catch { return '' }
}
export function subscriberEmailReady(env: SubscriberEnv): boolean {
  return env.SUBSCRIBER_EMAIL_READY === 'true' && validEmailAddress(env.SUBSCRIBER_EMAIL_FROM) && emailDestinations(env.SUBSCRIBER_EMAIL_DESTINATIONS).size > 0 && !!publicUrl(env) && !!env.SUBSCRIBER_EMAIL && typeof env.SUBSCRIBER_EMAIL.send === 'function'
}
export function subscriberAddressApproved(env: SubscriberEnv, address: string): boolean {
  return [...emailDestinations(env.SUBSCRIBER_EMAIL_DESTINATIONS).values()].some(item => item.address.toLowerCase() === address.toLowerCase())
}
async function body(request: Request): Promise<Body> {
  let parsed: unknown
  try { parsed = JSON.parse(await boundedBody(request)) } catch { return fail(400, 'Invalid request') }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return fail(400, 'Invalid request')
  return parsed as Body
}
async function settings(env: SubscriberEnv): Promise<Settings> {
  const scope = subscriberScope(env)
  const row = scope
    ? await query(env, 'SELECT * FROM preview_subscription_settings WHERE scope=?', scope).first<Settings>()
    : await query(env, 'SELECT * FROM subscription_settings WHERE id=1').first<Settings>()
  if (scope && !row) return { enabled: 0, allow_email: 0, allowed_events: JSON.stringify(eventTypes), allow_component_scope: 1, updated_at: 0 }
  if (!row) throw new Error('Missing subscription settings')
  return row
}
function settingsView(env: SubscriberEnv, row: Settings) {
  const enabled = !!row.enabled, allowEmail = !!row.allow_email
  const allowedEvents = JSON.parse(row.allowed_events) as string[]
  const ready = subscriberEmailReady(env)
  const problems = [...(!enabled ? ['disabled'] : []), ...(!ready ? ['smtp'] : []), ...(!publicUrl(env) ? ['publicUrl'] : []), ...(!allowedEvents.length ? ['events'] : [])]
  const disabled = { enabled: false, available: false, problems: [] }
  return { enabled, allowEmail, allowWebhook: false, allowSlack: false, rssEnabled: false, apiEnabled: false,
    allowedEvents, allowComponentScope: !!row.allow_component_scope, updatedAt: row.updated_at, smtpConfigured: ready, publicUrl: publicUrl(env), statusPagePrivate: true,
    methods: { email: { enabled: allowEmail, available: allowEmail && problems.length === 0, problems: allowEmail ? problems : [] }, webhook: disabled, slack: disabled, rss: disabled, api: disabled } }
}
async function components(env: SubscriberEnv) {
  return (await query(env, "SELECT a.alias AS id,c.id AS uuid,c.name FROM components c JOIN entity_aliases a ON a.entity_id=c.id AND a.entity_type='component' ORDER BY c.position,c.id").all<{id:number;uuid:string;name:string}>()).results
}
async function validateScope(env: SubscriberEnv, input: Body, row: Settings): Promise<{events:string[]; ids:string[]}> {
  if (!Array.isArray(input.events) || !input.events.length || input.events.some(e => typeof e !== 'string' || !eventTypes.includes(e) || !(JSON.parse(row.allowed_events) as string[]).includes(e))) return fail(400, 'Invalid events')
  if (!Array.isArray(input.monitorIds) || input.monitorIds.length > 100 || (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.length))) return fail(400, 'Invalid component scope')
  if (!row.allow_component_scope && input.monitorIds.length) return fail(400, 'Component scope unavailable')
  const available = await components(env)
  const ids = input.monitorIds.map(id => available.find(item => item.id === id)?.uuid)
  if (ids.some(id => !id)) return fail(400, 'Unknown component')
  return { events: [...new Set(input.events as string[])], ids: [...new Set(ids as string[])] }
}
async function subscriberView(env: SubscriberEnv, row: Subscriber, masked = false) {
  const aliases = await components(env)
  const monitorIds = (JSON.parse(row.monitor_ids) as string[]).map(id => aliases.find(item => item.uuid === id)?.id).filter((id): id is number => id !== undefined)
  const email = masked ? row.email.replace(/^(.).*(@.*)$/, '$1***$2') : row.email
  return { id: row.id, type: 'email', email, webhookUrl: null, webhookMethod: null, webhookHeaderNames: [], notifyOnFailure: false, status: row.status, events: JSON.parse(row.events), monitorIds, tags: [], createdAt: row.created_at, confirmedAt: row.confirmed_at, unsubscribedAt: null, lastNotifiedAt: row.last_notified_at, lastError: row.last_error, consecutiveFailures: 0, disabledAt: null }
}
async function tokenHash(token: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(hash)].map(n => n.toString(16).padStart(2, '0')).join('')
}
function pagination(input: Body) {
  const page = input.page === undefined ? 1 : Number(input.page)
  const limit = input.limit === undefined ? 25 : Number(input.limit)
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return fail(400, 'Invalid pagination')
  return { page, limit }
}
function filters(input: Body) {
  const status = input.status === undefined || input.status === '' ? null : input.status
  const search = input.search === undefined ? '' : input.search
  if (status !== null && !['active','pending','unsubscribed','disabled'].includes(String(status))) return fail(400, 'Invalid status')
  if (typeof search !== 'string' || search.length > 254) return fail(400, 'Invalid search')
  return { status, search: `%${search.replace(/[\\%_]/g, '\\$&')}%` }
}
function csvCell(value: unknown): string {
  let result = String(value ?? '')
  if (/^[\s]*[=+@\-\t\r]/.test(result)) result = `'${result}`
  return `"${result.replace(/"/g, '""')}"`
}

export async function subscriberApi(request: Request, env: SubscriberEnv, user: User, route: string): Promise<Response> {
  const method = request.method
  const isAdmin = route.startsWith('/admin/subscribers')
  if (isAdmin && user.role !== 'operator' && user.role !== 'admin') return fail(403, 'Insufficient role')
  const current = await settings(env)
  const scope = subscriberScope(env)
  const table = subscriberTable(scope)
  const inScope = scope ? 'scope=? AND ' : ''
  const scoped = (...values: unknown[]) => scope ? [scope, ...values] : values
  if (route === '/public/subscriptions/options' && method === 'GET') {
    const config = settingsView(env, current)
    const visible = await components(env)
    return json({ methods: config.methods.email.available && subscriberAddressApproved(env, user.email) ? ['email'] : [], events: config.allowedEvents, allowComponentScope: config.allowComponentScope, components: visible.map(({id,name}) => ({id,name})), tags: [], baseUrl: config.publicUrl || null })
  }
  if (route === '/admin/subscribers/settings' && method === 'GET') return json(settingsView(env, current))
  if (route === '/admin/subscribers/settings' && method === 'PUT') {
    const input = await body(request)
    if (typeof input.enabled !== 'boolean' || typeof input.allowEmail !== 'boolean' || typeof input.allowComponentScope !== 'boolean' || !Array.isArray(input.allowedEvents) || input.allowedEvents.some(event => typeof event !== 'string' || !eventTypes.includes(event)) || input.allowWebhook || input.allowSlack || input.rssEnabled || input.apiEnabled) return fail(400, 'Invalid settings')
    await env.DB.batch([
      scope
        ? query(env, 'INSERT INTO preview_subscription_settings (scope,enabled,allow_email,allow_component_scope,allowed_events,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET enabled=excluded.enabled,allow_email=excluded.allow_email,allow_component_scope=excluded.allow_component_scope,allowed_events=excluded.allowed_events,updated_at=excluded.updated_at', scope, Number(input.enabled), Number(input.allowEmail), Number(input.allowComponentScope), JSON.stringify([...new Set(input.allowedEvents)]), Date.now())
        : query(env, 'UPDATE subscription_settings SET enabled=?,allow_email=?,allow_component_scope=?,allowed_events=?,updated_at=? WHERE id=1', Number(input.enabled), Number(input.allowEmail), Number(input.allowComponentScope), JSON.stringify([...new Set(input.allowedEvents)]), Date.now()),
      scope
        ? query(env, 'INSERT INTO preview_audit_events (id,actor_email,action,entity_type,entity_id,created_at,details,preview_scope) VALUES (?,?,?,?,?,?,?,?)', crypto.randomUUID(), user.email, 'update', 'subscription_settings', '1', Date.now(), '{}', scope)
        : query(env, 'INSERT INTO audit_events (id,actor_email,action,entity_type,entity_id,created_at,details) VALUES (?,?,?,?,?,?,?)', crypto.randomUUID(), user.email, 'update', 'subscription_settings', '1', Date.now(), '{}'),
    ])
    return json(settingsView(env, await settings(env)))
  }
  if (route === '/public/subscriptions' && method === 'POST') {
    const input = await body(request)
    if (!current.enabled || !current.allow_email || !subscriberEmailReady(env)) return fail(503, 'Subscriptions unavailable')
    if (input.type !== 'email' || typeof input.email !== 'string' || input.email.toLowerCase() !== user.email.toLowerCase() || !subscriberAddressApproved(env, user.email) || input.website) return fail(400, 'Invalid subscription')
    const selection = await validateScope(env, input, current)
    const now = Date.now()
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    const token = [...bytes].map(n => n.toString(16).padStart(2, '0')).join('')
    const hash = await tokenHash(token)
    const saved = await query(env, `INSERT INTO ${table} (${scope ? 'scope,' : ''}user_id,email,status,events,monitor_ids,created_at,updated_at,confirmation_hash,confirmation_expires_at,confirmation_sent_at)
      VALUES (${scope ? '?,' : ''}?,?,'pending',?,?,?,?,?,?,?)
      ON CONFLICT(${scope ? 'scope,' : ''}user_id) DO UPDATE SET email=excluded.email,status='pending',events=excluded.events,monitor_ids=excluded.monitor_ids,updated_at=excluded.updated_at,confirmation_hash=excluded.confirmation_hash,confirmation_expires_at=excluded.confirmation_expires_at,confirmation_sent_at=excluded.confirmation_sent_at
      WHERE ${table}.status <> 'active' AND (${table}.confirmation_sent_at IS NULL OR ${table}.confirmation_sent_at < ?)`, ...scoped(user.id, user.email, JSON.stringify(selection.events), JSON.stringify(selection.ids), now, now, hash, now + 48 * 3600000, now, now - 600000)).run()
    if (!saved.meta.changes) return fail(429, 'A subscription is active or confirmation was recently requested. Try again in 10 minutes.')
    const link = `${publicUrl(env)}/#subscription=confirm&token=${token}`
    try {
      await env.SUBSCRIBER_EMAIL!.send({ from: env.SUBSCRIBER_EMAIL_FROM!, to: user.email, subject: 'Confirm your status subscription', text: `Confirm your subscription: ${link}` })
    } catch { return fail(503, 'Confirmation could not be sent. Try again in 10 minutes.') }
    return json({ ok: true }, 202)
  }
  if (route === '/public/subscriptions/confirm' && method === 'POST') {
    const input = await body(request)
    if (!subscriberAddressApproved(env, user.email)) return fail(404, 'Invalid confirmation link')
    if (typeof input.token !== 'string' || !/^[0-9a-f]{64}$/.test(input.token)) return fail(404, 'Invalid confirmation link')
    const hash = await tokenHash(input.token)
    const now = Date.now()
    const result = await query(env, `UPDATE ${table} SET status='active',confirmed_at=?,updated_at=?,confirmation_hash=NULL,confirmation_expires_at=NULL WHERE ${inScope}user_id=? AND lower(email)=lower(?) AND status='pending' AND confirmation_hash=? AND confirmation_expires_at>?`, now, now, ...scoped(user.id, user.email, hash, now)).run()
    if (!result.meta.changes) return fail(404, 'Invalid confirmation link')
    return json({ ok: true })
  }
  if ((route === '/public/subscriptions/preferences' && (method === 'POST' || method === 'PUT')) || (route === '/public/subscriptions/unsubscribe' && method === 'POST')) {
    const input = await body(request)
    const existing = await query(env, `SELECT * FROM ${table} WHERE ${inScope}user_id=? AND lower(email)=lower(?)`, ...scoped(user.id, user.email)).first<Subscriber>()
    if (!existing) return fail(404, 'Subscription not found')
    if (route.endsWith('/unsubscribe')) {
      await query(env, `UPDATE ${table} SET status='unsubscribed',confirmation_hash=NULL,confirmation_expires_at=NULL,updated_at=? WHERE ${inScope}user_id=?`, Date.now(), ...scoped(user.id)).run()
      return json({ ok: true })
    }
    if (method === 'PUT') {
      if (input.resubscribe) return fail(400, 'Confirm a new subscription to resubscribe')
      const selection = await validateScope(env, input, current)
      await query(env, `UPDATE ${table} SET events=?,monitor_ids=?,updated_at=? WHERE ${inScope}user_id=?`, JSON.stringify(selection.events), JSON.stringify(selection.ids), Date.now(), ...scoped(user.id)).run()
      return json(await subscriberView(env, { ...existing, events: JSON.stringify(selection.events), monitor_ids: JSON.stringify(selection.ids) }, true))
    }
    return json(await subscriberView(env, existing, true))
  }
  if (route === '/admin/subscribers/search' && method === 'POST') {
    const input = await body(request)
    const { page, limit } = pagination(input)
    const { status, search } = filters(input)
    const conditions = "(? IS NULL OR status=?) AND email LIKE ? ESCAPE '\\'"
    const records = await query(env, `SELECT * FROM ${table} WHERE ${inScope}${conditions} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`, ...scoped(status, status, search, limit, (page - 1) * limit)).all<Subscriber>()
    const count = await query(env, `SELECT count(*) AS total FROM ${table} WHERE ${inScope}${conditions}`, ...scoped(status, status, search)).first<{total:number}>()
    const counts = await query(env, `SELECT status,count(*) AS count FROM ${table} ${scope ? 'WHERE scope=?' : ''} GROUP BY status`, ...scoped()).all<{status:string;count:number}>()
    const stats = { total: 0, active: 0, pending: 0, unsubscribed: 0, disabled: 0 }
    for (const item of counts.results) { stats.total += item.count; if (item.status in stats && item.status !== 'total') stats[item.status as 'active' | 'pending' | 'unsubscribed'] = item.count }
    const total = count?.total ?? 0
    return json({ subscribers: await Promise.all(records.results.map(row => subscriberView(env, row))), stats, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) })
  }
  if (route === '/admin/subscribers/export' && method === 'POST') {
    const input = await body(request)
    const { status, search } = filters(input)
    if (input.ids !== undefined && (!Array.isArray(input.ids) || input.ids.length > 100 || input.ids.some(id => !Number.isSafeInteger(id) || id < 1))) return fail(400, 'Invalid selection')
    const ids = input.ids === undefined ? null : JSON.stringify(input.ids)
    const rows = await query(env, `SELECT * FROM ${table} WHERE ${inScope}((? IS NOT NULL AND id IN (SELECT value FROM json_each(?))) OR (? IS NULL AND (? IS NULL OR status=?) AND email LIKE ? ESCAPE '\\')) ORDER BY id LIMIT 10001`, ...scoped(ids, ids, ids, status, status, search)).all<Subscriber>()
    if (rows.results.length > 10000) return fail(413, 'Export exceeds the supported size. Narrow the filter.')
    const views = await Promise.all(rows.results.map(row => subscriberView(env, row)))
    const lines = [['id','type','destination','status','events','monitors','last_notified_at','last_error'].map(csvCell).join(','), ...views.map(row => [row.id, row.type, row.email, row.status, row.events.join(','), row.monitorIds.join(','), row.lastNotifiedAt, row.lastError].map(csvCell).join(','))]
    return new Response(lines.join('\r\n'), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="subscribers.csv"', 'Cache-Control': 'no-store' } })
  }
  const deletion = /^\/admin\/subscribers\/(\d+)$/.exec(route)
  if (deletion && method === 'DELETE') {
    const record = await query(env, `SELECT id FROM ${table} WHERE ${inScope}id=?`, ...scoped(Number(deletion[1]))).first<{id:number}>()
    if (!record) return fail(404, 'Subscriber not found')
    await env.DB.batch([
      query(env, `DELETE FROM ${table} WHERE ${inScope}id=?`, ...scoped(record.id)),
      scope
        ? query(env, 'INSERT INTO preview_audit_events (id,actor_email,action,entity_type,entity_id,created_at,details,preview_scope) VALUES (?,?,?,?,?,?,?,?)', crypto.randomUUID(), user.email, 'delete', 'subscriber', String(record.id), Date.now(), '{}', scope)
        : query(env, 'INSERT INTO audit_events (id,actor_email,action,entity_type,entity_id,created_at,details) VALUES (?,?,?,?,?,?,?)', crypto.randomUUID(), user.email, 'delete', 'subscriber', String(record.id), Date.now(), '{}'),
    ])
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
  }
  return fail(404, 'Not found')
}
