import { endpointFingerprint, parseEndpoints, type Endpoint } from './endpoint-config'
import { resolveChannelCredential } from './vault-resolver'

/** Only the in-process scheduler and the authenticated channel-test route call this module. */
export type ChannelEnvironment = { DB: D1Database; CHANNEL_ENDPOINTS?: string; CHANNELS_READY?: string; VAULT_ENCRYPTION_KEY?: string; [key: string]: unknown }
type Channel = { id: string; endpoint_id: string; endpoint_fingerprint: string; enabled: number; version: number }
type Job = { id: string; channel_id: string; channel_version: number; check_id: string; check_version: number; scheduled_at: number; status: 'up' | 'degraded' | 'down'; attempts: number }
export type ChannelResult = 'sent' | 'unavailable' | 'delivery_failed'

export function channelEndpoints(value: string | undefined): Map<string, Endpoint> {
  try { return new Map([...parseEndpoints(value ?? '[]')].filter(([, endpoint]) => new URL(endpoint.url).protocol === 'https:')) } catch { return new Map() }
}

/** Enqueue a status change atomically with the accepted check result; contains no credential or URL. */
export function enqueueTransition(db: D1Database, checkId: string, version: number, fingerprint: string, scheduledAt: number, status: 'up' | 'degraded' | 'down'): D1PreparedStatement {
  const now = Date.now()
  return db.prepare(`INSERT OR IGNORE INTO notification_outbox (id,channel_id,channel_version,check_id,check_version,scheduled_at,status,created_at,updated_at)
    SELECT ? || ':' || c.id,c.id,c.version,h.id,h.config_version,?,?,?,? FROM notification_channels c
    JOIN notification_channel_checks cc ON cc.channel_id=c.id JOIN http_checks h ON h.id=cc.check_id
    WHERE c.enabled=1 AND h.id=? AND h.enabled=1 AND h.transition_suppressed=0 AND h.config_version=? AND (CASE WHEN h.last_effective_scheduled_at=h.last_scheduled_at THEN COALESCE(h.last_effective_status,h.last_status) ELSE h.last_status END) IS NOT NULL AND (CASE WHEN h.last_effective_scheduled_at=h.last_scheduled_at THEN COALESCE(h.last_effective_status,h.last_status) ELSE h.last_status END)<>?
      AND (h.last_scheduled_at IS NULL OR h.last_scheduled_at<?)
      AND EXISTS (SELECT 1 FROM endpoint_registry WHERE endpoint_id=h.endpoint_id AND fingerprint=?)
      AND EXISTS (SELECT 1 FROM http_check_results WHERE check_id=h.id AND config_version=h.config_version AND scheduled_at=? AND COALESCE(effective_status,status)=?)`)
    .bind(crypto.randomUUID(),scheduledAt,status,now,now,checkId,version,status,scheduledAt,fingerprint,scheduledAt,status)
}

/** Credentials are resolved only from the persisted channel and its exact version. */
export async function sendChannel(env: ChannelEnvironment, channelId: string, version: number, event: { checkId?: string; checkVersion?: number; status?: 'up' | 'degraded' | 'down'; scheduledAt?: number }, requireEnabled: boolean): Promise<ChannelResult> {
  try {
    if (env.CHANNELS_READY !== 'true') return 'unavailable'
    const channel = await env.DB.prepare('SELECT id,endpoint_id,endpoint_fingerprint,enabled,version FROM notification_channels WHERE id=? AND version=?')
      .bind(channelId,version).first<Channel>()
    if (!channel || (requireEnabled && channel.enabled !== 1)) return 'unavailable'
    if (event.checkId && (!Number.isSafeInteger(event.checkVersion) || !await env.DB.prepare('SELECT 1 AS present FROM notification_channel_checks cc JOIN http_checks h ON h.id=cc.check_id WHERE cc.channel_id=? AND cc.check_id=? AND h.enabled=1 AND h.config_version=?').bind(channelId,event.checkId,event.checkVersion).first())) return 'unavailable'
    const endpoint = channelEndpoints(env.CHANNEL_ENDPOINTS).get(channel.endpoint_id)
    if (!endpoint || await endpointFingerprint(endpoint) !== channel.endpoint_fingerprint) return 'unavailable'
    const token = await resolveChannelCredential(env.DB,env.VAULT_ENCRYPTION_KEY,channel.id,channel.version)
    if (!token || token.length>4096 || !/^[A-Za-z0-9._~+/-]+=*$/.test(token)) return 'unavailable'
    const active = await env.DB.prepare(`SELECT 1 AS present FROM notification_channels WHERE id=? AND version=?${requireEnabled ? ' AND enabled=1' : ''}`)
      .bind(channelId,version).first()
    if (!active || (event.checkId && !await env.DB.prepare('SELECT 1 AS present FROM notification_channel_checks cc JOIN http_checks h ON h.id=cc.check_id WHERE cc.channel_id=? AND cc.check_id=? AND h.enabled=1 AND h.config_version=?').bind(channelId,event.checkId,event.checkVersion).first())) return 'unavailable'
    const init: RequestInit = { method:'POST', redirect:'manual', signal:AbortSignal.timeout(5000), headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${token}`}, body:JSON.stringify({event: event.checkId ? 'monitor_status' : 'test', ...(event.checkId ? {checkId:event.checkId,status:event.status,scheduledAt:event.scheduledAt} : {})}) }
    let response: Response
    if (endpoint.binding) {
      const binding = env[endpoint.binding]
      if (!binding || typeof binding !== 'object' || !('fetch' in binding) || typeof binding.fetch !== 'function') return 'unavailable'
      response = await binding.fetch(endpoint.url,init) as Response
    } else response = await fetch(endpoint.url,init)
    const success = response.status >= 200 && response.status < 300
    void response.body?.cancel().catch(() => {})
    return success ? 'sent' : 'delivery_failed'
  } catch { return 'delivery_failed' }
}

/** Bounded leases and retries; duplicate delivery is possible if a worker stops after the receiver accepts. */
export async function flushChannelDeliveries(env: ChannelEnvironment): Promise<void> {
  if (env.CHANNELS_READY !== 'true' || !env.CHANNEL_ENDPOINTS) return
  const now = Date.now()
  let jobs: Job[]
  try {
    await env.DB.prepare("UPDATE notification_outbox SET state='failed',error_code='delivery_failed',lease_token=NULL,lease_until=NULL,updated_at=? WHERE (state='pending' OR (state='sending' AND lease_until<?)) AND (created_at<? OR attempts>=3)").bind(now,now,now - 3_600_000).run()
    await env.DB.prepare("DELETE FROM notification_outbox WHERE id IN (SELECT id FROM notification_outbox WHERE state IN ('sent','failed') AND updated_at<? LIMIT 500)").bind(now - 86_400_000).run()
    jobs = (await env.DB.prepare(`SELECT id,channel_id,channel_version,check_id,check_version,scheduled_at,status,attempts FROM notification_outbox
      WHERE attempts<3 AND (state='pending' OR (state='sending' AND lease_until<?)) ORDER BY created_at LIMIT 20`).bind(now).all<Job>()).results
  } catch { return }
  for (const job of jobs) {
    const lease = crypto.randomUUID(), claimedAt = Date.now()
    const claim = await env.DB.prepare(`UPDATE notification_outbox SET state='sending',lease_token=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=? AND attempts<3 AND (state='pending' OR (state='sending' AND lease_until<?))`)
      .bind(lease,claimedAt+15_000,claimedAt,job.id,claimedAt).run()
    if (!claim.meta.changes) continue
    const result = await sendChannel(env,job.channel_id,job.channel_version,{checkId:job.check_id,checkVersion:job.check_version,status:job.status,scheduledAt:job.scheduled_at},true)
    const state = result === 'sent' ? 'sent' : result === 'unavailable' || job.attempts + 1 >= 3 ? 'failed' : 'pending'
    await env.DB.prepare('UPDATE notification_outbox SET state=?,error_code=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=?')
      .bind(state,result === 'sent' ? null : result,Date.now(),job.id,lease).run()
  }
}
