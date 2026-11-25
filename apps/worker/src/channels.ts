import { boundedBody } from './idempotency'
import { endpointFingerprint } from './endpoint-config'
import { channelEndpoints, sendChannel, type ChannelEnvironment } from './channels-runtime'
import { vaultKeyReady } from './vault'
import { emailChannelFingerprint, emailDestinations, emailReady, type EmailChannelEnv } from './email-channel'

type Actor = { id: string; email: string; version: number }
type Body = Record<string, unknown>
type Row = { id:string; name:string; type:'webhook'|'email'; endpointId:string; vaultId:number; secretId:number; recipientId:string | null; enabled:number; version:number; associationVersion:number; createdAt:number; updatedAt:number }
type ChannelItem = { id:string; name:string; enabled:number; version:number; associationVersion:number; createdAt:number; updatedAt:number; checkIds:string[] } & ({ type:'email'; recipientId:string | null } | { type:'webhook'; endpointId:string; vaultId:number; secretId:number })
export class ChannelError extends Error { constructor(readonly status:number, message:string) { super(message) } }
const fail = (status:number,message:string):never => { throw new ChannelError(status,message) }
const statement = (db:D1Database, sql:string, ...values:unknown[]) => db.prepare(sql).bind(...values)
const json = (body:unknown,status=200) => Response.json(body,{status,headers:{'Cache-Control':'no-store'}})
const select = 'id,name,channel_type AS type,endpoint_id AS endpointId,vault_id AS vaultId,secret_id AS secretId,recipient_id AS recipientId,enabled,version,association_version AS associationVersion,created_at AS createdAt,updated_at AS updatedAt'
const commonKeys = ['name','type','enabled','checkIds','expectedChecks','expectedCheckIds','expectedAssociationVersion','version']

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
function associationVersion(value:unknown):number {
  if (!Number.isSafeInteger(value) || Number(value)<0) return fail(400,'Invalid association version')
  return Number(value)
}
function audit(db:D1Database, actor:Actor, action:string, id:string, token:string) {
  return statement(db, `INSERT INTO audit_events (id,actor_email,action,entity_type,entity_id,created_at,details)
    SELECT ?,?,?,?,?,?,CASE WHEN EXISTS (SELECT 1 FROM users WHERE id=? AND role='admin' AND version=?) THEN '{}' ELSE NULL END
    WHERE EXISTS (SELECT 1 FROM notification_channels WHERE id=? AND mutation_key=?)`,crypto.randomUUID(),actor.email,action,'notification_channel',id,Date.now(),actor.id,actor.version,id,token)
}
async function list(db:D1Database):Promise<ChannelItem[]> {
  const rows=(await db.prepare(`SELECT ${select} FROM notification_channels ORDER BY name,id`).all<Row>()).results
  const links=(await db.prepare('SELECT channel_id,check_id FROM notification_channel_checks ORDER BY check_id').all<{channel_id:string;check_id:string}>()).results
  return rows.map(row=>{
    const base = { id:row.id, name:row.name, enabled:row.enabled, version:row.version, associationVersion:row.associationVersion, createdAt:row.createdAt, updatedAt:row.updatedAt, checkIds:links.filter(link=>link.channel_id===row.id).map(link=>link.check_id) }
    return row.type==='email' ? {...base,type:'email',recipientId:row.recipientId} : {...base,type:'webhook',endpointId:row.endpointId,vaultId:row.vaultId,secretId:row.secretId}
  })
}

/** The caller enforces Access, admin role and same-origin mutations. */
export async function channelApi(request:Request, env:ChannelEnvironment, actor:Actor, route:string):Promise<Response> {
  const method=request.method, db=env.DB
  if (env.CHANNELS_READY !== 'true' || (!channelEndpoints(env.CHANNEL_ENDPOINTS).size && !emailReady(env as ChannelEnvironment & EmailChannelEnv))) return fail(503,'Notifications are unavailable')
  if (route==='/admin/notifications/destinations' && method==='GET') return json([...channelEndpoints(env.CHANNEL_ENDPOINTS).values()].map(({id,name})=>({id,name})))
  if (route==='/admin/notifications/email-destinations' && method==='GET') {
    if (!emailReady(env as ChannelEnvironment & EmailChannelEnv)) return fail(503,'Email notifications are unavailable')
    return json([...emailDestinations((env as ChannelEnvironment & EmailChannelEnv).EMAIL_DESTINATIONS).values()].map(({id,name})=>({id,name})))
  }
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
    if (Object.keys(input).some(k=>!['version','expectedAssociationVersion'].includes(k))) return fail(400,'Invalid request')
    const version=checkedVersion(input.version), association=associationVersion(input.expectedAssociationVersion)
    const results=await db.batch([
      statement(db,`INSERT INTO audit_events (id,actor_email,action,entity_type,entity_id,created_at,details)
        SELECT ?,?,?,?,?,?,CASE WHEN EXISTS (SELECT 1 FROM users WHERE id=? AND role='admin' AND version=?) THEN '{}' ELSE NULL END
        WHERE EXISTS (SELECT 1 FROM notification_channels WHERE id=? AND version=? AND association_version=?)`,crypto.randomUUID(),actor.email,'delete','notification_channel',channelId,Date.now(),actor.id,actor.version,channelId,version,association),
      statement(db,'DELETE FROM notification_channels WHERE id=? AND version=? AND association_version=?',channelId,version,association),
    ])
    if (!results[1].meta.changes) return fail(409,'Channel changed. Reload and try again.')
    return json({ok:true})
  }
  if (action || (method!=='POST' && method!=='PATCH') || (method==='POST' && channelId) || (method==='PATCH' && !channelId)) return fail(404,'Not found')
  const input=await body(request)
  const type=input.type ?? 'webhook'
  if (type!=='webhook' && type!=='email') return fail(400,'Unsupported channel type')
  const allowedKeys = type==='email' ? [...commonKeys,'recipientId'] : [...commonKeys,'endpointId','vaultId','secretId']
  if (Object.keys(input).some(k=>!allowedKeys.includes(k))) return fail(400,'Invalid channel')
  const validChecks = (value:unknown): value is string[] => Array.isArray(value) && value.every(x=>typeof x==='string' && /^[a-f0-9-]{36}$/.test(x)) && new Set(value).size===value.length
  if (typeof input.name!=='string' || !input.name.trim() || input.name.length>100 || typeof input.enabled!=='boolean' || !validChecks(input.checkIds)) return fail(400,'Invalid channel')
  const checks=input.checkIds
  const snapshots=input.expectedChecks
  if (!Array.isArray(snapshots) || snapshots.length!==checks.length || snapshots.some((value:unknown) => {
    if (!value || typeof value!=='object' || Array.isArray(value)) return true
    const snapshot=value as Body
    return Object.keys(snapshot).some(key=>!['id','componentId','version'].includes(key)) || typeof snapshot.id!=='string' || !checks.includes(snapshot.id) || typeof snapshot.componentId!=='string' || !snapshot.componentId || snapshot.componentId.length>100 || !Number.isSafeInteger(snapshot.version) || Number(snapshot.version)<1
  }) || new Set(snapshots.map((value:Body)=>value.id)).size!==checks.length) return fail(400,'Invalid monitor snapshot')
  if ((method==='PATCH' && !validChecks(input.expectedCheckIds)) || (method==='POST' && (input.expectedCheckIds!==undefined || input.expectedAssociationVersion!==undefined))) return fail(400,'Invalid channel snapshot')
  // Before the association limit existed a channel could acquire more than
  // 20 checks through monitor edits. Allow those links to be retained or
  // reduced, but never add new links while the channel is over the limit.
  if (checks.length>20 && (method==='POST' || !checks.every(check => (input.expectedCheckIds as string[]).includes(check)))) return fail(400,'A channel can be assigned to at most 20 monitors')
  const expectedAssociation = method==='PATCH' ? associationVersion(input.expectedAssociationVersion) : 0
  let endpointId='', fingerprint='', vaultId=0, secretId=0, recipientId:string | null=null, emailFingerprint:string | null=null
  if (type==='webhook') {
    if (!await vaultKeyReady(db,env.VAULT_ENCRYPTION_KEY)) return fail(503,'Vault is unavailable')
    if (typeof input.endpointId!=='string' || !Number.isSafeInteger(input.vaultId) || Number(input.vaultId)<1 || !Number.isSafeInteger(input.secretId) || Number(input.secretId)<1) return fail(400,'Invalid channel')
    const endpoint=channelEndpoints(env.CHANNEL_ENDPOINTS).get(input.endpointId)
    if (!endpoint) return fail(400,'Unknown approved destination')
    if (!await statement(db,"SELECT 1 AS present FROM vault_secrets WHERE id=? AND vault_id=? AND type='value'",input.secretId,input.vaultId).first()) return fail(400,'Select an available Secure Value secret')
    endpointId=input.endpointId; fingerprint=await endpointFingerprint(endpoint); vaultId=Number(input.vaultId); secretId=Number(input.secretId)
  } else {
    const emailEnv=env as ChannelEnvironment & EmailChannelEnv
    if (!emailReady(emailEnv)) return fail(503,'Email notifications are unavailable')
    if (typeof input.recipientId!=='string') return fail(400,'Select an approved email destination')
    const destination=emailDestinations(emailEnv.EMAIL_DESTINATIONS).get(input.recipientId)
    if (!destination) return fail(400,'Select an approved email destination')
    recipientId=destination.id; emailFingerprint=await emailChannelFingerprint(emailEnv.EMAIL_FROM!,destination.address)
  }
  for (const check of input.checkIds) if (!await statement(db,`SELECT 1 AS present FROM http_checks h WHERE h.id=? AND NOT EXISTS (SELECT 1 FROM gatus_sources g WHERE g.component_id=h.component_id)`,check).first()) return fail(400,'Select available local monitors')
  const now=Date.now(), token=crypto.randomUUID(), id=channelId ?? crypto.randomUUID()
  const version=method==='PATCH' ? checkedVersion(input.version) : 0
  if (method==='POST' && input.version!==undefined) return fail(400,'Invalid channel')
  const before = method==='PATCH' ? await statement(db,`SELECT name,channel_type,endpoint_id,endpoint_fingerprint,vault_id,secret_id,enabled,recipient_id,email_fingerprint
    FROM notification_channels WHERE id=? AND version=?`,id,version).first<{name:string;channel_type:string;endpoint_id:string;endpoint_fingerprint:string;vault_id:number;secret_id:number;enabled:number;recipient_id:string | null;email_fingerprint:string | null}>() : null
  // A rename preserves deliveries for retained checks only. Removed checks
  // are cancelled by the unlink trigger; new checks begin without history.
  const carryQueued = !!before && before.name!==input.name.trim() && before.channel_type===type && before.endpoint_id===endpointId && before.endpoint_fingerprint===fingerprint && before.vault_id===vaultId && before.secret_id===secretId && before.enabled===(input.enabled?1:0) && before.recipient_id===recipientId && before.email_fingerprint===emailFingerprint
  const expected=JSON.stringify(input.expectedCheckIds ?? [])
  const checkSnapshots=JSON.stringify(snapshots)
  const checkSnapshotGuard = `NOT EXISTS (SELECT 1 FROM json_each(?) snapshot WHERE NOT EXISTS (
    SELECT 1 FROM http_checks h WHERE h.id=json_extract(snapshot.value,'$.id') AND h.component_id=json_extract(snapshot.value,'$.componentId')
      AND h.config_version=json_extract(snapshot.value,'$.version') AND NOT EXISTS (SELECT 1 FROM gatus_sources g WHERE g.component_id=h.component_id)))`
  const mutation=method==='POST'
    ? statement(db,`INSERT INTO notification_channels (id,name,endpoint_id,endpoint_fingerprint,vault_id,secret_id,enabled,mutation_key,created_at,updated_at,channel_type,recipient_id,email_fingerprint)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM notification_channels)<20 AND ${checkSnapshotGuard}`,id,input.name.trim(),endpointId,fingerprint,vaultId,secretId,input.enabled?1:0,token,now,now,type,recipientId,emailFingerprint,checkSnapshots)
    : statement(db,`UPDATE notification_channels SET name=?,endpoint_id=?,endpoint_fingerprint=?,vault_id=?,secret_id=?,enabled=?,
      version=version+CASE WHEN name IS ? AND endpoint_id IS ? AND endpoint_fingerprint IS ? AND vault_id IS ? AND secret_id IS ? AND enabled IS ? AND recipient_id IS ? AND email_fingerprint IS ? THEN 0 ELSE 1 END,
      mutation_key=?,updated_at=?,recipient_id=?,email_fingerprint=?
      WHERE id=? AND version=? AND channel_type=? AND association_version=? AND ${checkSnapshotGuard}
      AND NOT EXISTS (SELECT 1 FROM notification_channel_checks WHERE channel_id=notification_channels.id AND check_id NOT IN (SELECT value FROM json_each(?)))
      AND NOT EXISTS (SELECT 1 FROM json_each(?) WHERE value NOT IN (SELECT check_id FROM notification_channel_checks WHERE channel_id=notification_channels.id))`,input.name.trim(),endpointId,fingerprint,vaultId,secretId,input.enabled?1:0,
      input.name.trim(),endpointId,fingerprint,vaultId,secretId,input.enabled?1:0,recipientId,emailFingerprint,token,now,recipientId,emailFingerprint,id,version,type,expectedAssociation,checkSnapshots,expected,expected)
  const operations:D1PreparedStatement[]=[mutation]
  if (carryQueued) {
    operations.push(statement(db,`UPDATE notification_outbox SET channel_version=? WHERE channel_id=? AND channel_version=? AND state IN ('pending','sending') AND check_id IN (SELECT value FROM json_each(?))
      AND EXISTS (SELECT 1 FROM notification_channels WHERE id=? AND version=? AND mutation_key=?)`,version+1,id,version,JSON.stringify(checks),id,version+1,token))
    operations.push(statement(db,`UPDATE notification_delivery_state SET channel_version=? WHERE channel_id=? AND channel_version=? AND check_id IN (SELECT value FROM json_each(?))
      AND EXISTS (SELECT 1 FROM notification_channels WHERE id=? AND version=? AND mutation_key=?)`,version+1,id,version,JSON.stringify(checks),id,version+1,token))
  }
  operations.push(statement(db,'DELETE FROM notification_channel_checks WHERE channel_id=? AND check_id NOT IN (SELECT value FROM json_each(?)) AND EXISTS (SELECT 1 FROM notification_channels WHERE id=? AND mutation_key=?)',id,JSON.stringify(checks),id,token))
  for (const check of checks) operations.push(statement(db,'INSERT OR IGNORE INTO notification_channel_checks (channel_id,check_id) SELECT ?,? WHERE EXISTS (SELECT 1 FROM notification_channels WHERE id=? AND mutation_key=?)',id,check,id,token))
  operations.push(audit(db,actor,method==='POST'?'create':'update',id,token))
  let results: D1Result[]
  try { results=await db.batch(operations) }
  catch (error) {
    if (error instanceof Error && error.message.includes('notification channel monitor limit reached')) return fail(409,'A channel can be assigned to at most 20 monitors. Remove an assignment before adding another.')
    throw error
  }
  if (!results[0].meta.changes) return fail(method==='POST'?409:409,method==='POST'?'Channel limit reached or a monitor changed. Reload and try again.':'Channel or monitor changed. Reload and try again.')
  return json((await list(db)).find(row=>row.id===id),method==='POST'?201:200)
}
