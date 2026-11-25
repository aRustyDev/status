import { maintenanceBarrier, nextMaintenanceStart, outsideMaintenance, overlappedMaintenance } from './automation-maintenance'
import { endpointFingerprint, parseEndpoints, type Endpoint } from './endpoint-config'
import { resolveChannelCredentialSnapshot } from './vault-resolver'

/** Only the in-process scheduler and the authenticated channel-test route call this module. */
export type ChannelEnvironment = { DB: D1Database; CHANNEL_ENDPOINTS?: string; CHANNELS_READY?: string; VAULT_ENCRYPTION_KEY?: string; [key: string]: unknown }
type Channel = { id: string; endpoint_id: string; endpoint_fingerprint: string; enabled: number; version: number }
type Job = { id: string; channel_id: string; channel_version: number; check_id: string; check_version: number; scheduled_at: number; status: 'up' | 'degraded' | 'down'; attempts: number; transition_generation: number }
export type ChannelResult = 'sent' | 'unavailable' | 'delivery_failed' | 'deferred'

export function channelEndpoints(value: string | undefined): Map<string, Endpoint> {
  try { return new Map([...parseEndpoints(value ?? '[]')].filter(([, endpoint]) => new URL(endpoint.url).protocol === 'https:')) } catch { return new Map() }
}

/** Enqueue a status change atomically with the accepted check result; contains no credential or URL. */
export function enqueueTransition(db: D1Database, checkId: string, version: number, fingerprint: string, scheduledAt: number, status: 'up' | 'degraded' | 'down', observedAt = scheduledAt): D1PreparedStatement {
  const now = Date.now()
  return db.prepare(`INSERT OR IGNORE INTO notification_outbox (id,channel_id,channel_version,check_id,check_version,scheduled_at,status,created_at,updated_at,transition_generation,observed_at)
    SELECT ? || ':' || c.id,c.id,c.version,h.id,h.config_version,?,?,?,?,COALESCE(ns.generation,0) + CASE WHEN ns.check_id IS NULL THEN 0 ELSE 1 END,? FROM notification_channels c
    JOIN notification_channel_checks cc ON cc.channel_id=c.id JOIN http_checks h ON h.id=cc.check_id
    LEFT JOIN automation_transition_state ns ON ns.check_id=h.id AND ns.check_version=h.config_version
    WHERE c.enabled=1 AND h.id=? AND h.enabled=1 AND h.config_version=? AND ((ns.check_id IS NOT NULL AND ns.status<>?) OR (ns.check_id IS NULL AND h.last_scheduled_at IS NULL AND ? IN ('down','degraded') AND NOT EXISTS (SELECT 1 FROM automation_transition_state existing WHERE existing.check_id=h.id))) AND ${outsideMaintenance}
      AND (h.last_scheduled_at IS NULL OR h.last_scheduled_at<?)
      AND EXISTS (SELECT 1 FROM endpoint_registry WHERE endpoint_id=h.endpoint_id AND fingerprint=?)
      AND EXISTS (SELECT 1 FROM http_check_results WHERE check_id=h.id AND config_version=h.config_version AND scheduled_at=? AND COALESCE(effective_status,status)=?)`)
    .bind(crypto.randomUUID(),scheduledAt,status,now,now,observedAt,checkId,version,status,status,observedAt,observedAt,scheduledAt,fingerprint,scheduledAt,status)
}

/** Credentials are resolved only from the persisted channel and its exact version. */
export async function sendChannel(env: ChannelEnvironment, channelId: string, version: number, event: { checkId?: string; checkVersion?: number; status?: 'up' | 'degraded' | 'down'; scheduledAt?: number; deliveryId?: string; leaseToken?: string }, requireEnabled: boolean): Promise<ChannelResult> {
  try {
    if (env.CHANNELS_READY !== 'true') return 'unavailable'
    const channel = await env.DB.prepare('SELECT id,endpoint_id,endpoint_fingerprint,enabled,version FROM notification_channels WHERE id=? AND version=?')
      .bind(channelId,version).first<Channel>()
    if (!channel || (requireEnabled && channel.enabled !== 1)) return 'unavailable'
    if (event.checkId && (!Number.isSafeInteger(event.checkVersion) || !await env.DB.prepare(`SELECT 1 AS present FROM notification_channel_checks cc JOIN http_checks h ON h.id=cc.check_id WHERE cc.channel_id=? AND cc.check_id=? AND h.enabled=1 AND h.config_version=?`).bind(channelId,event.checkId,event.checkVersion).first())) return 'unavailable'
    const endpoint = channelEndpoints(env.CHANNEL_ENDPOINTS).get(channel.endpoint_id)
    if (!endpoint || await endpointFingerprint(endpoint) !== channel.endpoint_fingerprint) return 'unavailable'
    const credential = await resolveChannelCredentialSnapshot(env.DB,env.VAULT_ENCRYPTION_KEY,channel.id,channel.version)
    if (!credential || credential.value.length>4096 || !/^[A-Za-z0-9._~+/-]+=*$/.test(credential.value)) return 'unavailable'
    const active = await env.DB.prepare(`SELECT 1 AS present FROM notification_channels WHERE id=? AND version=?${requireEnabled ? ' AND enabled=1' : ''}`)
      .bind(channelId,version).first()
    if (!active || (event.checkId && !await env.DB.prepare(`SELECT 1 AS present FROM notification_channel_checks cc JOIN http_checks h ON h.id=cc.check_id WHERE cc.channel_id=? AND cc.check_id=? AND h.enabled=1 AND h.config_version=?`).bind(channelId,event.checkId,event.checkVersion).first())) return 'unavailable'
    // Recheck immediately before the network call; a window may start after the job was claimed.
    if (event.deliveryId) {
      const checkedAt=Date.now()
      const lease=await env.DB.prepare(`SELECT o.created_at AS createdAt,o.lease_until AS leaseUntil,${overlappedMaintenance} AS maintenanceExempt,${nextMaintenanceStart} AS nextMaintenance FROM notification_outbox o JOIN http_checks h ON h.id=o.check_id
      JOIN automation_transition_state ns ON ns.check_id=h.id AND ns.check_version=h.config_version AND ns.generation=o.transition_generation
      JOIN notification_channels c ON c.id=o.channel_id JOIN notification_channel_checks cc ON cc.channel_id=c.id AND cc.check_id=h.id
      JOIN vault_secrets v ON v.id=c.secret_id AND v.vault_id=c.vault_id AND v.type='value'
      WHERE o.id=? AND o.state='sending' AND o.lease_token=? AND c.id=? AND c.version=? AND c.enabled=1
        AND h.enabled=1 AND h.config_version=? AND h.transition_suppressed=0
        AND v.id=? AND v.vault_id=? AND v.version=? AND v.nonce=? AND ${maintenanceBarrier}`)
        .bind(checkedAt,checkedAt,event.deliveryId,event.leaseToken,channelId,version,event.checkVersion,credential.secretId,credential.vaultId,credential.version,credential.nonce,checkedAt,checkedAt).first<{createdAt:number;leaseUntil:number;maintenanceExempt:number;nextMaintenance:number|null}>()
      const readyAt=Date.now()
      if (!lease || lease.leaseUntil<=readyAt+5_000 || (!lease.maintenanceExempt && readyAt-lease.createdAt>=3_600_000) || (lease.nextMaintenance!==null && lease.nextMaintenance<=readyAt)) return 'deferred'
    }
    if (!event.deliveryId && !await env.DB.prepare(`SELECT 1 FROM notification_channels c JOIN vault_secrets v ON v.id=c.secret_id AND v.vault_id=c.vault_id AND v.type='value' WHERE c.id=? AND c.version=? AND v.id=? AND v.vault_id=? AND v.version=? AND v.nonce=?`).bind(channelId,version,credential.secretId,credential.vaultId,credential.version,credential.nonce).first()) return 'unavailable'
    const init: RequestInit = { method:'POST', redirect:'manual', signal:AbortSignal.timeout(5000), headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${credential.value}`, ...(event.deliveryId ? {'Idempotency-Key':event.deliveryId} : {})}, body:JSON.stringify({event: event.checkId ? 'monitor_status' : 'test', ...(event.checkId ? {checkId:event.checkId,status:event.status,scheduledAt:event.scheduledAt} : {})}) }
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
    // Supersede older transitions, including down→up→down cycles.
    await env.DB.prepare(`UPDATE notification_outbox AS o SET state='failed',error_code='unavailable',updated_at=?
      WHERE o.state='pending' AND EXISTS (SELECT 1 FROM http_checks h WHERE h.id=o.check_id AND h.transition_suppressed=0 AND ${maintenanceBarrier}
        AND NOT EXISTS (SELECT 1 FROM automation_transition_state ns WHERE ns.check_id=h.id AND ns.check_version=o.check_version AND ns.generation=o.transition_generation))`)
      .bind(now,now,now).run()
    // Do not repeat the last acknowledged status; defer the decision while an earlier send is in flight.
    await env.DB.prepare(`UPDATE notification_outbox AS o SET state='failed',error_code='unavailable',updated_at=? WHERE o.state='pending'
      AND EXISTS (SELECT 1 FROM notification_delivery_state d WHERE d.channel_id=o.channel_id AND d.check_id=o.check_id AND d.check_version=o.check_version AND d.channel_version=o.channel_version AND d.status=o.status)
      AND NOT EXISTS (SELECT 1 FROM notification_outbox earlier WHERE earlier.channel_id=o.channel_id AND earlier.check_id=o.check_id AND earlier.state='sending' AND earlier.scheduled_at<o.scheduled_at)`)
      .bind(now).run()
    // A recovery is meaningful only after this channel acknowledged an unhealthy event.
    await env.DB.prepare(`UPDATE notification_outbox AS o SET state='failed',error_code='unavailable',updated_at=? WHERE o.state='pending' AND o.status='up'
      AND NOT EXISTS (SELECT 1 FROM notification_delivery_state d WHERE d.channel_id=o.channel_id AND d.check_id=o.check_id AND d.check_version=o.check_version AND d.channel_version=o.channel_version AND d.status IN ('down','degraded'))
      AND NOT EXISTS (SELECT 1 FROM notification_outbox earlier WHERE earlier.channel_id=o.channel_id AND earlier.check_id=o.check_id AND earlier.check_version=o.check_version AND earlier.state='sending' AND earlier.status IN ('down','degraded') AND earlier.scheduled_at<o.scheduled_at)`)
      .bind(now).run()
    await env.DB.prepare(`UPDATE notification_outbox AS o SET state='failed',error_code='delivery_failed',lease_token=NULL,lease_until=NULL,updated_at=?
      WHERE (o.state='pending' OR (o.state='sending' AND o.lease_until<?)) AND (o.attempts>=3 OR (o.created_at<?
        AND NOT EXISTS (SELECT 1 FROM http_checks h WHERE h.id=o.check_id AND ${overlappedMaintenance})))`)
      .bind(now,now,now - 3_600_000,now).run()
    await env.DB.prepare("DELETE FROM notification_outbox WHERE id IN (SELECT id FROM notification_outbox WHERE state IN ('sent','failed') AND updated_at<? LIMIT 500)").bind(now - 86_400_000).run()
    jobs = (await env.DB.prepare(`SELECT o.id,o.channel_id,o.channel_version,o.check_id,o.check_version,o.scheduled_at,o.status,o.attempts,o.transition_generation FROM notification_outbox o
      JOIN http_checks h ON h.id=o.check_id
      WHERE h.transition_suppressed=0 AND ${maintenanceBarrier} AND attempts<3 AND (state='pending' OR (state='sending' AND lease_until<?))
      AND NOT EXISTS (SELECT 1 FROM notification_outbox earlier WHERE earlier.channel_id=o.channel_id
        AND earlier.check_id=o.check_id AND earlier.state IN ('pending','sending')
        AND (earlier.scheduled_at<o.scheduled_at OR (earlier.scheduled_at=o.scheduled_at AND earlier.id<o.id)))
      ORDER BY o.scheduled_at,o.created_at LIMIT 20`).bind(now,now,now).all<Job>()).results
  } catch { return }
  for (const job of jobs) {
    const lease = crypto.randomUUID(), claimedAt = Date.now()
    await env.DB.prepare(`UPDATE notification_outbox AS o SET state='failed',error_code='delivery_failed',lease_token=NULL,lease_until=NULL,updated_at=?
      WHERE o.id=? AND (o.state='pending' OR (o.state='sending' AND o.lease_until<?)) AND o.created_at<?
        AND NOT EXISTS (SELECT 1 FROM http_checks h WHERE h.id=o.check_id AND ${overlappedMaintenance})`).bind(claimedAt,job.id,claimedAt,claimedAt-3_600_000,claimedAt).run()
    const claim = await env.DB.prepare(`UPDATE notification_outbox AS o SET state='sending',lease_token=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE o.id=? AND o.attempts<3 AND (o.state='pending' OR (o.state='sending' AND o.lease_until<?))
      AND (o.created_at>=? OR EXISTS (SELECT 1 FROM http_checks h WHERE h.id=o.check_id AND ${overlappedMaintenance}))`)
      .bind(lease,claimedAt+15_000,claimedAt,job.id,claimedAt,claimedAt-3_600_000,claimedAt).run()
    if (!claim.meta.changes) continue
    let result = await sendChannel(env,job.channel_id,job.channel_version,{checkId:job.check_id,checkVersion:job.check_version,status:job.status,scheduledAt:job.scheduled_at,deliveryId:job.id,leaseToken:lease},true)
    // An unavailable result has not sent anything. A credential fault or maintenance
    // can begin during validation, so defer before treating it as a permanent failure.
    // Keep the claim, channel version, and association fences: an unlink or reconfigure
    // must never be revived by this readiness check.
    if (result === 'unavailable') {
      const blockedAt = Date.now()
      const blocked = await env.DB.prepare(`SELECT 1 FROM notification_outbox o
        JOIN http_checks h ON h.id=o.check_id
        JOIN notification_channels c ON c.id=o.channel_id
        JOIN notification_channel_checks cc ON cc.channel_id=c.id AND cc.check_id=h.id
        WHERE o.id=? AND o.state='sending' AND o.lease_token=? AND c.enabled=1 AND c.version=o.channel_version
          AND h.enabled=1 AND h.config_version=o.check_version
          AND (h.transition_suppressed<>0 OR NOT ${maintenanceBarrier})`)
        .bind(job.id,lease,blockedAt,blockedAt).first()
      if (blocked) result = 'deferred'
    }
    const state = result === 'sent' ? 'sent' : result === 'unavailable' || (result !== 'deferred' && job.attempts + 1 >= 3) ? 'failed' : 'pending'
    if (result === 'sent') {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO notification_delivery_state (channel_id,check_id,check_version,channel_version,status)
          SELECT o.channel_id,o.check_id,o.check_version,o.channel_version,o.status FROM notification_outbox o JOIN notification_channels c ON c.id=o.channel_id AND c.version=o.channel_version WHERE o.id=? AND o.state='sending' AND o.lease_token=?
          ON CONFLICT(channel_id,check_id) DO UPDATE SET check_version=excluded.check_version,channel_version=excluded.channel_version,status=excluded.status`).bind(job.id,lease),
        env.DB.prepare("UPDATE notification_outbox SET state='sent',error_code=NULL,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=?").bind(Date.now(),job.id,lease),
      ])
    } else {
      await env.DB.prepare('UPDATE notification_outbox SET state=?,error_code=?,attempts=attempts-?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=?')
        .bind(state,result === 'deferred' ? null : result,result === 'deferred' ? 1 : 0,Date.now(),job.id,lease).run()
    }
  }
}
