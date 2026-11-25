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
const allowedKeys = ['name','endpointId','vaultId','secretId','enabled','checkIds','version']

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
  if (route==='/admin/notifications/checks' && method==='GET') return json((await db.prepare(`SELECT h.id,c.name FROM http_checks h JOIN components c ON c.id=h.component_id
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
  const endpoint=channelEndpoints(env.CHANNEL_ENDPOINTS).get(input.endpointId)
  if (!endpoint) return fail(400,'Unknown approved destination')
  if (!await statement(db,"SELECT 1 AS present FROM vault_secrets WHERE id=? AND vault_id=? AND type='value'",input.secretId,input.vaultId).first()) return fail(400,'Select an available Secure Value secret')
  for (const check of input.checkIds) if (!await statement(db,`SELECT 1 AS present FROM http_checks h WHERE h.id=? AND NOT EXISTS (SELECT 1 FROM gatus_sources g WHERE g.component_id=h.component_id)`,check).first()) return fail(400,'Select available local monitors')
  const fingerprint=await endpointFingerprint(endpoint), now=Date.now(), token=crypto.randomUUID(), id=channelId ?? crypto.randomUUID()
  const checks=input.checkIds as string[], version=method==='PATCH' ? checkedVersion(input.version) : 0
  if (method==='POST' && input.version!==undefined) return fail(400,'Invalid channel')
  const mutation=method==='POST'
    ? statement(db,`INSERT INTO notification_channels (id,name,endpoint_id,endpoint_fingerprint,vault_id,secret_id,enabled,mutation_key,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM notification_channels)<20`,id,input.name.trim(),input.endpointId,fingerprint,input.vaultId,input.secretId,input.enabled?1:0,token,now,now)
    : statement(db,`UPDATE notification_channels SET name=?,endpoint_id=?,endpoint_fingerprint=?,vault_id=?,secret_id=?,enabled=?,version=version+1,mutation_key=?,updated_at=? WHERE id=? AND version=?`,input.name.trim(),input.endpointId,fingerprint,input.vaultId,input.secretId,input.enabled?1:0,token,now,id,version)
  const operations:D1PreparedStatement[]=[mutation,statement(db,'DELETE FROM notification_channel_checks WHERE channel_id=? AND EXISTS (SELECT 1 FROM notification_channels WHERE id=? AND mutation_key=?)',id,id,token)]
  for (const check of checks) operations.push(statement(db,'INSERT INTO notification_channel_checks (channel_id,check_id) SELECT ?,? WHERE EXISTS (SELECT 1 FROM notification_channels WHERE id=? AND mutation_key=?)',id,check,id,token))
  operations.push(audit(db,actor,method==='POST'?'create':'update',id,token))
  const results=await db.batch(operations)
  if (!results[0].meta.changes) return fail(method==='POST'?409:409,method==='POST'?'Channel limit reached':'Channel changed. Reload and try again.')
  return json((await list(db)).find(row=>row.id===id),method==='POST'?201:200)
}
