import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPair, SignJWT, jwtVerify } from 'jose'
import { handleForward } from './core.ts'

const origin = 'http://private-proof.woven', issuer = 'https://example.cloudflareaccess.com', audience = 'pilot-aud'
const { privateKey, publicKey } = await generateKeyPair('RS256')
const sign = (email: string, exp = Math.floor(Date.now() / 1000) + 60) => new SignJWT({ email }).setProtectedHeader({ alg: 'RS256' }).setIssuer(issuer).setAudience(audience).setSubject('subject').setExpirationTime(exp).sign(privateKey)
const jwt = await sign('pilot@example.com')
const verify = async (token: string, iss: string, aud: string) => (await jwtVerify(token, publicKey, { issuer: iss, audience: aud, requiredClaims: ['exp', 'sub', 'email'] })).payload
const identity = { identity: async () => ({ email: 'pilot@example.com' }) }
let calls: Request[] = []
const env = { PRIVATE_ORIGIN: origin, ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com', ACCESS_AUD: audience, FALLBACK: { async fetch(request: Request) { calls.push(request); return Response.json({ ok: true }) } } }
const next = async () => new Response('access', { status: 209 })
const run = (path: string, init: RequestInit = {}, ctx = identity) => handleForward(new Request(origin + path, init), ctx, next, env, verify)

test('verified JWT and Gateway identity reach the service without spoofed identity headers or cookies', async () => {
  calls = []
  const response = await run('/api/edit?q=1', { method: 'POST', headers: { Origin: origin, Cookie: `CF_Authorization=${jwt}; app=1`, 'Cf-Access-Jwt-Assertion': 'forged.invalid.token', 'X-Forwarded-Host': 'bad', 'X-Private-Bridge-Key': 'bad', Forwarded: 'bad' }, body: '{}' })
  assert.equal(response.status, 200); assert.equal(calls.length, 1)
  const sent = calls[0]!; assert.equal(sent.url, origin + '/api/edit?q=1'); assert.equal(sent.headers.get('Origin'), origin); assert.equal(sent.headers.get('Cf-Access-Jwt-Assertion'), jwt); assert.equal(sent.headers.get('Cookie'), 'app=1'); assert.equal(sent.headers.get('X-Forwarded-Host'), null); assert.equal(sent.headers.get('X-Private-Bridge-Key'), null); assert.equal(sent.headers.get('Forwarded'), null)
})
test('missing, forged, expired and mismatched identity fail closed', async () => {
  calls = []
  for (const token of ['', 'forged.invalid.token', await sign('pilot@example.com', Math.floor(Date.now() / 1000) - 60), await sign('other@example.com')]) {
    assert.equal((await run('/api', { headers: token ? { Cookie: `CF_Authorization=${token}` } : {} })).status, 401)
  }
  assert.equal((await run('/api', { headers: { Cookie: `CF_Authorization=${jwt}` } }, { identity: async () => ({ email: '' }) })).status, 401)
  assert.equal((await run('/__fallback/snapshot.json', {}, { identity: async () => null })).status, 401)
  assert.equal(calls.length, 0)
})
test('mutations require the original exact Origin', async () => {
  for (const o of ['', 'http://attacker.woven', 'null']) assert.equal((await run('/api', { method: 'POST', headers: { Cookie: `CF_Authorization=${jwt}`, ...(o ? { Origin: o } : {}) }, body: '{}' })).status, 403)
  assert.equal((await run('/api', { method: 'POST', headers: { Cookie: `CF_Authorization=${jwt}`, Origin: origin }, body: '{}' })).status, 200)
})
test('only safe Access login/logout requests continue to origin', async () => {
  assert.equal((await run('/cdn-cgi/access/login')).status, 209)
  assert.equal((await run('/cdn-cgi/access/logout')).status, 209)
  assert.equal((await run('/cdn-cgi/access/login', { method: 'POST' })).status, 405)
  assert.equal((await run('/cdn-cgi/other')).status, 404)
})
test('HEAD responses have no body even for rejected requests', async () => {
  const response = await run('/api', { method: 'HEAD' })
  assert.equal(response.status, 401)
  assert.equal(response.body, null)
})
test('expired document navigation goes only to the local Access login while API requests return 401', async () => {
  const navigation = await run('/', { headers: { Accept: 'text/html' } }, { identity: async () => null })
  assert.equal(navigation.status, 302)
  assert.equal(navigation.headers.get('location'), '/cdn-cgi/access/login')
  const invalid = await run('/', { headers: { Accept: 'text/html', Cookie: 'CF_Authorization=forged.invalid.token' } })
  assert.equal(invalid.status, 302)
  assert.equal(invalid.headers.get('location'), '/cdn-cgi/access/login')
  assert.equal((await run('/__fallback/snapshot.json', { headers: { Accept: 'application/json' } }, { identity: async () => null })).status, 401)
})
test('request bodies are bounded and do not reach the binding on overflow', async () => {
  calls = []; assert.equal((await run('/api', { method: 'POST', headers: { Cookie: `CF_Authorization=${jwt}`, Origin: origin }, body: 'x'.repeat(1_048_577) })).status, 413); assert.equal(calls.length, 0)
})

test('stalled request and response streams time out and are cancelled', async () => {
  let cancelled = 0
  const slow = () => new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}) }, cancel() { cancelled++ } })
  const req = new Request(origin + '/api', { method: 'POST', headers: { Origin: origin, Cookie: `CF_Authorization=${jwt}` }, body: slow(), duplex: 'half' } as RequestInit)
  assert.equal((await handleForward(req, identity, next, env, verify, 20)).status, 504)
  const slowEnv = { ...env, FALLBACK: { async fetch() { return new Response(slow()) } } }
  const response = await handleForward(new Request(origin + '/api', { headers: { Cookie: `CF_Authorization=${jwt}` } }), identity, next, slowEnv, verify, 20)
  assert.equal(response.status, 200)
  await assert.rejects(response.text(), /deadline exceeded/)
  assert.equal(cancelled, 2)
})

test('response bodies larger than 8 MiB stream without truncation', async () => {
  const chunk = new Uint8Array(1_048_576).fill(42)
  let sent = 0
  const streamingEnv = { ...env, FALLBACK: { async fetch() { return new Response(new ReadableStream<Uint8Array>({ pull(controller) { if (sent++ === 9) controller.close(); else controller.enqueue(chunk) } })) } } }
  const response = await handleForward(new Request(origin + '/asset', { headers: { Cookie: `CF_Authorization=${jwt}` } }), identity, next, streamingEnv, verify)
  assert.equal(response.status, 200)
  assert.equal((await response.arrayBuffer()).byteLength, 9 * 1_048_576)
})
test('an active response can continue beyond the request deadline', async () => {
  let sent = 0
  const streamingEnv = { ...env, FALLBACK: { async fetch() { return new Response(new ReadableStream<Uint8Array>({ async pull(controller) { await new Promise(resolve => setTimeout(resolve, 50)); if (sent++ === 3) controller.close(); else controller.enqueue(new Uint8Array([42])) } })) } } }
  const response = await handleForward(new Request(origin + '/asset', { headers: { Cookie: `CF_Authorization=${jwt}` } }), identity, next, streamingEnv, verify, 150)
  assert.equal((await response.arrayBuffer()).byteLength, 3)
})

test('whole deadline bounds identity and ignores its late result', async () => {
  calls = []
  let finish!: (value: { email: string }) => void
  const pending = new Promise<{ email: string }>(resolve => { finish = resolve })
  const r = await handleForward(new Request(origin + '/api', { headers: { Cookie: `CF_Authorization=${jwt}` } }), { identity: () => pending }, next, env, verify, 20)
  assert.equal(r.status, 504); finish({ email: 'pilot@example.com' }); await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(calls.length, 0)
})
test('key-service timeout cancels verification; service faults are not mistaken for bad credentials', async () => {
  let aborted = false
  const hanging = async (_token: string, _issuer: string, _aud: string, signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) }, { once: true }))
  const req = () => new Request(origin + '/api', { headers: { Cookie: `CF_Authorization=${jwt}` } })
  assert.equal((await handleForward(req(), identity, next, env, hanging, 20)).status, 504); assert.equal(aborted, true)
  assert.equal((await handleForward(req(), identity, next, env, async () => { throw new TypeError('network unavailable') }, 20)).status, 503)
  assert.equal((await handleForward(req(), { identity: async () => { throw new Error('context unavailable') } }, next, env, verify, 20)).status, 503)
  assert.equal((await handleForward(req(), identity, next, env, async () => { const error = new Error('JWKS timed out') as Error & {code: string}; error.code = 'ERR_JWKS_TIMEOUT'; throw error }, 20)).status, 504)
})
test('Access continuation and its body are bounded and cancelled on deadline', async () => {
  let aborted = false, bodyCancelled = false
  const hangingNext = async (request: Request) => new Promise<Response>((_, reject) => request.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) }, { once: true }))
  assert.equal((await handleForward(new Request(origin + '/cdn-cgi/access/logout'), identity, hangingNext, env, verify, 20)).status, 504); assert.equal(aborted, true)
  const slowNext = async () => new Response(new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}) }, cancel() { bodyCancelled = true } }))
  const response = await handleForward(new Request(origin + '/cdn-cgi/access/login'), identity, slowNext, env, verify, 20)
  assert.equal(response.status, 200)
  await assert.rejects(response.text(), /deadline exceeded/)
  assert.equal(bodyCancelled, true)
  assert.equal((await run('/cdn-cgi/access/login/anything')).status, 404)
})
test('binding faults return 503 and stalled binding receives abort on deadline', async () => {
  const req = () => new Request(origin + '/api', { headers: { Cookie: `CF_Authorization=${jwt}` } })
  assert.equal((await handleForward(req(), identity, next, { ...env, FALLBACK: { async fetch() { throw new Error('unavailable') } } }, verify, 20)).status, 503)
  let aborted = false
  const hangingEnv = { ...env, FALLBACK: { async fetch(request: Request) { return new Promise<Response>((_, reject) => request.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) }, { once: true })) } } }
  assert.equal((await handleForward(req(), identity, next, hangingEnv, verify, 20)).status, 504); assert.equal(aborted, true)
})

test('client cancellation aborts an in-flight key lookup', async () => {
  const controller = new AbortController(); let observed = false
  const hanging = async (_token: string, _issuer: string, _aud: string, signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener('abort', () => { observed = true; reject(new Error('aborted')) }, { once: true }))
  const request = new Request(origin + '/api', { headers: { Cookie: `CF_Authorization=${jwt}` }, signal: controller.signal })
  const pending = handleForward(request, identity, next, env, hanging, 1000)
  await new Promise(resolve => setTimeout(resolve, 5)); controller.abort()
  assert.equal((await pending).status, 504); assert.equal(observed, true)
})
