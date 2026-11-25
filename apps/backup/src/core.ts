/** Private service behind the Access-protected operations Worker. */
export type BackupEnv = {
  BACKUP_BUCKET: R2Bucket
  BACKUP_WORKFLOW: Workflow<{ id: string }>
  ACCOUNT_ID: string
  DATABASE_ID: string
  D1_EXPORT_TOKEN: string
}
const KEY = /^[a-f0-9]{64}$/
const error = (message: string, status: number) => Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } })
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })
// R2 lists keys ascending. The reversed timestamp keeps the latest jobs visible
// even when the bucket contains more than one page of backups.
const markerKey = (id: string, createdAt: number) => `jobs/${String(9_999_999_999_999 - createdAt).padStart(13, '0')}-${id}.json`
const objectKey = (id: string) => `exports/${id}.sql`
const manifestKey = (id: string) => `exports/${id}.json`
type Manifest = { id: string; createdAt: number; size: number; sha256: string }

async function manifest(env: BackupEnv, id: string): Promise<Manifest | null> {
  const object = await env.BACKUP_BUCKET.get(manifestKey(id))
  if (!object || object.size > 4096) return null
  try {
    const data = await object.json<Manifest>()
    if (data.id !== id || !Number.isSafeInteger(data.createdAt) || !Number.isSafeInteger(data.size) || data.size < 1 || !/^[a-f0-9]{64}$/.test(data.sha256)) return null
    return data
  } catch { return null }
}
async function digest(body: ReadableStream): Promise<string> {
  const sink = new crypto.DigestStream('SHA-256')
  await body.pipeTo(sink)
  return [...new Uint8Array(await sink.digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}
export async function backupService(request: Request, env: BackupEnv): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname === '/health' && request.method === 'GET') {
    // A missing object is a successful read; no backup data or job status is needed.
    try { await env.BACKUP_BUCKET.head('health-probe') }
    catch { return error('Backup service unavailable', 503) }
    return json({ status: 'ok' })
  }
  if (url.pathname === '/backups' && request.method === 'GET') {
    const cursor = url.searchParams.get('cursor')
    if (cursor !== null && (cursor.length === 0 || cursor.length > 2048)) return error('Invalid backup cursor', 400)
    const list = await env.BACKUP_BUCKET.list({ prefix: 'jobs/', limit: 20, ...(cursor ? { cursor } : {}) })
    const rows = await Promise.all(list.objects.map(async object => {
      const match = /^jobs\/(\d{13})-([a-f0-9]{64})\.json$/.exec(object.key)
      if (!match) return null
      const id = match[2]!
      const saved = await manifest(env, id)
      if (saved) {
        const stored = await env.BACKUP_BUCKET.head(objectKey(id))
        return { ...saved, state: stored?.size === saved.size ? 'complete' : 'failed' }
      }
      try {
        const status = await (await env.BACKUP_WORKFLOW.get(id)).status()
        return { id, createdAt: object.uploaded.getTime(), state: status.status === 'errored' || status.status === 'terminated' ? 'failed' : status.status === 'complete' ? 'failed' : 'running' }
      } catch { return { id, createdAt: object.uploaded.getTime(), state: 'unavailable' } }
    }))
    return json({ backups: rows.filter(row => row !== null), nextCursor: list.truncated ? list.cursor : null })
  }
  if (url.pathname === '/backups' && request.method === 'POST') {
    const id = request.headers.get('x-backup-id') ?? ''
    const stamp = request.headers.get('x-backup-created-at') ?? ''
    const createdAt = Number(stamp)
    if (!KEY.test(id) || !/^\d{13}$/.test(stamp) || !Number.isSafeInteger(createdAt) || createdAt > Date.now() + 300_000 || createdAt <= Date.now() - 86_400_000) return error('Invalid backup request', 400)
    try { await env.BACKUP_WORKFLOW.create({ id, params: { id } }) }
    catch {
      try { await (await env.BACKUP_WORKFLOW.get(id)).status() }
      catch { return error('Could not start backup', 503) }
    }
    await env.BACKUP_BUCKET.put(markerKey(id, createdAt), JSON.stringify({ id }), { httpMetadata: { contentType: 'application/json' } })
    return json({ id }, 202)
  }
  const match = /^\/backups\/([a-f0-9]{64})\/(verify|download)$/.exec(url.pathname)
  if (!match || request.method !== 'GET') return error('Not found', 404)
  const [, id, action] = match
  const data = await manifest(env, id!)
  if (!data) return error('Backup is not available', 404)
  const object = await env.BACKUP_BUCKET.get(objectKey(id!))
  if (!object || object.size !== data.size) return error('Backup integrity check failed', 409)
  if (action === 'verify') {
    if (await digest(object.body) !== data.sha256) return error('Backup integrity check failed', 409)
    return json({ valid: true, createdAt: data.createdAt, size: data.size })
  }
  return new Response(object.body, { headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/sql', 'Content-Disposition': `attachment; filename="status-backup-${id}.sql"`, 'X-Content-Type-Options': 'nosniff' } })
}

export async function beginExport(env: BackupEnv): Promise<string> {
  let response: Response
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/d1/database/${env.DATABASE_ID}/export`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.D1_EXPORT_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ output_format: 'polling' }),
    })
  } catch { throw new Error('D1 export could not be started') }
  if (!response.ok) throw new Error('D1 export could not be started')
  let body: { success?: boolean; result?: { at_bookmark?: unknown } }
  try { body = await response.json() as typeof body } catch { throw new Error('D1 export could not be started') }
  if (!body.success || typeof body.result?.at_bookmark !== 'string' || !body.result.at_bookmark) throw new Error('D1 export could not be started')
  return body.result.at_bookmark
}
export async function finishExport(env: BackupEnv, id: string, bookmark: string): Promise<void> {
  if (!KEY.test(id)) throw new Error('Invalid backup identifier')
  let response: Response
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/d1/database/${env.DATABASE_ID}/export`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.D1_EXPORT_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ output_format: 'polling', current_bookmark: bookmark }),
    })
  } catch { throw new Error('D1 export is unavailable') }
  if (!response.ok) throw new Error('D1 export is unavailable')
  let result: { success?: boolean; result?: { signed_url?: unknown; result?: { signed_url?: unknown } } }
  try { result = await response.json() as typeof result } catch { throw new Error('D1 export is unavailable') }
  const signedUrl = result.result?.result?.signed_url ?? result.result?.signed_url
  if (!result.success || typeof signedUrl !== 'string') throw new Error('D1 export is not ready')
  let signed: URL
  try { signed = new URL(signedUrl) }
  catch { throw new Error('Invalid export download') }
  if (signed.protocol !== 'https:' || signed.username || signed.password) throw new Error('Invalid export download')
  let download: Response
  try { download = await fetch(signed.toString(), { redirect: 'manual' }) }
  catch { throw new Error('D1 export download failed') }
  if (!download.ok || !download.body) throw new Error('D1 export download failed')
  const saved = await env.BACKUP_BUCKET.put(objectKey(id), download.body, { httpMetadata: { contentType: 'application/sql' } })
  if (!saved || !saved.size) throw new Error('Empty backup')
  const stored = await env.BACKUP_BUCKET.get(objectKey(id))
  if (!stored || stored.size !== saved.size) throw new Error('Backup storage verification failed')
  const sha256 = await digest(stored.body)
  const data: Manifest = { id, createdAt: Date.now(), size: saved.size, sha256 }
  await env.BACKUP_BUCKET.put(manifestKey(id), JSON.stringify(data), { httpMetadata: { contentType: 'application/json' } })
}
