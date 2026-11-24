import { test, expect } from '@playwright/test'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

// Exercise the production Worker and built frontend together in workerd. The
// only simulated Access behavior is a locally signed assertion and local JWKS.
test('signed-in operator publishes an incident through the real Worker and D1', async ({ page }) => {
  const issuer = 'https://test.cloudflareaccess.com'
  const audience = 'status-test'
  const keys = await generateKeyPair('RS256', { extractable: true })
  const jwk = { ...await exportJWK(keys.publicKey), kid: 'browser-test', alg: 'RS256', use: 'sig' }
  const token = await new SignJWT({ email: 'operator@example.com' }).setProtectedHeader({ alg: 'RS256', kid: 'browser-test' })
    .setIssuer(issuer).setAudience(audience).setSubject('browser-operator').setIssuedAt().setExpirationTime('5m').sign(keys.privateKey)
  const viewerToken = await new SignJWT({ email: 'viewer@example.com' }).setProtectedHeader({ alg: 'RS256', kid: 'browser-test' })
    .setIssuer(issuer).setAudience(audience).setSubject('browser-viewer').setIssuedAt().setExpirationTime('5m').sign(keys.privateKey)
  const output = await build({ entryPoints: [resolve('../worker/src/index.ts')], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' })
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: output.outputFiles[0]!.text,
    compatibilityDate: '2026-11-22',
    d1Databases: ['DB'],
    bindings: { ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com', ACCESS_AUD: audience, ENDPOINTS: '[]' },
    outboundService: async (request: Request) => {
      if (request.url !== `${issuer}/cdn-cgi/access/certs`) return new Response('Unexpected external request', { status: 403 })
      return Response.json({ keys: [jwk] })
    },
    serviceBindings: { ASSETS: async (request: Request) => {
      const pathname = new URL(request.url).pathname
      const file = pathname.startsWith('/assets/') ? pathname.slice(1) : 'index.html'
      const contentType = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html'
      return new Response(await readFile(resolve('dist', file)), { headers: { 'content-type': contentType } })
    } },
  }))
  try {
    const db = await mf.getD1Database('DB')
    for (const file of (await readdir(resolve('../worker/migrations'))).filter(name => name.endsWith('.sql')).sort()) {
      const sql = await readFile(resolve('../worker/migrations', file), 'utf8')
      const parts = sql.replace(/^\s*--.*$/gm, '').split(/(?=CREATE TRIGGER )/)
      const statements = parts.shift()!.split(';').map(value => value.trim()).filter(Boolean)
      statements.push(...parts.map(value => value.trim()).filter(Boolean))
      await db.batch(statements.map(statement => db.prepare(statement)))
    }
    await db.prepare('INSERT INTO components (id,name,position,manual_status,updated_at) VALUES (?,?,?,?,?)').bind('api', 'API', 0, 'operational', Date.now()).run()
    const withoutAssertion = await mf.dispatchFetch('http://board.test/api/v1/auth/me')
    expect(withoutAssertion.status).toBe(401)
    const login = await mf.dispatchFetch('http://board.test/api/v1/auth/me', { headers: { 'cf-access-jwt-assertion': token } })
    expect(login.status).toBe(200)
    await db.prepare("UPDATE users SET role='operator' WHERE subject='browser-operator'").run()
    let currentToken = viewerToken
    await page.route('http://board.test/**', async route => {
      const request = route.request()
      const headers = { ...request.headers(), 'cf-access-jwt-assertion': currentToken }
      const response = await mf.dispatchFetch(request.url(), { method: request.method(), headers, body: request.postDataBuffer() ?? undefined })
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) })
    })
    const restricted = await page.goto('/admin')
    expect(restricted?.status()).toBe(403)
    await expect(page.getByText('Insufficient role')).toBeVisible()
    await page.goto('/')
    await expect(page.getByRole('link', { name: 'Manage' })).toHaveCount(0)
    currentToken = token
    await page.goto('/admin')
    await expect(page.getByRole('heading', { name: 'Manage status' })).toBeVisible()
    await page.getByText('New incident', { exact: true }).click()
    const form = page.locator('details').filter({ hasText: 'New incident' })
    await form.getByLabel('Title').fill('API latency')
    await form.getByLabel('Opening update').fill('Investigating slow requests')
    await form.getByRole('checkbox', { name: 'API' }).check()
    await form.getByRole('button', { name: 'Create draft' }).click()
    await expect(page.getByText('Draft created.')).toBeVisible()
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'API latency' })).toHaveCount(0)
    await page.goto('/admin')
    await page.getByRole('button', { name: 'Publish', exact: true }).click()
    await expect(page.getByText('Incident published.')).toBeVisible()
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'API latency' })).toBeVisible()
    await expect(page.getByText('Investigating slow requests')).toBeVisible()
    await expect(page.getByText('degraded', { exact: true })).toBeVisible()
    await page.goto('/admin')
    const maintenance = page.getByRole('heading', { name: 'Maintenance', exact: true }).locator('..')
    await maintenance.getByLabel('Title').fill('Database upgrade')
    await maintenance.getByLabel('Description').fill('Brief interruption expected')
    await maintenance.getByLabel('Starts').fill('2030-06-01T12:00')
    await maintenance.getByLabel('Ends').fill('2030-06-01T13:00')
    await maintenance.getByRole('checkbox', { name: 'API' }).check()
    await maintenance.getByRole('button', { name: 'Schedule maintenance' }).click()
    await expect(page.getByText('Maintenance scheduled.')).toBeVisible()
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Database upgrade' })).toBeVisible()
  } finally {
    await mf.dispose()
  }
})
