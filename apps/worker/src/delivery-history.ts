import { channelEndpoints } from './channels-runtime'
import { endpointFingerprint } from './endpoint-config'
import { vaultKeyReady } from './vault'

type HistoryEnvironment = { DB: D1Database; CHANNELS_READY?: string; CHANNEL_ENDPOINTS?: string; VAULT_ENCRYPTION_KEY?: string }
type Actor = { id: string; email: string; version: number }
type HistoryRow = { id: string; state: string; errorCode?: string | null; canRetry?: number | boolean; [key: string]: unknown }
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })

export async function deliveryHistoryAvailable(db: D1Database): Promise<boolean> {
  const result = await db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('notification_attempts','notification_test_deliveries')").first<{count:number}>()
  return result?.count === 2
}

const notificationRows = `
  SELECT o.id, o.created_at AS createdAt, o.updated_at AS updatedAt, m.name AS monitorName,
    o.status AS monitorStatus, CASE WHEN o.state='failed' AND o.error_code GLOB 'retry_queued:*' THEN 'pending' ELSE o.state END AS state, o.channel_id AS channelId, c.name AS channelName,
    c.channel_type AS channelType, CASE WHEN o.status='up' THEN 'recovery' ELSE 'alert' END AS event,
    o.attempts AS attemptCount, CASE WHEN o.error_code IN ('unavailable','delivery_failed') THEN o.error_code ELSE NULL END AS errorCode,
    CASE WHEN o.state='failed' AND o.attempts=3 AND o.manual_retry=0 AND o.error_code='delivery_failed'
      AND o.created_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)-3600000
      AND c.channel_type='webhook' AND c.enabled=1 AND c.version=o.channel_version
      AND h.enabled=1 AND h.config_version=o.check_version
      AND EXISTS (SELECT 1 FROM notification_channel_checks cc WHERE cc.channel_id=c.id AND cc.check_id=h.id)
      AND EXISTS (SELECT 1 FROM notification_transition_state ns WHERE ns.check_id=h.id AND ns.check_version=h.config_version AND ns.generation=o.transition_generation)
      AND EXISTS (SELECT 1 FROM vault_secrets v WHERE v.id=c.secret_id AND v.vault_id=c.vault_id AND v.type='value')
      THEN 1 ELSE 0 END AS canRetry
  FROM notification_outbox o JOIN notification_channels c ON c.id=o.channel_id
  JOIN http_checks h ON h.id=o.check_id JOIN components m ON m.id=h.component_id
  UNION ALL
  SELECT t.id, t.created_at, t.created_at, NULL, NULL,
    CASE WHEN t.result='sent' THEN 'sent' ELSE 'failed' END, t.channel_id, c.name,
    c.channel_type, 'test', 1, CASE WHEN t.result='sent' THEN NULL ELSE t.result END, 0
  FROM notification_test_deliveries t JOIN notification_channels c ON c.id=t.channel_id`
const actionRows = `SELECT o.id, o.created_at AS createdAt, o.updated_at AS updatedAt, m.name AS monitorName,
  o.status AS monitorStatus, o.state, o.action_id AS actionId, a.name AS actionName
  FROM worker_action_outbox o JOIN worker_actions a ON a.id=o.action_id
  JOIN http_checks h ON h.id=o.check_id JOIN components m ON m.id=h.component_id`

async function cleanRow(row: HistoryRow, env: HistoryEnvironment): Promise<HistoryRow> {
  if ('errorCode' in row && row.errorCode !== 'delivery_failed' && row.errorCode !== 'unavailable') row.errorCode = null
  if ('canRetry' in row) {
    row.canRetry = Boolean(row.canRetry) && env.CHANNELS_READY === 'true' && await vaultKeyReady(env.DB, env.VAULT_ENCRYPTION_KEY)
    if (row.canRetry) {
      const channel = await env.DB.prepare('SELECT endpoint_id AS endpointId,endpoint_fingerprint AS fingerprint FROM notification_channels WHERE id=?').bind(row.channelId).first<{endpointId:string;fingerprint:string}>()
      const endpoint = channel && channelEndpoints(env.CHANNEL_ENDPOINTS).get(channel.endpointId)
      row.canRetry = Boolean(endpoint && await endpointFingerprint(endpoint) === channel?.fingerprint)
    }
  }
  return row
}

export async function deliveryHistoryApi(request: Request, env: HistoryEnvironment, actor: Actor, route: string): Promise<Response> {
  const match = /^\/admin\/delivery-history\/(notifications|actions)(?:\/([^/]+))?(?:\/(retry))?$/.exec(route)
  if (!match) return json({ error: 'Not found' }, 404)
  const [, kind, rawId, retry] = match
  let id: string | undefined
  try { id = rawId ? decodeURIComponent(rawId) : undefined } catch { return json({ error: 'Invalid ID' }, 400) }
  if (id && id.length > 160) return json({ error: 'Invalid ID' }, 400)
  const db = env.DB
  const source = kind === 'notifications' ? notificationRows : actionRows
  if (id && retry && kind === 'notifications' && request.method === 'POST') return retryNotification(db, env, actor, id)
  if (retry || request.method !== 'GET') return json({ error: 'Not found' }, 404)
  if (id) {
    const row = await db.prepare(`SELECT * FROM (${source}) WHERE id=?`).bind(id).first<HistoryRow>()
    if (!row) return json({ error: 'Not found' }, 404)
    const attempts = kind === 'notifications' ? (await db.prepare("SELECT attempt_number AS attemptNumber,completed_at AS completedAt,CASE WHEN result IN ('sent','delivery_failed','unavailable') THEN result ELSE 'unavailable' END AS result FROM notification_attempts WHERE delivery_id=? ORDER BY attempt_number").bind(id).all()).results : []
    if (row.event === 'test') attempts.push({attemptNumber:1, completedAt:row.createdAt, result:row.errorCode ?? 'sent'})
    return json({ ...await cleanRow(row, env), attempts })
  }
  const params = new URL(request.url).searchParams
  const page = Number(params.get('page') ?? '1'), limit = Number(params.get('limit') ?? '20')
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return json({ error: 'Invalid pagination' }, 400)
  const fields = kind === 'notifications' ? ['state', 'channelId', 'event'] : ['state', 'actionId']
  const clauses: string[] = [], values: string[] = []
  for (const field of fields) {
    const value = params.get(field === 'state' ? 'status' : field)
    if (value) {
      if (value.length > 160) return json({ error: 'Invalid filter' }, 400)
      clauses.push(`${field}=?`)
      values.push(value)
    }
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
  const count = await db.prepare(`SELECT COUNT(*) AS count FROM (${source})${where}`).bind(...values).first<{count:number}>()
  const total = count?.count ?? 0
  const rows = await db.prepare(`SELECT * FROM (${source})${where} ORDER BY createdAt DESC,id DESC LIMIT ? OFFSET ?`).bind(...values,limit,(page-1)*limit).all<HistoryRow>()
  const filters = kind === 'notifications'
    ? (await db.prepare('SELECT id,name FROM notification_channels ORDER BY name,id').all()).results
    : (await db.prepare('SELECT id,name FROM worker_actions ORDER BY name,id').all()).results
  return json({ items: await Promise.all(rows.results.map(row => cleanRow(row, env))), total, page, pages: Math.max(1, Math.ceil(total / limit)), filters })
}

async function retryNotification(db: D1Database, env: HistoryEnvironment, actor: Actor, id: string): Promise<Response> {
  if (env.CHANNELS_READY !== 'true' || !await vaultKeyReady(db, env.VAULT_ENCRYPTION_KEY)) return json({error:'Notification delivery is unavailable'}, 503)
  const channel = await db.prepare(`SELECT c.endpoint_id AS endpointId,c.endpoint_fingerprint AS fingerprint FROM notification_outbox o
    JOIN notification_channels c ON c.id=o.channel_id WHERE o.id=? AND c.channel_type='webhook'`).bind(id).first<{endpointId:string;fingerprint:string}>()
  const endpoint = channel && channelEndpoints(env.CHANNEL_ENDPOINTS).get(channel.endpointId)
  if (!endpoint || await endpointFingerprint(endpoint) !== channel?.fingerprint) return json({error:'Delivery is no longer eligible for retry'}, 409)
  const now = Date.now()
  const eligibility = `id=? AND state='failed' AND attempts=3 AND manual_retry=0 AND error_code='delivery_failed' AND created_at>?
    AND EXISTS (SELECT 1 FROM users u WHERE u.id=? AND u.role='admin' AND u.version=? AND u.email=?)
    AND EXISTS (SELECT 1 FROM notification_channels c JOIN http_checks h ON h.id=notification_outbox.check_id
      JOIN notification_channel_checks cc ON cc.channel_id=c.id AND cc.check_id=h.id
      JOIN notification_transition_state ns ON ns.check_id=h.id AND ns.check_version=h.config_version
      JOIN vault_secrets v ON v.id=c.secret_id AND v.vault_id=c.vault_id AND v.type='value'
      WHERE c.id=notification_outbox.channel_id AND c.enabled=1 AND c.channel_type='webhook' AND c.version=notification_outbox.channel_version
      AND c.endpoint_id=? AND c.endpoint_fingerprint=? AND h.enabled=1 AND h.config_version=notification_outbox.check_version
      AND ns.generation=notification_outbox.transition_generation)`
  const args = [id,now-3_600_000,actor.id,actor.version,actor.email,channel.endpointId,channel.fingerprint]
  const result = await db.batch([
    db.prepare(`INSERT INTO audit_events (id,actor_email,action,entity_type,entity_id,created_at,details)
      SELECT ?,?,'retry','notification_delivery',?,?, '{}' WHERE EXISTS (SELECT 1 FROM notification_outbox WHERE ${eligibility})`)
      .bind(crypto.randomUUID(),actor.email,id,now,...args),
    // Keep the queued retry invisible to older probe versions until a compatible
    // probe claims it. Legacy probes treat pending rows with three attempts as failed.
    db.prepare(`UPDATE notification_outbox SET manual_retry=1,error_code='retry_queued:' || (SELECT association_version FROM notification_channels WHERE id=notification_outbox.channel_id),updated_at=? WHERE ${eligibility}`).bind(now,...args),
  ])
  if (!result[1]?.meta.changes) return json({error:'Delivery is no longer eligible for retry'},409)
  return json({ok:true})
}
