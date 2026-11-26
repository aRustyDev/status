import { subscriberAddressApproved, subscriberEmailReady, subscriberScope, type SubscriberEnv } from './subscribers'

// Trusted preview deployment tooling enables a cron only for this contract.
export const PREVIEW_SUBSCRIBER_SCHEDULER_CONTRACT = 1

/** Dispatch only this live slot lease; never invoke the shared fallback scheduler. */
export async function flushPreviewSubscriberDeliveries(env: SubscriberEnv & { SUBSCRIBERS_READY?: string }): Promise<void> {
  const scope = subscriberScope(env)
  const slot = env.PREVIEW_SLOT, target = env.PREVIEW_TARGET, release = env.PREVIEW_RELEASE
  if (!scope || !slot || !/^[1-6]$/.test(slot) || !target || !/^[ab]$/.test(target) || !release || !/^[0-9a-f]{40}$/.test(release)) throw new Error('Invalid preview scheduler configuration')
  if (env.SUBSCRIBERS_READY !== 'true' || !subscriberEmailReady(env)) return
  const fence = 'EXISTS (SELECT 1 FROM preview_subscriber_leases l WHERE l.scope=? AND l.slot=? AND l.target=? AND l.release=? AND l.expires_at>?)'
  const fenceArgs = () => [scope, Number(slot), target, release, Date.now()]
  const now = Date.now()
  await env.DB.prepare(`DELETE FROM preview_subscriber_deliveries WHERE scope=? AND rowid IN (SELECT rowid FROM preview_subscriber_deliveries WHERE scope=? AND state IN ('delivered','failed','cancelled') AND updated_at<? LIMIT 500) AND ${fence}`).bind(scope,scope,now - 90 * 86_400_000,...fenceArgs()).run()
  await env.DB.prepare(`UPDATE preview_subscriber_deliveries SET state='failed',error_code='delivery_failed',lease_token=NULL,lease_until=NULL,updated_at=? WHERE scope=? AND state='sending' AND lease_until<? AND ${fence}`).bind(now,scope,now,...fenceArgs()).run()
  const jobs = await env.DB.prepare(`SELECT id FROM preview_subscriber_deliveries WHERE scope=? AND state='pending' AND ${fence} ORDER BY created_at,id LIMIT 20`).bind(scope,...fenceArgs()).all<{id:string}>()
  for (const job of jobs.results) {
    const lease = crypto.randomUUID()
    const claimed = await env.DB.prepare(`UPDATE preview_subscriber_deliveries SET state='sending',attempts=attempts+1,lease_token=?,lease_until=?,updated_at=? WHERE scope=? AND id=? AND state='pending' AND ${fence}`).bind(lease,Date.now()+60_000,Date.now(),scope,job.id,...fenceArgs()).run()
    if (!claimed.meta.changes) continue
    const current = await env.DB.prepare(`SELECT s.id AS subscriber_id,s.email,d.event_type FROM preview_subscriber_deliveries d
      JOIN preview_subscribers s ON s.id=d.subscriber_id AND s.scope=d.scope JOIN users u ON u.id=s.user_id JOIN preview_subscription_settings cfg ON cfg.scope=d.scope
      WHERE d.scope=? AND d.id=? AND d.state='sending' AND d.lease_token=? AND s.status='active' AND cfg.enabled=1 AND cfg.allow_email=1
      AND lower(s.email)=lower(u.email) AND d.created_at>=cfg.updated_at AND d.created_at>=s.updated_at
      AND EXISTS (SELECT 1 FROM json_each(cfg.allowed_events) WHERE value=d.event_type)
      AND EXISTS (SELECT 1 FROM json_each(s.events) WHERE value=d.event_type)
      AND (json_array_length(d.component_ids)=0 OR json_array_length(s.monitor_ids)=0 OR EXISTS
        (SELECT 1 FROM json_each(s.monitor_ids) m JOIN json_each(d.component_ids) c ON m.value=c.value)) AND ${fence}`).bind(scope,job.id,lease,...fenceArgs()).first<{subscriber_id:number;email:string;event_type:string}>()
    if (!current || !subscriberAddressApproved(env,current.email) || !subscriberEmailReady(env)) {
      await env.DB.prepare(`UPDATE preview_subscriber_deliveries SET state='cancelled',lease_token=NULL,lease_until=NULL,updated_at=? WHERE scope=? AND id=? AND lease_token=? AND ${fence}`).bind(Date.now(),scope,job.id,lease,...fenceArgs()).run()
      continue
    }
    // This check is immediately before the external call. A send already in flight
    // cannot be atomically rolled back by a later lease switch.
    const live = await env.DB.prepare('SELECT expires_at FROM preview_subscriber_leases WHERE scope=? AND slot=? AND target=? AND release=? AND expires_at>?').bind(...fenceArgs()).first<{expires_at:number}>()
    if (!live || live.expires_at <= Date.now()) continue
    let sent = false
    try {
      const text = `A status update has been published. Visit ${env.SUBSCRIBER_PUBLIC_URL!} to view it or manage your subscription.`
      await env.SUBSCRIBER_EMAIL!.send({from:env.SUBSCRIBER_EMAIL_FROM!,to:current.email,subject:'Status page update',text})
      sent = true
    } catch { /* Record only a generic failure code. */ }
    const finishedAt = Date.now()
    await env.DB.batch([
      env.DB.prepare(`UPDATE preview_subscriber_deliveries SET state=?,error_code=?,delivered_at=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE scope=? AND id=? AND lease_token=? AND ${fence}`)
        .bind(sent ? 'delivered' : 'failed',sent ? null : 'delivery_failed',sent ? finishedAt : null,finishedAt,scope,job.id,lease,...fenceArgs()),
      env.DB.prepare(`UPDATE preview_subscribers SET last_notified_at=CASE WHEN ? THEN ? ELSE last_notified_at END,last_error=? WHERE scope=? AND id=? AND EXISTS (SELECT 1 FROM preview_subscriber_deliveries WHERE scope=? AND id=? AND updated_at=?) AND ${fence}`)
        .bind(sent ? 1 : 0,finishedAt,sent ? null : 'delivery_failed',scope,current.subscriber_id,scope,job.id,finishedAt,...fenceArgs()),
    ])
  }
}
