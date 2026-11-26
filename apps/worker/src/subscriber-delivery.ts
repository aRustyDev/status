import { subscriberAddressApproved, subscriberEmailReady, type SubscriberEnv } from './subscribers'

type DeliveryEnv = SubscriberEnv & { DB: D1Database }

/** Insert with the publication in the same D1 batch. */
export function enqueueSubscriberDeliveries(
  db: D1Database, eventId: string, eventType: string, components: string[], now: number,
  guard?: { table: 'incidents'; id: string; mutationKey: string },
): D1PreparedStatement {
  const guardSql = guard ? 'AND EXISTS (SELECT 1 FROM incidents WHERE id=? AND mutation_key=? AND draft=0)' : ''
  return db.prepare(`INSERT OR IGNORE INTO subscriber_deliveries
    (id,subscriber_id,event_id,event_type,component_ids,created_at,updated_at)
    SELECT lower(hex(randomblob(16))),s.id,?,?,?,?,? FROM subscribers s JOIN subscription_settings cfg ON cfg.id=1
    WHERE cfg.enabled=1 AND cfg.allow_email=1 AND s.status='active'
      AND EXISTS (SELECT 1 FROM json_each(cfg.allowed_events) WHERE value=?)
      AND EXISTS (SELECT 1 FROM json_each(s.events) WHERE value=?)
      AND (json_array_length(?)=0 OR json_array_length(s.monitor_ids)=0 OR EXISTS
        (SELECT 1 FROM json_each(s.monitor_ids) m JOIN json_each(?) c ON m.value=c.value)) ${guardSql}`)
    .bind(eventId,eventType,JSON.stringify(components),now,now,eventType,eventType,JSON.stringify(components),JSON.stringify(components),...(guard ? [guard.id,guard.mutationKey] : []))
}

/** Email acceptance can be ambiguous, so an expired claim is failed without resending. */
export async function flushSubscriberDeliveries(env: DeliveryEnv): Promise<void> {
  if (!subscriberEmailReady(env)) return
  const now = Date.now()
  await env.DB.prepare("DELETE FROM subscriber_deliveries WHERE rowid IN (SELECT rowid FROM subscriber_deliveries WHERE state IN ('delivered','failed','cancelled') AND updated_at<? LIMIT 500)").bind(now - 90 * 86_400_000).run()
  await env.DB.prepare("UPDATE subscriber_deliveries SET state='failed',error_code='delivery_failed',lease_token=NULL,lease_until=NULL,updated_at=? WHERE state='sending' AND lease_until<?").bind(now,now).run()
  const jobs = await env.DB.prepare("SELECT id FROM subscriber_deliveries WHERE state='pending' ORDER BY created_at,id LIMIT 20").all<{ id: string }>()
  for (const job of jobs.results) {
    const lease = crypto.randomUUID()
    const claimed = await env.DB.prepare("UPDATE subscriber_deliveries SET state='sending',attempts=attempts+1,lease_token=?,lease_until=?,updated_at=? WHERE id=? AND state='pending'").bind(lease,Date.now()+60_000,Date.now(),job.id).run()
    if (!claimed.meta.changes) continue
    const current = await env.DB.prepare(`SELECT s.id AS subscriber_id,s.email,d.event_type FROM subscriber_deliveries d
      JOIN subscribers s ON s.id=d.subscriber_id JOIN users u ON u.id=s.user_id JOIN subscription_settings cfg ON cfg.id=1
      WHERE d.id=? AND d.state='sending' AND d.lease_token=? AND s.status='active' AND cfg.enabled=1 AND cfg.allow_email=1
      AND lower(s.email)=lower(u.email) AND d.created_at>=cfg.updated_at AND d.created_at>=s.updated_at
      AND EXISTS (SELECT 1 FROM json_each(cfg.allowed_events) WHERE value=d.event_type)
      AND EXISTS (SELECT 1 FROM json_each(s.events) WHERE value=d.event_type)
      AND (json_array_length(d.component_ids)=0 OR json_array_length(s.monitor_ids)=0 OR EXISTS
        (SELECT 1 FROM json_each(s.monitor_ids) m JOIN json_each(d.component_ids) c ON m.value=c.value))`).bind(job.id,lease).first<{subscriber_id:number; email:string; event_type:string}>()
    if (!current || !subscriberAddressApproved(env,current.email) || !subscriberEmailReady(env)) {
      await env.DB.prepare("UPDATE subscriber_deliveries SET state='cancelled',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=?").bind(Date.now(),job.id,lease).run()
      continue
    }
    let sent = false
    try {
      const url = env.SUBSCRIBER_PUBLIC_URL!
      const text = `A status update has been published. Visit ${url} to view it or manage your subscription.`
      await env.SUBSCRIBER_EMAIL!.send({from:env.SUBSCRIBER_EMAIL_FROM!,to:current.email,subject:'Status page update',text})
      sent = true
    } catch { /* Record only a generic failure code. */ }
    const finishedAt = Date.now()
    await env.DB.batch([
      env.DB.prepare("UPDATE subscriber_deliveries SET state=?,error_code=?,delivered_at=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=?")
        .bind(sent ? 'delivered' : 'failed',sent ? null : 'delivery_failed',sent ? finishedAt : null,finishedAt,job.id,lease),
      env.DB.prepare('UPDATE subscribers SET last_notified_at=CASE WHEN ? THEN ? ELSE last_notified_at END,last_error=? WHERE id=? AND EXISTS (SELECT 1 FROM subscriber_deliveries WHERE id=? AND updated_at=?)')
        .bind(sent ? 1 : 0,finishedAt,sent ? null : 'delivery_failed',current.subscriber_id,job.id,finishedAt),
    ])
  }
}
