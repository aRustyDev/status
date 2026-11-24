import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { backupService, beginExport, finishExport, type BackupEnv } from '../src/core.ts'

class Digest extends WritableStream<Uint8Array> {
  readonly digest: Promise<ArrayBuffer>
  constructor() {
    const hash = createHash('sha256')
    let resolve!: (value: ArrayBuffer) => void
    const result = new Promise<ArrayBuffer>(r => { resolve = r })
    super({ write(chunk) { hash.update(chunk) }, close() { const result = hash.digest(); resolve(result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength) as ArrayBuffer) } })
    this.digest = result
  }
}
Object.defineProperty(crypto, 'DigestStream', { value: Digest, configurable: true })
const originalFetch = globalThis.fetch
after(() => { globalThis.fetch = originalFetch; Reflect.deleteProperty(crypto, 'DigestStream') })
class Bucket {
  objects = new Map<string, Uint8Array>()
  async put(key: string, body: string | ReadableStream) {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(await new Response(body).arrayBuffer())
    this.objects.set(key, bytes)
    return { key, size: bytes.length }
  }
  async get(key: string) {
    const bytes = this.objects.get(key)
    if (!bytes) return null
    return { size: bytes.length, body: new Response(bytes).body!, json: async () => JSON.parse(new TextDecoder().decode(bytes)) }
  }
  async head(key: string) { const bytes = this.objects.get(key); return bytes ? { size: bytes.length } : null }
  async list(options: { limit: number; cursor?: string }) {
    const keys = [...this.objects.keys()].filter(key => key.startsWith('jobs/')).sort()
    const offset = Number(options.cursor ?? 0), end = offset + options.limit
    return { objects: keys.slice(offset, end).map(key => ({ key, uploaded: new Date(1000) })), truncated: keys.length > end, cursor: String(end) }
  }
}
class Workflows {
  ids = new Set<string>()
  async create(options: {id:string}) { if (this.ids.has(options.id)) throw new Error('exists'); this.ids.add(options.id) }
  async get(id:string) { if (!this.ids.has(id)) throw new Error('missing'); return { status: async () => ({ status: 'running' }) } }
}
const id = 'a'.repeat(64)
function fixture() {
  const bucket = new Bucket(), workflows = new Workflows()
  const env = { BACKUP_BUCKET: bucket, BACKUP_WORKFLOW: workflows, ACCOUNT_ID: 'account', DATABASE_ID: 'db', D1_EXPORT_TOKEN: 'private-token' } as unknown as BackupEnv
  return { bucket, workflows, env }
}
const createdAt = String(Date.now())
function request(path: string, method = 'GET', backupId = id) { return new Request(`https://backup.internal${path}`, { method, headers: { 'x-backup-id': backupId, 'x-backup-created-at': createdAt } }) }

test('starts one idempotent job and lists its running state', async () => {
  const { env, workflows } = fixture()
  assert.equal((await backupService(request('/backups', 'POST', 'invalid'), env)).status, 400)
  assert.equal((await backupService(request('/backups', 'POST'), env)).status, 202)
  assert.equal((await backupService(request('/backups', 'POST'), env)).status, 202)
  assert.equal(workflows.ids.size, 1)
  const page = await (await backupService(request('/backups'), env)).json() as {backups:Array<{id:string;state:string}>}
  assert.deepEqual(page.backups.map(item => [item.id,item.state]), [[id,'running']])
})

test('paginates jobs in request order when more than one page exists', async () => {
  const { env, bucket, workflows } = fixture()
  for (let i = 0; i < 101; i++) {
    const jobId = i.toString(16).padStart(64, '0')
    workflows.ids.add(jobId)
    const reverse = String(9_999_999_999_999 - (Number(createdAt) - i * 1000)).padStart(13, '0')
    await bucket.put(`jobs/${reverse}-${jobId}.json`, '{}')
  }
  const page = await (await backupService(request('/backups'), env)).json() as {backups:Array<{id:string}>;nextCursor:string}
  assert.equal(page.nextCursor, '20')
  assert.equal(page.backups.length, 20)
  assert.ok(page.backups.some(item => item.id === '0'.repeat(64)))
  const next = await (await backupService(request(`/backups?cursor=${page.nextCursor}`), env)).json() as {backups:Array<{id:string}>}
  assert.ok(next.backups.some(item => item.id === (20).toString(16).padStart(64, '0')))
  assert.ok(!next.backups.some(item => item.id === '0'.repeat(64)))
})

test('exports, stores, verifies, and detects corruption without leaking credentials', async () => {
  const { env, bucket } = fixture()
  let polls = 0
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith('https://api.cloudflare.com/')) {
      assert.equal((init?.headers as Record<string,string>).Authorization, 'Bearer private-token')
      const body = JSON.parse(String(init?.body)) as {output_format?:string;current_bookmark?:string}
      if (!body.current_bookmark) return Response.json({ success: true, result: { at_bookmark: 'checkpoint' } })
      assert.equal(body.current_bookmark, 'checkpoint')
      if (polls++ === 0) return Response.json({ success: true, result: {} })
      return Response.json({ success: true, result: { signed_url: 'https://download.example/backup.sql?secret=never-log' } })
    }
    assert.equal(init?.redirect, 'error')
    assert.equal(init?.headers, undefined)
    return new Response('CREATE TABLE example (id INTEGER); INSERT INTO example VALUES (1);')
  }
  const checkpoint = await beginExport(env)
  await backupService(request('/backups', 'POST'), env)
  await assert.rejects(finishExport(env,id,checkpoint), /not ready/)
  await finishExport(env,id,checkpoint)
  assert.equal((await backupService(request(`/backups/${id}/verify`),env)).status, 200)
  const page = await (await backupService(request('/backups'),env)).json() as {backups:Array<{state:string}>}
  assert.equal(page.backups[0]?.state, 'complete')
  const download = await backupService(request(`/backups/${id}/download`),env)
  assert.equal(download.status, 200)
  const sql = await download.text()
  const isolated = new DatabaseSync(':memory:')
  try { isolated.exec(sql); assert.equal(isolated.prepare('SELECT id FROM example').get()?.['id'], 1) }
  finally { isolated.close() }
  assert.doesNotMatch(JSON.stringify([...bucket.objects.keys()]), /private-token|never-log/)
  bucket.objects.set(`exports/${id}.sql`, new TextEncoder().encode('x'.repeat((await bucket.get(`exports/${id}.sql`))!.size)))
  assert.equal((await backupService(request(`/backups/${id}/verify`),env)).status, 409)
  bucket.objects.delete(`exports/${id}.sql`)
  const missing = await (await backupService(request('/backups'),env)).json() as {backups:Array<{state:string}>}
  assert.equal(missing.backups[0]?.state, 'failed')
})

test('fails closed on an unavailable export and malformed backup identifiers', async () => {
  const { env } = fixture()
  globalThis.fetch = async () => Response.json({ success: false, errors: [{ message: 'private-token' }] }, { status: 403 })
  await assert.rejects(beginExport(env), error => error instanceof Error && !error.message.includes('private-token'))
  assert.equal((await backupService(request('/backups/../../download'),env)).status, 404)
  globalThis.fetch = async () => { throw new Error('private-token in network exception') }
  await assert.rejects(beginExport(env), error => error instanceof Error && error.message === 'D1 export could not be started')
  globalThis.fetch = async () => new Response('private-token in malformed JSON')
  await assert.rejects(finishExport(env,id,'checkpoint'), error => error instanceof Error && error.message === 'D1 export is unavailable')
})
