import { currentCheckStatus, maintenanceBarrier, outsideMaintenance, overlappedMaintenance } from './automation-maintenance'
import { endpointFingerprint, parseEndpoints, type Endpoint } from './endpoint-config'
import { resolveActionCredentialSnapshot } from './vault-resolver'

/** Private in-process execution, authorized by the saved action and check version. */
export type ActionEnvironment = {DB:D1Database;ACTION_ENDPOINTS?:string;ACTIONS_READY?:string;VAULT_ENCRYPTION_KEY?:string;[key:string]:unknown}
type Action = {id:string;endpoint_id:string;endpoint_fingerprint:string;enabled:number;version:number}
type Job = {id:string;action_id:string;action_version:number;check_id:string;check_version:number;scheduled_at:number;status:'up'|'degraded'|'down';transition_generation:number}
type ActionResult = 'completed'|'unavailable'|'uncertain'|'deferred'
export function actionEndpoints(value:string|undefined):Map<string,Endpoint> {
  try { return new Map([...parseEndpoints(value??'[]')].filter(([,endpoint])=>new URL(endpoint.url).protocol==='https:')) } catch {return new Map()}
}

/** Atomically records only an accepted transition; jobs contain no secret or URL. */
export function enqueueActionTransition(db:D1Database,checkId:string,version:number,fingerprint:string,scheduledAt:number,status:'up'|'degraded'|'down',observedAt=scheduledAt):D1PreparedStatement {
  const now=Date.now()
  return db.prepare(`INSERT OR IGNORE INTO worker_action_outbox (id,action_id,action_version,check_id,check_version,scheduled_at,status,created_at,updated_at,transition_generation,observed_at)
    SELECT ? || ':' || a.id,a.id,a.version,h.id,h.config_version,?,?,?,?,ns.generation+1,? FROM worker_actions a
    JOIN worker_action_checks ac ON ac.action_id=a.id JOIN http_checks h ON h.id=ac.check_id
    JOIN automation_transition_state ns ON ns.check_id=h.id AND ns.check_version=h.config_version
    WHERE a.enabled=1 AND (a.trigger_status=? OR a.trigger_status='all') AND h.id=? AND h.enabled=1 AND h.config_version=?
      AND ns.status<>? AND ${outsideMaintenance} AND (h.last_scheduled_at IS NULL OR h.last_scheduled_at<?)
      AND EXISTS (SELECT 1 FROM endpoint_registry WHERE endpoint_id=h.endpoint_id AND fingerprint=?)
      AND EXISTS (SELECT 1 FROM http_check_results WHERE check_id=h.id AND config_version=h.config_version AND scheduled_at=? AND COALESCE(effective_status,status)=?)`)
    .bind(crypto.randomUUID(),scheduledAt,status,now,now,observedAt,status,checkId,version,status,observedAt,observedAt,scheduledAt,fingerprint,scheduledAt,status)
}

async function executeAction(env:ActionEnvironment,job:Job):Promise<ActionResult> {
  try {
    if(env.ACTIONS_READY!=='true') return 'unavailable'
    const action=await env.DB.prepare('SELECT id,endpoint_id,endpoint_fingerprint,enabled,version FROM worker_actions WHERE id=? AND version=? AND enabled=1').bind(job.action_id,job.action_version).first<Action>()
    if(!action) return 'unavailable'
    const endpoint=actionEndpoints(env.ACTION_ENDPOINTS).get(action.endpoint_id)
    if(!endpoint||await endpointFingerprint(endpoint)!==action.endpoint_fingerprint) return 'unavailable'
    const ready=async()=>!!await env.DB.prepare(`SELECT 1 FROM worker_action_outbox o JOIN http_checks h ON h.id=o.check_id WHERE o.id=? AND o.state='executing' AND h.transition_suppressed=0 AND ${maintenanceBarrier}`).bind(job.id,Date.now(),Date.now()).first()
    if(!await ready()) return 'deferred'
    const active=async()=>!!await env.DB.prepare(`SELECT 1 AS present FROM worker_actions a JOIN worker_action_checks ac ON ac.action_id=a.id JOIN http_checks h ON h.id=ac.check_id JOIN automation_transition_state ns ON ns.check_id=h.id AND ns.check_version=h.config_version
      WHERE a.id=? AND a.version=? AND a.enabled=1 AND ac.check_id=? AND h.enabled=1 AND h.config_version=? AND (a.trigger_status=? OR a.trigger_status='all') AND ns.generation=?
        AND (CASE WHEN h.last_effective_scheduled_at=h.last_scheduled_at THEN COALESCE(h.last_effective_status,h.last_status) ELSE h.last_status END)=?`)
      .bind(job.action_id,job.action_version,job.check_id,job.check_version,job.status,job.transition_generation,job.status).first()
    if(!await active()) return await ready() ? 'unavailable' : 'deferred'
    const credential=await resolveActionCredentialSnapshot(env.DB,env.VAULT_ENCRYPTION_KEY,action.id,action.version)
    if(!credential||credential.value.length>4096||!/^[A-Za-z0-9._~+/-]+=*$/.test(credential.value)) return await ready() ? 'unavailable' : 'deferred'
    if(!await active()) return await ready() ? 'unavailable' : 'deferred'
    // Deferral is safe here: no network call has been made for this claim.
    if(!await env.DB.prepare(`SELECT 1 FROM worker_action_outbox o JOIN http_checks h ON h.id=o.check_id
      JOIN automation_transition_state ns ON ns.check_id=h.id AND ns.check_version=h.config_version AND ns.generation=o.transition_generation
      JOIN worker_actions a ON a.id=o.action_id JOIN worker_action_checks ac ON ac.action_id=a.id AND ac.check_id=h.id
      JOIN vault_secrets v ON v.id=a.secret_id AND v.vault_id=a.vault_id AND v.type='value'
      WHERE o.id=? AND o.state='executing' AND a.id=? AND a.enabled=1 AND a.version=? AND (a.trigger_status=? OR a.trigger_status='all')
        AND h.enabled=1 AND h.config_version=? AND h.transition_suppressed=0 AND ${currentCheckStatus}=?
        AND v.id=? AND v.vault_id=? AND v.version=? AND v.nonce=? AND ${maintenanceBarrier}`)
      .bind(job.id,action.id,action.version,job.status,job.check_version,job.status,credential.secretId,credential.vaultId,credential.version,credential.nonce,Date.now(),Date.now()).first()) return 'deferred'
    const init:RequestInit={method:'POST',redirect:'manual',signal:AbortSignal.timeout(5000),headers:{'Content-Type':'application/json',Authorization:`Bearer ${credential.value}`,'Idempotency-Key':job.id},body:JSON.stringify({event:'monitor_status',checkId:job.check_id,status:job.status,scheduledAt:job.scheduled_at})}
    let response:Response
    if(endpoint.binding) {
      const binding=env[endpoint.binding]
      if(!binding||typeof binding!=='object'||!('fetch' in binding)||typeof binding.fetch!=='function') return 'unavailable'
      response=await binding.fetch(endpoint.url,init) as Response
    } else response=await fetch(endpoint.url,init)
    const ok=response.status>=200&&response.status<300
    void response.body?.cancel().catch(() => {})
    return ok?'completed':'uncertain'
  } catch {return 'uncertain'}
}

/** Claim before any external call and never retry a claimed action, including after crashes. */
export async function flushActions(env:ActionEnvironment):Promise<void> {
  if(env.ACTIONS_READY!=='true'||!env.ACTION_ENDPOINTS) return
  const now=Date.now()
  let jobs:Job[]
  try {
    // A later accepted transition makes an earlier action unsafe, even if the status cycles back.
    await env.DB.prepare(`UPDATE worker_action_outbox AS o SET state='unavailable',updated_at=? WHERE o.state='pending'
      AND EXISTS (SELECT 1 FROM http_checks h WHERE h.id=o.check_id AND h.transition_suppressed=0 AND ${maintenanceBarrier}
        AND NOT EXISTS (SELECT 1 FROM automation_transition_state ns WHERE ns.check_id=h.id AND ns.check_version=o.check_version AND ns.generation=o.transition_generation))`)
      .bind(now,now,now).run()
    await env.DB.prepare(`UPDATE worker_action_outbox AS o SET state='unavailable',updated_at=? WHERE o.state='pending'
      AND EXISTS (SELECT 1 FROM http_checks h WHERE h.id=o.check_id AND h.transition_suppressed=0 AND ${maintenanceBarrier} AND ${overlappedMaintenance}
        AND ${currentCheckStatus} IS NOT NULL AND ${currentCheckStatus}<>o.status)`)
      .bind(now,now,now,now).run()
    await env.DB.prepare(`UPDATE worker_action_outbox AS o SET state='unavailable',updated_at=? WHERE o.state='pending' AND o.created_at<?
      AND NOT EXISTS (SELECT 1 FROM http_checks h WHERE h.id=o.check_id AND ${overlappedMaintenance})`).bind(now,now-3_600_000,now).run()
    await env.DB.prepare("UPDATE worker_action_outbox SET state='uncertain',updated_at=? WHERE state='executing' AND claimed_at<?").bind(now,now-30_000).run()
    await env.DB.prepare("DELETE FROM worker_action_outbox WHERE id IN (SELECT id FROM worker_action_outbox WHERE state IN ('completed','unavailable','uncertain') AND updated_at<? LIMIT 500)").bind(now-86_400_000).run()
    jobs=(await env.DB.prepare(`SELECT o.id,o.action_id,o.action_version,o.check_id,o.check_version,o.scheduled_at,o.status,o.transition_generation FROM worker_action_outbox o JOIN http_checks h ON h.id=o.check_id WHERE o.state='pending' AND h.transition_suppressed=0 AND ${maintenanceBarrier} ORDER BY o.created_at LIMIT 20`).bind(now,now).all<Job>()).results
  } catch {return}
  for(const job of jobs) {
    const claim=await env.DB.prepare("UPDATE worker_action_outbox SET state='executing',claimed_at=?,updated_at=? WHERE id=? AND state='pending'").bind(Date.now(),Date.now(),job.id).run()
    if(!claim.meta.changes) continue
    const result=await executeAction(env,job)
    await env.DB.prepare("UPDATE worker_action_outbox SET state=?,claimed_at=CASE WHEN ?='deferred' THEN NULL ELSE claimed_at END,updated_at=? WHERE id=? AND state='executing'").bind(result==='deferred'?'pending':result,result,Date.now(),job.id).run()
  }
}
