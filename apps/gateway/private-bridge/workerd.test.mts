import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

test('named GatewayMiddleware executes in workerd and fails closed on forged assertions', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' }
  const token = await new SignJWT({ email: 'pilot@example.com' }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer('https://example.cloudflareaccess.com').setAudience('aud').setSubject('subject').setExpirationTime('2m').sign(privateKey)
  const bundle = await build({ stdin: {
    contents: `import { GatewayMiddleware } from './worker.ts';
      let fetches = 0; globalThis.fetch = async () => { fetches++; return Response.json({ keys: [${JSON.stringify(jwk)}] }); };
      export default { fetch(request, env, ctx) {
        if (new URL(request.url).pathname === '/test-fetch-count') return Response.json({ fetches });
        const gateway = { async fetch(req) { return Response.json({assertionPresent: !!req.headers.get('Cf-Access-Jwt-Assertion'), origin: req.headers.get('Origin')}); } };
        const instance = new GatewayMiddleware(ctx, { PRIVATE_ORIGIN: 'http://private-proof.woven', ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com', ACCESS_AUD: 'aud', FALLBACK: gateway });
        return instance.handle(request, { async identity() { return { email: 'pilot@example.com' } } }, async () => new Response('continued', {status: 209}));
      } };`,
    resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'entry-test.ts', loader: 'ts',
  }, bundle: true, format: 'esm', platform: 'browser', external: ['cloudflare:workers'], conditions: ['workerd', 'worker', 'browser'], write: false })
  const mf = new Miniflare(convertV4MiniflareOptions({ compatibilityDate: '2026-11-25', modules: true, script: bundle.outputFiles[0].text }))
  try {
    assert.equal((await mf.dispatchFetch('http://private-proof.woven/api', { headers: { Cookie: 'CF_Authorization=forged.invalid.token' } })).status, 401)
    const accepted = await mf.dispatchFetch('http://private-proof.woven/api', { method:'POST', headers:{ Cookie: 'CF_Authorization='+token, Origin:'http://private-proof.woven' },body:'{}' })
    assert.equal(accepted.status, 200); assert.deepEqual(await accepted.json(), {assertionPresent:true, origin:'http://private-proof.woven'})
    assert.equal((await mf.dispatchFetch('http://private-proof.woven/api', { headers:{ Cookie: 'CF_Authorization='+token } })).status, 200)
    assert.deepEqual(await (await mf.dispatchFetch('http://private-proof.woven/test-fetch-count')).json(), {fetches:1})
    assert.equal((await mf.dispatchFetch('http://private-proof.woven/cdn-cgi/access/login')).status, 209)
    assert.equal((await mf.dispatchFetch('http://private-proof.woven/api', { method: 'POST', headers: { Origin: 'http://bad.woven' }, body: '{}' })).status, 403)
  } finally { await mf.dispose() }
})

test('real workerd entrypoint cancels an unavailable JWKS request and reports timeout', async () => {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true })
  const token = await new SignJWT({ email: 'pilot@example.com' }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer('https://example.cloudflareaccess.com').setAudience('aud').setSubject('subject').setExpirationTime('2m').sign(privateKey)
  const bundle = await build({ stdin: {
    contents: `import { GatewayMiddleware } from './worker.ts';
      let aborted = false;
      globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('timeout', 'TimeoutError')); }, { once: true }));
      export default { fetch(request, env, ctx) {
        if (new URL(request.url).pathname === '/test-state') return Response.json({ aborted });
        const instance = new GatewayMiddleware(ctx, { PRIVATE_ORIGIN: 'http://private-proof.woven', ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com', ACCESS_AUD: 'aud', FALLBACK: { async fetch() { return new Response('unexpected'); } } });
        return instance.handle(request, { async identity() { return { email: 'pilot@example.com' } } }, async () => new Response('unexpected'));
      } };`,
    resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'timeout-test.ts', loader: 'ts',
  }, bundle: true, format: 'esm', platform: 'browser', external: ['cloudflare:workers'], conditions: ['workerd', 'worker', 'browser'], write: false })
  const mf = new Miniflare(convertV4MiniflareOptions({ compatibilityDate: '2026-11-25', modules: true, script: bundle.outputFiles[0].text }))
  try {
    const response = await mf.dispatchFetch('http://private-proof.woven/api', { headers: { Cookie: `CF_Authorization=${token}` } })
    assert.equal(response.status, 504)
    assert.deepEqual(await (await mf.dispatchFetch('http://private-proof.woven/test-state')).json(), { aborted: true })
  } finally { await mf.dispose() }
})

test('private Forward sends a verified assertion through the fallback reader and assets', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
  const jwk = { ...(await exportJWK(publicKey)), kid: 'fallback-key', alg: 'RS256', use: 'sig' }
  const token = await new SignJWT({ email: 'pilot@example.com' }).setProtectedHeader({ alg: 'RS256', kid: 'fallback-key' }).setIssuer('https://example.cloudflareaccess.com').setAudience('aud').setSubject('subject').setExpirationTime('2m').sign(privateKey)
  const bundle = await build({ stdin: {
    contents: `import { GatewayMiddleware } from './worker.ts';
      import fallback from '../../fallback/index.ts';
      globalThis.fetch = async () => Response.json({ keys: [${JSON.stringify(jwk)}] });
      const fallbackEnv = {
        ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com', ACCESS_AUD: 'aud',
        GATEWAY: { async fetch() { return new Response('offline', {status: 503}); } },
        FALLBACK_BUCKET: { async get() { return { async json() { return {enabled: true, snapshot: {schemaVersion: 1, generatedAt: 1234}}; } }; } },
        ASSETS: { async fetch(req) { return new URL(req.url).pathname === '/' ? new Response('<html><head></head><body>saved page</body></html>') : new Response('saved asset'); } }
      };
      export default { fetch(request, env, ctx) {
        const instance = new GatewayMiddleware(ctx, { PRIVATE_ORIGIN: 'http://private-proof.woven', ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com', ACCESS_AUD: 'aud', FALLBACK: { fetch(req) { return fallback.fetch(req, fallbackEnv); } } });
        return instance.handle(request, { async identity() { return { email: 'pilot@example.com' } } }, async () => new Response('continued', {status: 209}));
      } };`,
    resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'fallback-test.ts', loader: 'ts',
  }, bundle: true, format: 'esm', platform: 'browser', external: ['cloudflare:workers'], conditions: ['workerd', 'worker', 'browser'], write: false })
  const mf = new Miniflare(convertV4MiniflareOptions({ compatibilityDate: '2026-11-25', modules: true, script: bundle.outputFiles[0].text }))
  try {
    const headers = { Cookie: `CF_Authorization=${token}`, Accept: 'text/html' }
    const html = await mf.dispatchFetch('http://private-proof.woven/', { headers })
    assert.equal(html.status, 200)
    assert.match(await html.text(), /bsp-snapshot.*__fallback\/snapshot\.json/)
    const snapshot = await mf.dispatchFetch('http://private-proof.woven/__fallback/snapshot.json', { headers })
    assert.deepEqual(await snapshot.json(), { schemaVersion: 1, generatedAt: 1234 })
    const asset = await mf.dispatchFetch('http://private-proof.woven/__fallback/assets/site.js', { headers })
    assert.equal(await asset.text(), 'saved asset')
    assert.equal((await mf.dispatchFetch('http://private-proof.woven/__fallback/snapshot.json')).status, 401)
  } finally { await mf.dispose() }
})
