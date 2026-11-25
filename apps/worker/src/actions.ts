import { boundedBody } from './idempotency'
import { endpointFingerprint } from './endpoint-config'
import { actionEndpoints, type ActionEnvironment } from './actions-runtime'
import { vaultKeyReady } from './vault'

type Actor = { id: string; email: string; version: number }
type Body = Record<string, unknown>
type Row = { id:string; name:string; endpointId:string; vaultId:number; secretId:number; enabled:number; triggerStatus:string; version:number; createdAt:number; updatedAt:number }
type CheckSnapshot = { id:string; componentId:string; configVersion:number }
export class ActionError extends Error { constructor(readonly status:number, message:string) { super(message) } }
const fail = (status:number,message:string):never => { throw new ActionError(status,message) }
const statement = (db:D1Database, sql:string, ...values:unknown[]) => db.prepare(sql).bind(...values)
const json = (body:unknown,status=200) => Response.json(body,{status,headers:{'Cache-Control':'no-store'}})
const select = 'id,name,endpoint_id AS endpointId,vault_id AS vaultId,secret_id AS secretId,enabled,trigger_status AS triggerStatus,version,created_at AS createdAt,updated_at AS updatedAt'
const allowedKeys = ['name','endpointId','vaultId','secretId','enabled','checkIds','checkSnapshots','version','triggerStatus']

async function body(request:Request):Promise<Body> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return fail(415,'Expected application/json')
  const text = await boundedBody(request,false)
  if (text.length>16_000) return fail(413,'Request body too large')
  try { const value:unknown=JSON.parse(text); if (value && typeof value==='object' && !Array.isArray(value)) return value as Body } catch { /* generic */ }
  return fail(400,'Invalid JSON')
}
function checkedVersion(value:unknown):number {
  if (!Number.isSafeInteger(value) || Number(value)<1) return fail(400,'Invalid version')
  return Number(value)
}
function validCheckSnapshot(value:unknown, ids:string[]):value is CheckSnapshot {
  if (!value || typeof value!=='object' || Array.isArray(value)) return false
  const item=value as Record<string,unknown>
  return Object.keys(item).every(k=>['id','componentId','configVersion'].includes(k)) &&
    typeof item.id==='string' && ids.includes(item.id) && typeof item.componentId==='string' && item.componentId.length>0 &&
    Number.isSafeInteger(item.configVersion) && Number(item.configVersion)>0
}
function audit(db:D1Database, actor:Actor, action:string, id:string, token:string) {
  return statement(db, `INSERT INTO audit_events (id,actor_email,action,entity_type,entity_id,created_at,details)
    SELECT ?,?,?,?,?,?,CASE WHEN EXISTS (SELECT 1 FROM users WHERE id=? AND role='admin' AND version=?) THEN '{}' ELSE NULL END
    WHERE EXISTS (SELECT 1 FROM worker_actions WHERE id=? AND mutation_key=?)`,crypto.randomUUID(),actor.email,action,'action',id,Date.now(),actor.id,actor.version,id,token)
}
async function list(db:D1Database):Promise<(Row & {checkIds:string[]})[]> {
  const rows=(await db.prepare(`SELECT ${select} FROM worker_actions ORDER BY name,id`).all<Row>()).results
  const links=(await db.prepare(`SELECT action_id,check_id FROM worker_action_checks UNION SELECT l.action_id,h.id AS check_id FROM monitor_action_links l JOIN http_checks h ON h.component_id=l.component_id ORDER BY check_id`).all<{action_id:string;check_id:string}>()).results
  return rows.map(row=>({...row,checkIds:links.filter(link=>link.action_id===row.id).map(link=>link.check_id)}))
}

type MonitorLink = { actionId:string; onStatus:'up'|'down'; delayMinutes:number; cooldownMinutes:number }
async function monitorLinks(db:D1Database, componentId:string):Promise<{links:MonitorLink[];version:number}> {
  // One SQL statement observes the links and revision in the same D1 snapshot.
  const row=await statement(db, `WITH links AS (
    SELECT action_id AS actionId,on_status AS onStatus,delay_minutes AS delayMinutes,cooldown_minutes AS cooldownMinutes FROM monitor_action_links WHERE component_id=? AND on_status IN ('up','down')
    UNION SELECT a.id, status.value, 0, 0 FROM worker_action_checks ac JOIN http_checks h ON h.id=ac.check_id JOIN worker_actions a ON a.id=ac.action_id
    JOIN json_each('["up","down"]') status ON (a.trigger_status=status.value OR a.trigger_status='all')
    WHERE h.component_id=? AND NOT EXISTS (SELECT 1 FROM monitor_action_links l WHERE l.component_id=h.component_id AND l.action_id=a.id)
    ORDER BY actionId,onStatus)
    SELECT EXISTS (SELECT 1 FROM gatus_sources WHERE component_id=c.id) AS managed,
      COALESCE((SELECT version FROM monitor_action_revisions WHERE component_id=c.id),0) AS version,
      (SELECT json_group_array(json_object('actionId',actionId,'onStatus',onStatus,'delayMinutes',delayMinutes,'cooldownMinutes',cooldownMinutes)) FROM links) AS links
    FROM components c WHERE c.id=?`,componentId,componentId,componentId).first<{managed:number;version:number;links:string}>()
  if (!row) return fail(404,'Monitor not found')
  if (row.managed) return fail(403,'Gatus-managed monitors are read-only')
  return {links:JSON.parse(row.links) as MonitorLink[],version:row.version}
}

async function monitorActionApi(request:Request, db:D1Database, actor:Actor, componentId:string):Promise<Response> {
  if (request.method==='GET') return json(await monitorLinks(db,componentId))
  if (request.method!=='PUT') return fail(404,'Not found')
  const input=await body(request)
  if (Object.keys(input).some(k=>!['links','version'].includes(k)) || !Number.isSafeInteger(input.version) || Number(input.version)<0 || !Array.isArray(input.links) || input.links.length>40) return fail(400,'Invalid action links')
  const links:MonitorLink[]=[]
  const seen=new Set<string>()
  for (const value of input.links) {
    if (!value || typeof value!=='object' || Array.isArray(value)) return fail(400,'Invalid action link')
    const item=value as Record<string,unknown>
    if (Object.keys(item).some(k=>!['actionId','onStatus','delayMinutes','cooldownMinutes'].includes(k)) || typeof item.actionId!=='string' || !/^[a-f0-9-]{36}$/.test(item.actionId) || !['up','down'].includes(String(item.onStatus)) || !Number.isSafeInteger(item.delayMinutes) || Number(item.delayMinutes)<0 || Number(item.delayMinutes)>10080 || !Number.isSafeInteger(item.cooldownMinutes) || Number(item.cooldownMinutes)<0 || Number(item.cooldownMinutes)>10080) return fail(400,'Invalid action link')
    const key=`${item.actionId}:${item.onStatus}`
    if (seen.has(key)) return fail(400,'Duplicate action link')
    seen.add(key); links.push(item as MonitorLink)
  }
  const current=await monitorLinks(db,componentId)
  if (current.version!==input.version) return fail(409,'Monitor actions changed. Reload and try again.')
  const order=(values:MonitorLink[])=>[...values].sort((a,b)=>`${a.actionId}:${a.onStatus}`.localeCompare(`${b.actionId}:${b.onStatus}`))
  const group=(values:MonitorLink[],id:string)=>JSON.stringify(order(values.filter(link=>link.actionId===id)))
  const changedIds=[...new Set([...current.links,...links].map(link=>link.actionId))].filter(id=>group(current.links,id)!==group(links,id))
  if (changedIds.length===0) {
    const results=await db.batch([
      statement(db,'INSERT OR IGNORE INTO monitor_action_revisions (component_id) SELECT id FROM components WHERE id=?',componentId),
      statement(db, `UPDATE monitor_action_revisions SET version=version WHERE component_id=? AND version=? AND EXISTS (SELECT 1 FROM users WHERE id=? AND role='admin' AND version=?) AND NOT EXISTS (SELECT 1 FROM gatus_sources WHERE component_id=?)`,componentId,input.version,actor.id,actor.version,componentId),
    ])
    if (!results[1].meta.changes) return fail(409,'Monitor actions or identity changed. Reload and try again.')
    return json(await monitorLinks(db,componentId))
  }
  const changed=JSON.stringify(changedIds)
  const token=crypto.randomUUID(), selected=JSON.stringify(links)
  const guard=`EXISTS (SELECT 1 FROM monitor_action_revisions WHERE component_id=? AND mutation_key=?)`
  const operations=[
    statement(db, 'INSERT OR IGNORE INTO monitor_action_revisions (component_id) SELECT id FROM components WHERE id=?',componentId),
    statement(db, `UPDATE monitor_action_revisions SET version=version+1,mutation_key=? WHERE component_id=? AND version=?
      AND EXISTS (SELECT 1 FROM users WHERE id=? AND role='admin' AND version=?)
      AND NOT EXISTS (SELECT 1 FROM gatus_sources WHERE component_id=?)
      AND NOT EXISTS (SELECT 1 FROM json_each(?) item WHERE NOT EXISTS (SELECT 1 FROM worker_actions a WHERE a.id=json_extract(item.value,'$.actionId')))`, token,componentId,input.version,actor.id,actor.version,componentId,selected),
    // Fence action editors opened before this monitor changed. Carry unaffected
    // jobs to the new action version without resetting claims.
    statement(db, `UPDATE worker_actions SET version=version+1 WHERE id IN (SELECT value FROM json_each(?)) AND ${guard}`,changed,componentId,token),
    statement(db, `UPDATE worker_action_outbox AS o SET action_version=action_version+1 WHERE action_id IN (SELECT value FROM json_each(?)) AND state IN ('pending','executing') AND EXISTS (SELECT 1 FROM worker_actions a WHERE a.id=o.action_id AND a.version=o.action_version+1) AND ${guard}
      AND (NOT EXISTS (SELECT 1 FROM http_checks h WHERE h.id=o.check_id AND h.component_id=?) OR EXISTS (SELECT 1 FROM monitor_action_links l JOIN json_each(?) j ON json_extract(j.value,'$.actionId')=l.action_id AND json_extract(j.value,'$.onStatus')=l.on_status AND json_extract(j.value,'$.delayMinutes')=l.delay_minutes AND json_extract(j.value,'$.cooldownMinutes')=l.cooldown_minutes WHERE l.id=o.link_id))`,changed,componentId,token,componentId,selected),
    // Preserve a legacy degraded trigger when the action remains linked. The monitor editor only exposes down and recovery.
    statement(db, `INSERT OR IGNORE INTO monitor_action_links (id,component_id,action_id,on_status,delay_minutes,cooldown_minutes)
      SELECT lower(hex(randomblob(16))),?,a.id,'degraded',0,0 FROM worker_action_checks ac JOIN http_checks h ON h.id=ac.check_id JOIN worker_actions a ON a.id=ac.action_id
      WHERE h.component_id=? AND a.trigger_status IN ('degraded','all') AND EXISTS (SELECT 1 FROM json_each(?) j WHERE json_extract(j.value,'$.actionId')=a.id) AND ${guard}`,componentId,componentId,selected,componentId,token),
    statement(db, `DELETE FROM worker_action_checks WHERE check_id IN (SELECT id FROM http_checks WHERE component_id=?) AND NOT EXISTS (SELECT 1 FROM worker_actions a WHERE a.id=worker_action_checks.action_id AND a.trigger_status='degraded' AND NOT EXISTS (SELECT 1 FROM json_each(?) j WHERE json_extract(j.value,'$.actionId')=a.id)) AND ${guard}`,componentId,selected,componentId,token),
    statement(db, `DELETE FROM monitor_action_links WHERE component_id=? AND ((on_status='degraded' AND action_id NOT IN (SELECT json_extract(value,'$.actionId') FROM json_each(?))) OR (on_status<>'degraded' AND NOT EXISTS (SELECT 1 FROM json_each(?) j WHERE json_extract(j.value,'$.actionId')=monitor_action_links.action_id AND json_extract(j.value,'$.onStatus')=monitor_action_links.on_status AND json_extract(j.value,'$.delayMinutes')=monitor_action_links.delay_minutes AND json_extract(j.value,'$.cooldownMinutes')=monitor_action_links.cooldown_minutes))) AND ${guard}`,componentId,selected,selected,componentId,token),
  ]
  for (const link of links) operations.push(statement(db, `INSERT OR IGNORE INTO monitor_action_links (id,component_id,action_id,on_status,delay_minutes,cooldown_minutes) SELECT ?,?,?,?,?,? WHERE ${guard}`,crypto.randomUUID(),componentId,link.actionId,link.onStatus,link.delayMinutes,link.cooldownMinutes,componentId,token))
  // Legacy jobs with unchanged zero-delay policies can follow the newly
  // materialized link without losing their claim or execution fence.
  operations.push(statement(db, `UPDATE worker_action_outbox AS o SET link_id=(SELECT l.id FROM monitor_action_links l JOIN http_checks h ON h.component_id=l.component_id WHERE h.id=o.check_id AND l.action_id=o.action_id AND l.on_status=o.status AND l.delay_minutes=0 AND l.cooldown_minutes=0),
    action_version=(SELECT a.version FROM worker_actions a WHERE a.id=o.action_id)
    WHERE o.link_id IS NULL AND o.state IN ('pending','executing') AND o.check_id IN (SELECT id FROM http_checks WHERE component_id=?) AND ${guard}
      AND EXISTS (SELECT 1 FROM worker_actions a WHERE a.id=o.action_id AND a.version IN (o.action_version,o.action_version+1))
      AND EXISTS (SELECT 1 FROM monitor_action_links l JOIN http_checks h ON h.component_id=l.component_id WHERE h.id=o.check_id AND l.action_id=o.action_id AND l.on_status=o.status AND l.delay_minutes=0 AND l.cooldown_minutes=0)`,componentId,componentId,token))
  operations.push(statement(db, `INSERT INTO audit_events (id,actor_email,action,entity_type,entity_id,created_at,details) SELECT ?,?,'update','monitor-actions',?,?, '{}' WHERE ${guard}`,crypto.randomUUID(),actor.email,componentId,Date.now(),componentId,token))
  const results=await db.batch(operations)
  if (!results[1].meta.changes) return fail(409,'Monitor actions or identity changed. Reload and try again.')
  return json(await monitorLinks(db,componentId))
}

/** The caller enforces Access, admin role and same-origin mutations. */
export async function actionApi(request:Request, env:ActionEnvironment, actor:Actor, route:string):Promise<Response> {
  const method=request.method, db=env.DB
  if (env.ACTIONS_READY !== 'true' || actionEndpoints(env.ACTION_ENDPOINTS).size===0) return fail(503,'Actions are unavailable')
  const monitorMatch=/^\/admin\/actions\/monitor\/([a-f0-9-]{36})$/.exec(route)
  if (monitorMatch) return monitorActionApi(request,db,actor,monitorMatch[1]!)
  if (route==='/admin/actions/destinations' && method==='GET') return json([...actionEndpoints(env.ACTION_ENDPOINTS).values()].map(({id,name})=>({id,name})))
  if (route==='/admin/actions/checks' && method==='GET') return json((await db.prepare(`SELECT h.id,c.name,h.component_id AS componentId,h.config_version AS configVersion FROM http_checks h JOIN components c ON c.id=h.component_id
    WHERE NOT EXISTS (SELECT 1 FROM gatus_sources g WHERE g.component_id=c.id) ORDER BY c.name,h.id`).all()).results)
  if (route==='/admin/actions' && method==='GET') return json(await list(db))
  if (route==='/admin/actions/runs' && method==='GET') return json((await db.prepare(`SELECT action_id AS actionId,check_id AS checkId,scheduled_at AS scheduledAt,status,state,updated_at AS updatedAt FROM worker_action_outbox ORDER BY created_at DESC LIMIT 100`).all()).results)
  const match=/^\/admin\/actions(?:\/([a-f0-9-]{36}))?$/.exec(route)
  if (!match) return fail(404,'Not found')
  const actionId=match[1]
  if (actionId && method==='DELETE') {
    const input=await body(request)
    if (Object.keys(input).some(k=>k!=='version')) return fail(400,'Invalid request')
    const version=checkedVersion(input.version)
    const results=await db.batch([
      statement(db,`INSERT INTO audit_events (id,actor_email,action,entity_type,entity_id,created_at,details)
        SELECT ?,?,?,?,?,?,CASE WHEN EXISTS (SELECT 1 FROM users WHERE id=? AND role='admin' AND version=?) THEN '{}' ELSE NULL END
        WHERE EXISTS (SELECT 1 FROM worker_actions WHERE id=? AND version=?)`,crypto.randomUUID(),actor.email,'delete','action',actionId,Date.now(),actor.id,actor.version,actionId,version),
      statement(db,'DELETE FROM worker_actions WHERE id=? AND version=?',actionId,version),
    ])
    if (!results[1].meta.changes) return fail(409,'Action changed. Reload and try again.')
    return json({ok:true})
  }
  if ((method!=='POST' && method!=='PATCH') || (method==='POST' && actionId) || (method==='PATCH' && !actionId)) return fail(404,'Not found')
  if (!await vaultKeyReady(db,env.VAULT_ENCRYPTION_KEY)) return fail(503,'Vault is unavailable')
  const input=await body(request)
  if (Object.keys(input).some(k=>!allowedKeys.includes(k))) return fail(400,'Invalid action')
  if (typeof input.name!=='string' || !input.name.trim() || input.name.length>100 || typeof input.endpointId!=='string' ||
      !Number.isSafeInteger(input.vaultId) || Number(input.vaultId)<1 || !Number.isSafeInteger(input.secretId) || Number(input.secretId)<1 ||
      typeof input.enabled!=='boolean' || !['up','degraded','down','all'].includes(String(input.triggerStatus)) || !Array.isArray(input.checkIds) || input.checkIds.length>20 ||
      input.checkIds.some(x=>typeof x!=='string' || !/^[a-f0-9-]{36}$/.test(x)) || new Set(input.checkIds).size!==input.checkIds.length) return fail(400,'Invalid action')
  const checks=input.checkIds as string[]
  // An older browser may still have an editor open after a deployment. Ask it
  // to refresh rather than accepting check IDs without their identity fence.
  if (input.checkSnapshots===undefined) return fail(409,'Monitor choices are out of date. Refresh the page and try again.')
  if (!Array.isArray(input.checkSnapshots) || input.checkSnapshots.length!==checks.length || !input.checkSnapshots.every(snapshot=>validCheckSnapshot(snapshot,checks)) ||
    new Set(input.checkSnapshots.map(snapshot=>(snapshot as CheckSnapshot).id)).size!==checks.length) return fail(400,'Invalid monitor snapshot')
  const endpoint=actionEndpoints(env.ACTION_ENDPOINTS).get(input.endpointId)
  if (!endpoint) return fail(400,'Unknown approved destination')
  if (!await statement(db,"SELECT 1 AS present FROM vault_secrets WHERE id=? AND vault_id=? AND type='value'",input.secretId,input.vaultId).first()) return fail(400,'Select an available Secure Value secret')
  const fingerprint=await endpointFingerprint(endpoint), now=Date.now(), token=crypto.randomUUID(), id=actionId ?? crypto.randomUUID()
  const version=method==='PATCH' ? checkedVersion(input.version) : 0
  if (method==='POST' && input.version!==undefined) return fail(400,'Invalid action')
  let equivalent=false, unchanged=false
  if (method==='PATCH') {
    const current=await statement(db,`SELECT name,endpoint_id,endpoint_fingerprint,vault_id,secret_id,enabled,trigger_status FROM worker_actions WHERE id=? AND version=?`,id,version)
      .first<{name:string;endpoint_id:string;endpoint_fingerprint:string;vault_id:number;secret_id:number;enabled:number;trigger_status:string}>()
    if (!current) return fail(409,'Action changed. Reload and try again.')
    const links=(await statement(db,`SELECT check_id FROM worker_action_checks WHERE action_id=? UNION SELECT h.id AS check_id FROM monitor_action_links l JOIN http_checks h ON h.component_id=l.component_id WHERE l.action_id=?`,id,id).all<{check_id:string}>()).results
    equivalent=current.endpoint_id===input.endpointId && current.endpoint_fingerprint===fingerprint && current.vault_id===input.vaultId && current.secret_id===input.secretId && current.enabled===(input.enabled?1:0) && current.trigger_status===input.triggerStatus
      && links.length===checks.length && links.every(link=>checks.includes(link.check_id))
    unchanged=equivalent && current.name===input.name.trim()
  }
  // Fence the editor's monitor identity and configuration in the same transaction as the action mutation.
  const unchangedChecks=`NOT EXISTS (SELECT 1 FROM json_each(?) selected WHERE NOT EXISTS (
    SELECT 1 FROM http_checks h WHERE h.id=json_extract(selected.value,'$.id') AND h.component_id=json_extract(selected.value,'$.componentId')
      AND h.config_version=json_extract(selected.value,'$.configVersion') AND NOT EXISTS (SELECT 1 FROM gatus_sources g WHERE g.component_id=h.component_id)))`
  const snapshots=JSON.stringify(input.checkSnapshots)
  const mutation=method==='POST'
    ? statement(db,`INSERT INTO worker_actions (id,name,endpoint_id,endpoint_fingerprint,vault_id,secret_id,enabled,trigger_status,mutation_key,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM worker_actions)<20 AND ${unchangedChecks}`,id,input.name.trim(),input.endpointId,fingerprint,input.vaultId,input.secretId,input.enabled?1:0,input.triggerStatus,token,now,now,snapshots)
    : statement(db,`UPDATE worker_actions SET name=?,endpoint_id=?,endpoint_fingerprint=?,vault_id=?,secret_id=?,enabled=?,trigger_status=?,version=version+?,mutation_key=?,updated_at=? WHERE id=? AND version=? AND ${unchangedChecks}`,input.name.trim(),input.endpointId,fingerprint,input.vaultId,input.secretId,input.enabled?1:0,input.triggerStatus,unchanged?0:1,token,now,id,version,snapshots)
  const operations:D1PreparedStatement[]=[mutation,
    statement(db, `INSERT OR IGNORE INTO monitor_action_revisions (component_id) SELECT h.component_id FROM http_checks h WHERE h.id IN (SELECT check_id FROM worker_action_checks WHERE action_id=?) OR h.id IN (SELECT value FROM json_each(?)) OR h.component_id IN (SELECT component_id FROM monitor_action_links WHERE action_id=?)`,id,JSON.stringify(checks),id),
    statement(db, `UPDATE monitor_action_revisions SET version=version+1 WHERE component_id IN (SELECT h.component_id FROM http_checks h WHERE h.id IN (SELECT check_id FROM worker_action_checks WHERE action_id=?) OR h.id IN (SELECT value FROM json_each(?)) OR h.component_id IN (SELECT component_id FROM monitor_action_links WHERE action_id=?)) AND EXISTS (SELECT 1 FROM worker_actions WHERE id=? AND mutation_key=?)`,id,JSON.stringify(checks),id,id,token),
    statement(db, `DELETE FROM monitor_action_links WHERE action_id=? AND component_id IN (SELECT component_id FROM http_checks) AND component_id NOT IN (SELECT component_id FROM http_checks WHERE id IN (SELECT value FROM json_each(?))) AND EXISTS (SELECT 1 FROM worker_actions WHERE id=? AND mutation_key=?)`,id,JSON.stringify(checks),id,token),
    statement(db,'DELETE FROM worker_action_checks WHERE action_id=? AND check_id NOT IN (SELECT value FROM json_each(?)) AND EXISTS (SELECT 1 FROM worker_actions WHERE id=? AND mutation_key=?)',id,JSON.stringify(checks),id,token)]
  for (const check of checks) operations.push(statement(db,'INSERT OR IGNORE INTO worker_action_checks (action_id,check_id) SELECT ?,? WHERE EXISTS (SELECT 1 FROM worker_actions WHERE id=? AND mutation_key=?)',id,check,id,token))
  if (method==='PATCH' && equivalent && !unchanged) {
    // Carry pending and claimed work without resetting a claim or retrying an
    // action that may already have reached its destination.
    operations.push(statement(db,`UPDATE worker_action_outbox SET action_version=? WHERE action_id=? AND action_version=? AND state IN ('pending','executing') AND EXISTS (SELECT 1 FROM worker_actions WHERE id=? AND mutation_key=?)`,version+1,id,version,id,token))
  }
  operations.push(audit(db,actor,method==='POST'?'create':'update',id,token))
  const results=await db.batch(operations)
  if (!results[0].meta.changes) return fail(409,method==='POST'?'Action limit reached or a selected monitor changed. Reload and try again.':'Action or selected monitor changed. Reload and try again.')
  return json((await list(db)).find(row=>row.id===id),method==='POST'?201:200)
}
