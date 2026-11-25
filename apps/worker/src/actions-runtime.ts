import { endpointFingerprint, parseEndpoints, type Endpoint } from './endpoint-config'
import { resolveActionCredential } from './vault-resolver'

/** Private in-process execution, authorized by the saved action and check version. */
export type ActionEnvironment = {DB:D1Database;ACTION_ENDPOINTS?:string;ACTIONS_READY?:string;VAULT_ENCRYPTION_KEY?:string;[key:string]:unknown}
type Action = {id:string;endpoint_id:string;endpoint_fingerprint:string;enabled:number;version:number}
type Job = {id:string;action_id:string;action_version:number;check_id:string;check_version:number;scheduled_at:number;status:'up'|'degraded'|'down'}
type ActionResult = 'completed'|'unavailable'|'uncertain'
export function actionEndpoints(value:string|undefined):Map<string,Endpoint> {
  try { return new Map([...parseEndpoints(value??'[]')].filter(([,endpoint])=>new URL(endpoint.url).protocol==='https:')) } catch {return new Map()}
}

/** Atomically records only an accepted transition; jobs contain no secret or URL. */
export function enqueueActionTransition(db:D1Database,checkId:string,version:number,fingerprint:string,scheduledAt:number,status:'up'|'degraded'|'down'):D1PreparedStatement {
  const now=Date.now()
  return db.prepare(`INSERT OR IGNORE INTO worker_action_outbox (id,action_id,action_version,check_id,check_version,scheduled_at,status,created_at,updated_at)
    SELECT ? || ':' || a.id,a.id,a.version,h.id,h.config_version,?,?,?,? FROM worker_actions a
    JOIN worker_action_checks ac ON ac.action_id=a.id JOIN http_checks h ON h.id=ac.check_id
    WHERE a.enabled=1 AND (a.trigger_status=? OR a.trigger_status='all') AND h.id=? AND h.enabled=1 AND h.transition_suppressed=0 AND h.config_version=?
      AND (CASE WHEN h.last_effective_scheduled_at=h.last_scheduled_at THEN COALESCE(h.last_effective_status,h.last_status) ELSE h.last_status END) IS NOT NULL AND (CASE WHEN h.last_effective_scheduled_at=h.last_scheduled_at THEN COALESCE(h.last_effective_status,h.last_status) ELSE h.last_status END)<>? AND (h.last_scheduled_at IS NULL OR h.last_scheduled_at<?)
      AND EXISTS (SELECT 1 FROM endpoint_registry WHERE endpoint_id=h.endpoint_id AND fingerprint=?)
      AND EXISTS (SELECT 1 FROM http_check_results WHERE check_id=h.id AND config_version=h.config_version AND scheduled_at=? AND COALESCE(effective_status,status)=?)`)
    .bind(crypto.randomUUID(),scheduledAt,status,now,now,status,checkId,version,status,scheduledAt,fingerprint,scheduledAt,status)
}

async function executeAction(env:ActionEnvironment,job:Job):Promise<ActionResult> {
  try {
    if(env.ACTIONS_READY!=='true') return 'unavailable'
    const action=await env.DB.prepare('SELECT id,endpoint_id,endpoint_fingerprint,enabled,version FROM worker_actions WHERE id=? AND version=? AND enabled=1').bind(job.action_id,job.action_version).first<Action>()
    if(!action) return 'unavailable'
    const endpoint=actionEndpoints(env.ACTION_ENDPOINTS).get(action.endpoint_id)
    if(!endpoint||await endpointFingerprint(endpoint)!==action.endpoint_fingerprint) return 'unavailable'
    const active=async()=>!!await env.DB.prepare(`SELECT 1 AS present FROM worker_actions a JOIN worker_action_checks ac ON ac.action_id=a.id JOIN http_checks h ON h.id=ac.check_id
      WHERE a.id=? AND a.version=? AND a.enabled=1 AND ac.check_id=? AND h.enabled=1 AND h.config_version=? AND (a.trigger_status=? OR a.trigger_status='all')`)
      .bind(job.action_id,job.action_version,job.check_id,job.check_version,job.status).first()
    if(!await active()) return 'unavailable'
    const token=await resolveActionCredential(env.DB,env.VAULT_ENCRYPTION_KEY,action.id,action.version)
    if(!token||token.length>4096||!/^[A-Za-z0-9._~+/-]+=*$/.test(token)||!await active()) return 'unavailable'
    const init:RequestInit={method:'POST',redirect:'manual',signal:AbortSignal.timeout(5000),headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,'Idempotency-Key':job.id},body:JSON.stringify({event:'monitor_status',checkId:job.check_id,status:job.status,scheduledAt:job.scheduled_at})}
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
    await env.DB.prepare("UPDATE worker_action_outbox SET state='unavailable',updated_at=? WHERE state='pending' AND created_at<?").bind(now,now-3_600_000).run()
    await env.DB.prepare("UPDATE worker_action_outbox SET state='uncertain',updated_at=? WHERE state='executing' AND claimed_at<?").bind(now,now-30_000).run()
    await env.DB.prepare("DELETE FROM worker_action_outbox WHERE id IN (SELECT id FROM worker_action_outbox WHERE state IN ('completed','unavailable','uncertain') AND updated_at<? LIMIT 500)").bind(now-86_400_000).run()
    jobs=(await env.DB.prepare("SELECT id,action_id,action_version,check_id,check_version,scheduled_at,status FROM worker_action_outbox WHERE state='pending' ORDER BY created_at LIMIT 20").all<Job>()).results
  } catch {return}
  for(const job of jobs) {
    const claim=await env.DB.prepare("UPDATE worker_action_outbox SET state='executing',claimed_at=?,updated_at=? WHERE id=? AND state='pending'").bind(Date.now(),Date.now(),job.id).run()
    if(!claim.meta.changes) continue
    const result=await executeAction(env,job)
    await env.DB.prepare("UPDATE worker_action_outbox SET state=?,updated_at=? WHERE id=? AND state='executing'").bind(result,Date.now(),job.id).run()
  }
}
