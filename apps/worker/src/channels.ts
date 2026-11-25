import { boundedBody } from './idempotency'
import { endpointFingerprint } from './endpoint-config'
import { channelEndpoints, sendChannel, type ChannelEnvironment } from './channels-runtime'
import { vaultKeyReady } from './vault'

type Actor = { id: string; email: string; version: number }
type Body = Record<string, unknown>
type Row = { id:string; name:string; endpointId:string; vaultId:number; secretId:number; enabled:number; version:number; createdAt:number; updatedAt:number }
export class ChannelError extends Error { constructor(readonly status:number, message:string) { super(message) } }
const fail = (status:number,message:string):never => { throw new ChannelError(status,message) }
const statement = (db:D1Database, sql:string, ...values:unknown[]) => db.prepare(sql).bind(...values)
const json = (body:unknown,status=200) => Response.json(body,{status,headers:{'Cache-Control':'no-store'}})
const select = 'id,name,endpoint_id AS endpointId,vault_id AS vaultId,secret_id AS secretId,enabled,version,created_at AS createdAt,updated_at AS updatedAt'
const allowedKeys = ['name','endpointId','vaultId','secretId','enabled','checkIds','expectedChecks','version']

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
function audit(db:D1Database, actor:Actor, action:string, id:string, token:string) {
  return statement(db, `INSERT INTO audit_events (id,actor_email,action,entity_type,entity_id,created_at,details)
    SELECT ?,?,?,?,?,?,CASE WHEN EXISTS (SELECT 1 FROM users WHERE id=? AND role='admin' AND version=?) THEN '{}' ELSE NULL END
    WHERE EXISTS (SELECT 1 FROM notification_channels WHERE id=? AND mutation_key=?)`,crypto.randomUUID(),actor.email,action,'notification_channel',id,Date.now(),actor.id,actor.version,id,token)
}
async function list(db:D1Database):Promise<(Row & {checkIds:string[]})[]> {
  const rows=(await db.prepare(`SELECT ${select} FROM notification_channels ORDER BY name,id`).all<Row>()).results
  const links=(await db.prepare('SELECT channel_id,check_id FROM notification_channel_checks ORDER BY check_id').all<{channel_id:string;check_id:string}>()).results
  return rows.map(row=>({...row,checkIds:links.filter(link=>link.channel_id===row.id).map(link=>link.check_id)}))
}

/** The caller enforces Access, admin role and same-origin mutations. */
export async function channelApi(request:Request, env:ChannelEnvironment, actor:Actor, route:string):Promise<Response> {
  const method=request.method, db=env.DB
  if (env.CHANNELS_READY !== 'true' || channelEndpoints(env.CHANNEL_ENDPOINTS).size===0) return fail(503,'Notifications are unavailable')
  if (route==='/admin/notifications/destinations' && method==='GET') return json([...channelEndpoints(env.CHANNEL_ENDPOINTS).values()].map(({id,name})=>({id,name})))
  if (route==='/admin/notifications/checks' && method==='GET') return json((await db.prepare(`SELECT h.id,c.name,h.component_id AS componentId,h.config_version AS version FROM http_checks h JOIN components c ON c.id=h.component_id
    WHERE NOT EXISTS (SELECT 1 FROM gatus_sources g WHERE g.component_id=c.id) ORDER BY c.name,h.id`).all()).results)
  if (route==='/admin/notifications/channels' && method==='GET') return json(await list(db))
  if (route==='/admin/notifications/deliveries' && method==='GET') {
    const rows=(await db.prepare(`SELECT channel_id AS channelId,check_id AS checkId,scheduled_at AS scheduledAt,status,state,attempts,error_code AS errorCode,updated_at AS updatedAt FROM notification_outbox ORDER BY created_at DESC LIMIT 100`).all<{errorCode:unknown}>()).results
    return json(rows.map(row=>({...row,errorCode:row.errorCode==='unavailable'||row.errorCode==='delivery_failed'?row.errorCode:null})))
  }
  const match=/^\/admin\/notifications\/channels(?:\/([a-f0-9-]{36}))?(?:\/(test))?$/.exec(route)
  if (!match) return fail(404,'Not found')
  const channelId=match[1], action=match[2]
  if (channelId && action==='test' && method==='POST') {
    const input=await body(request)
    if (Object.keys(input).some(k=>k!=='version')) return fail(400,'Invalid test request')
    const version=checkedVersion(input.version)
    const present=await statement(db,'SELECT 1 AS present FROM notification_channels WHERE id=? AND version=?',channelId,version).first()
    if (!present) return fail(409,'Channel changed. Reload and try again.')
    await statement(db, `INSERT INTO audit_events (id,actor_email,action,entity_type,entity_id,created_at,details)
      VALUES (?,?,?,?,?,?,CASE WHEN EXISTS (SELECT 1 FROM users WHERE id=? AND role='admin' AND version=?) THEN '{}' ELSE NULL END)`,crypto.randomUUID(),actor.email,'test','notification_channel',channelId,Date.now(),actor.id,actor.version).run()
    const result=await sendChannel(env,channelId,version,{},false)
    if (result==='unavailable') return fail(409,'Channel credential or destination is unavailable')
    if (result!=='sent') return fail(502,'Channel test failed')
    return json({ok:true})
  }
  if (!action && channelId && method==='DELETE') {
    const input=await body(request)
    if (Object.keys(input).some(k=>k!=='version')) return fail(400,'Invalid request')
    const version=checkedVersion(input.version)
    const results=await db.batch([
      statement(db,`INSERT INTO audit_events (id,actor_email,action,entity_type,entity_id,created_at,details)
        SELECT ?,?,?,?,?,?,CASE WHEN EXISTS (SELECT 1 FROM users WHERE id=? AND role='admin' AND version=?) THEN '{}' ELSE NULL END
        WHERE EXISTS (SELECT 1 FROM notification_channels WHERE id=? AND version=?)`,crypto.randomUUID(),actor.email,'delete','notification_channel',channelId,Date.now(),actor.id,actor.version,channelId,version),
      statement(db,'DELETE FROM notification_channels WHERE id=? AND version=?',channelId,version),
    ])
    if (!results[1].meta.changes) return fail(409,'Channel changed. Reload and try again.')
    return json({ok:true})
  }
  if (action || (method!=='POST' && method!=='PATCH') || (method==='POST' && channelId) || (method==='PATCH' && !channelId)) return fail(404,'Not found')
  if (!await vaultKeyReady(db,env.VAULT_ENCRYPTION_KEY)) return fail(503,'Vault is unavailable')
  const input=await body(request)
  if (Object.keys(input).some(k=>!allowedKeys.includes(k))) return fail(400,'Invalid channel')
  if (typeof input.name!=='string' || !input.name.trim() || input.name.length>100 || typeof input.endpointId!=='string' ||
      !Number.isSafeInteger(input.vaultId) || Number(input.vaultId)<1 || !Number.isSafeInteger(input.secretId) || Number(input.secretId)<1 ||
      typeof input.enabled!=='boolean' || !Array.isArray(input.checkIds) || input.checkIds.length>20 ||
      input.checkIds.some(x=>typeof x!=='string' || !/^[a-f0-9-]{36}$/.test(x)) || new Set(input.checkIds).size!==input.checkIds.length) return fail(400,'Invalid channel')
  const checks=input.checkIds as string[]
  const snapshots=input.expectedChecks
  // A stale browser may still have the old editor loaded after deployment.
  if (snapshots===undefined) return fail(409,'Monitor choices are out of date. Refresh the page and try again.')
  if (!Array.isArray(snapshots) || snapshots.length!==checks.length || snapshots.some((value:unknown)=>{
    if (!value || typeof value!=='object' || Array.isArray(value)) return true
    const snapshot=value as Body
    return Object.keys(snapshot).some(key=>!['id','componentId','version'].includes(key)) || typeof snapshot.id!=='string' || !checks.includes(snapshot.id) || typeof snapshot.componentId!=='string' || !snapshot.componentId || snapshot.componentId.length>100 || !Number.isSafeInteger(snapshot.version) || Number(snapshot.version)<1
  }) || new Set(snapshots.map((value:Body)=>value.id)).size!==checks.length) return fail(400,'Invalid monitor snapshot')
  const endpoint=channelEndpoints(env.CHANNEL_ENDPOINTS).get(input.endpointId)
  if (!endpoint) return fail(400,'Unknown approved destination')
  if (!await statement(db,"SELECT 1 AS present FROM vault_secrets WHERE id=? AND vault_id=? AND type='value'",input.secretId,input.vaultId).first()) return fail(400,'Select an available Secure Value secret')
  const fingerprint=await endpointFingerprint(endpoint), now=Date.now(), token=crypto.randomUUID(), id=channelId ?? crypto.randomUUID()
  const version=method==='PATCH' ? checkedVersion(input.version) : 0
  if (method==='POST' && input.version!==undefined) return fail(400,'Invalid channel')
  // A version change is required for names as well as functional settings to
  // retain optimistic concurrency. Carry only equivalent configuration work.
  let equivalent=false, unchanged=false
  if (method==='PATCH') {
    const current=await statement(db,`SELECT name,endpoint_id,endpoint_fingerprint,vault_id,secret_id,enabled FROM notification_channels WHERE id=? AND version=?`,id,version)
      .first<{name:string;endpoint_id:string;endpoint_fingerprint:string;vault_id:number;secret_id:number;enabled:number}>()
    if (!current) return fail(409,'Channel changed. Reload and try again.')
    const links=(await statement(db,'SELECT check_id FROM notification_channel_checks WHERE channel_id=?',id).all<{check_id:string}>()).results
    equivalent=current.endpoint_id===input.endpointId && current.endpoint_fingerprint===fingerprint && current.vault_id===input.vaultId && current.secret_id===input.secretId && current.enabled===(input.enabled?1:0)
      && links.length===checks.length && links.every(link=>checks.includes(link.check_id))
    unchanged=equivalent && current.name===input.name.trim()
  }
  // Validate the selected monitor identity and configuration in the mutation's transaction.
  const checkSnapshotGuard=`NOT EXISTS (SELECT 1 FROM json_each(?) snapshot WHERE NOT EXISTS (
    SELECT 1 FROM http_checks h WHERE h.id=json_extract(snapshot.value,'$.id') AND h.component_id=json_extract(snapshot.value,'$.componentId')
      AND h.config_version=json_extract(snapshot.value,'$.version') AND NOT EXISTS (SELECT 1 FROM gatus_sources g WHERE g.component_id=h.component_id)))`
  const expectedChecks=JSON.stringify(snapshots)
  const mutation=method==='POST'
    ? statement(db,`INSERT INTO notification_channels (id,name,endpoint_id,endpoint_fingerprint,vault_id,secret_id,enabled,mutation_key,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM notification_channels)<20 AND ${checkSnapshotGuard}`,id,input.name.trim(),input.endpointId,fingerprint,input.vaultId,input.secretId,input.enabled?1:0,token,now,now,expectedChecks)
    : statement(db,`UPDATE notification_channels SET name=?,endpoint_id=?,endpoint_fingerprint=?,vault_id=?,secret_id=?,enabled=?,version=version+?,mutation_key=?,updated_at=? WHERE id=? AND version=? AND ${checkSnapshotGuard}`,input.name.trim(),input.endpointId,fingerprint,input.vaultId,input.secretId,input.enabled?1:0,unchanged?0:1,token,now,id,version,expectedChecks)
  // Delete only removed associations: downstream unlink triggers cancel pending
  // deliveries and must not fire for an unchanged or renamed channel.
  const operations:D1PreparedStatement[]=[mutation,statement(db,'DELETE FROM notification_channel_checks WHERE channel_id=? AND check_id NOT IN (SELECT value FROM json_each(?)) AND EXISTS (SELECT 1 FROM notification_channels WHERE id=? AND mutation_key=?)',id,JSON.stringify(checks),id,token)]
  for (const check of checks) operations.push(statement(db,'INSERT OR IGNORE INTO notification_channel_checks (channel_id,check_id) SELECT ?,? WHERE EXISTS (SELECT 1 FROM notification_channels WHERE id=? AND mutation_key=?)',id,check,id,token))
  if (method==='PATCH' && equivalent && !unchanged) {
    // Keep in-flight claims in their current state; never retry an already
    // claimed send merely because its display name changed.
    operations.push(statement(db,`UPDATE notification_outbox SET channel_version=? WHERE channel_id=? AND channel_version=? AND state IN ('pending','sending') AND EXISTS (SELECT 1 FROM notification_channels WHERE id=? AND mutation_key=?)`,version+1,id,version,id,token))
    operations.push(statement(db,`UPDATE notification_delivery_state SET channel_version=? WHERE channel_id=? AND channel_version=? AND EXISTS (SELECT 1 FROM notification_channels WHERE id=? AND mutation_key=?)`,version+1,id,version,id,token))
  }
  operations.push(audit(db,actor,method==='POST'?'create':'update',id,token))
  const results=await db.batch(operations)
  if (!results[0].meta.changes) return fail(409,method==='POST'?'Channel limit reached or a selected monitor changed. Reload and try again.':'Channel or selected monitor changed. Reload and try again.')
  return json((await list(db)).find(row=>row.id===id),method==='POST'?201:200)
}
