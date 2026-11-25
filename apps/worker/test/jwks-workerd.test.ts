import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

test('concurrent Access verification in workerd keeps requests isolated and reuses warm keys', async () => {
  const keys = await generateKeyPair('RS256', { extractable: true })
  const jwk = { ...await exportJWK(keys.publicKey), kid: 'key', alg: 'RS256', use: 'sig' }
  const issuer = 'https://workerd-test.cloudflareaccess.com'
  const jwt = await new SignJWT({ email: 'test@example.com' }).setProtectedHeader({ alg: 'RS256', kid: 'key' })
    .setIssuer(issuer).setAudience('test-aud').setSubject('test-sub').setIssuedAt().setExpirationTime('5m').sign(keys.privateKey)
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))], bundle: true,
    format: 'esm', platform: 'browser', conditions: ['workerd', 'worker', 'browser'], write: false })
  let keyFetches = 0
  const miniflare = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text, d1Databases: ['DB'],
    bindings: { ACCESS_TEAM_DOMAIN: 'workerd-test.cloudflareaccess.com', ACCESS_AUD: 'test-aud', ENDPOINTS: '[]' },
    outboundService: async request => {
      assert.equal(request.url, `${issuer}/cdn-cgi/access/certs`)
      keyFetches++
      // Force overlapping cold requests to exercise workerd's I/O isolation.
      await new Promise(resolve => setTimeout(resolve, 50))
      return Response.json({ keys: [jwk] })
    },
  }))
  try {
    const db = await miniflare.getD1Database('DB')
    const sql = readFileSync(new URL('../migrations/0001_board.sql', import.meta.url), 'utf8')
    await db.batch(sql.split(';').map(value => value.trim()).filter(Boolean).map(value => db.prepare(value)))
    const request = () => miniflare.dispatchFetch('https://status.example/api/v1/auth/me', { headers: { 'Cf-Access-Jwt-Assertion': jwt } })
    // Consume each response as it arrives rather than holding streams open
    // while the remaining concurrent requests finish.
    const concurrent = await Promise.all(Array.from({ length: 12 }, async () => {
      const response = await request()
      return { status: response.status, body: await response.text() }
    }))
    for (const response of concurrent) assert.equal(response.status, 200, response.body)
    const coldFetches = keyFetches
    assert.ok(coldFetches > 0)
    const warm = await request()
    assert.equal(warm.status, 200, await warm.text())
    assert.equal(keyFetches, coldFetches)
  } finally { await miniflare.dispose() }
})
