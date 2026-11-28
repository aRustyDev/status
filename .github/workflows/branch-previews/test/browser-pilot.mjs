// Run with node --import tsx. Access signing, Flagship values and UI assets are
// local fixtures. Requests traverse the real baseline gateway, selected gateway
// and Worker identity/role checks. Configuration is removed when the server exits.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import gatewayModule from '../../../../apps/gateway/index.ts'
import workerModule from '../../../../apps/worker/src/index.ts'
import dispatcherModule from '../../../actions/branch-previews/runtime/dispatcher.ts'

const gateway = gatewayModule.default ?? gatewayModule
const worker = workerModule.default ?? workerModule
const dispatcher = dispatcherModule.default ?? dispatcherModule
const variants = [
  { selector: 'branch-' + 'a'.repeat(24), release: 'a'.repeat(40), title: 'Compact monitor list' },
  { selector: 'branch-' + 'b'.repeat(24), release: 'b'.repeat(40), title: 'Detailed monitor cards' },
]
const clientId = 'pilot-fixture.access'
const clientSecret = 'synthetic-pilot-only'
const issuer = 'https://pilot-fixture.cloudflareaccess.com'
const audience = 'local-browser-pilot'
const keys = await generateKeyPair('RS256', { extractable: true })
const jwk = { ...await exportJWK(keys.publicKey), kid: 'fixture', use: 'sig', alg: 'RS256' }
globalThis.fetch = async url => {
  if (String(url) !== issuer + '/cdn-cgi/access/certs') throw new Error('Unexpected fixture network request')
  return Response.json({ keys: [jwk] })
}

const directory = mkdtempSync(join(tmpdir(), 'status-browser-pilot-'))
process.on('exit', () => rmSync(directory, { recursive: true, force: true }))
const keyPath = join(directory, 'server.key')
const certificatePath = join(directory, 'server.crt')
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
  '-keyout', keyPath, '-out', certificatePath], { stdio: 'ignore' })

const tls = { key: readFileSync(keyPath), cert: readFileSync(certificatePath) }
// A different loopback port is a separate origin. Both a direct image and
// a same-origin redirect must arrive without credential or routing headers.
const sink = createServer(tls, (req, res) => {
  if (['cf-access-client-id', 'cf-access-client-secret', 'x-status-preview'].some(name => req.headers[name] !== undefined)) {
    res.writeHead(403).end('Private header reached another origin')
    return
  }
  res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' })
    .end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'))
})
await new Promise(resolve => sink.listen(0, '127.0.0.1', resolve))
const sinkUrl = 'https://127.0.0.1:' + sink.address().port + '/pixel.gif'

let origin
function verifyInternalHeaders(request) {
  if (request.headers.has('CF-Access-Client-Secret') || request.headers.has('CF-Access-Client-Id')) {
    throw new Error('Access credentials reached a private binding')
  }
}
const api = { fetch(request) {
  verifyInternalHeaders(request)
  return worker.fetch(request, {
    DEPLOYMENT_ENVIRONMENT: 'staging', PREVIEW_BROWSER_ORIGIN: origin,
    PREVIEW_BROWSER_CLIENT_ID: clientId, ACCESS_AUD: audience, ACCESS_TEAM_DOMAIN: new URL(issuer).hostname,
    DB: { prepare() { throw new Error('Preview browser auth attempted to access the users database') } },
  })
} }
const dispatcherEnv = {
  PREVIEW_HEADER: 'X-Status-Preview', FLAG_PREFIX: 'status-preview-', FLAGS: {
    getBooleanDetails: () => ({ value: true }),
    getObjectDetails: key => {
      const variant = variants.find(item => key === 'status-preview-' + item.selector)
      return { value: variant && { selector: variant.selector, release: variant.release } }
    },
  },
}
const baseline = { API: api, PREVIEW_DISPATCHER: { fetch: request => dispatcher.fetch(request, dispatcherEnv) } }
for (const variant of variants) {
  const assets = { fetch(request) {
    verifyInternalHeaders(request)
    const path = new URL(request.url).pathname
    if (path === '/__pilot/redirect') return Response.redirect(sinkUrl + '?via=redirect')
    if (path === '/__pilot/network') {
      const html = `<!doctype html><title>Header isolation</title>
        <h1>Checking images</h1><img src="/__pilot/redirect"><img src="${sinkUrl}?via=direct">
        <script>onload = () => { document.querySelector('h1').textContent =
          Array.from(document.images).every(image => image.naturalWidth === 1)
            ? 'Both cross-origin requests omitted private headers' : 'Header isolation failed' }</script>`
      return new Response(html, { headers: { 'Content-Type': 'text/html' } })
    }
    return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><title>' + variant.title +
      '</title><main><h1>' + variant.title + '</h1></main></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  } }
  dispatcherEnv['PREVIEW_BRANCH_' + variant.selector.slice('branch-'.length).toUpperCase() + '_' + variant.release.toUpperCase()] = {
    fetch(request) {
      verifyInternalHeaders(request)
      return gateway.fetch(request, {
        API: api, STATUS_API: api, MONITORING_API: api, STATUS_UI: assets, PREVIEW_SELECTOR: variant.selector, PREVIEW_RELEASE: variant.release,
      })
    },
  }
}

const server = createServer(tls, async (req, res) => {
  try {
    if (req.headers['cf-access-client-id'] !== clientId || req.headers['cf-access-client-secret'] !== clientSecret) {
      res.writeHead(401).end('Local Access fixture rejected credentials')
      return
    }
    const assertion = await new SignJWT({ type: 'app', common_name: clientId }).setSubject('')
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).setAudience(audience).setIssuer(issuer)
      .setIssuedAt().setExpirationTime('2m').sign(keys.privateKey)
    const headers = new Headers(req.headers)
    headers.set('Cf-Access-Jwt-Assertion', assertion)
    const url = new URL(req.url, origin)
    if (url.origin !== origin) { res.writeHead(400).end(); return }
    const response = await gateway.fetch(new Request(url, { method: req.method, headers }), baseline)
    res.writeHead(response.status, Object.fromEntries(response.headers)).end(Buffer.from(await response.arrayBuffer()))
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Pilot failed')
    res.writeHead(500).end()
  }
})
server.listen(0, '127.0.0.1', () => {
  origin = 'https://127.0.0.1:' + server.address().port
  const configPath = join(directory, 'project.json')
  writeFileSync(configPath, JSON.stringify({
    origin, backend: 'local', auth: 'access', allowSelfSignedLoopback: true, selectorHeader: 'X-Status-Preview', revisionHeader: 'X-Status-Preview-Commit',
    identity: { path: '/api/v1/auth/me', equals: { id: 'preview-browser', role: 'viewer' } },
  }), { mode: 0o600 })
  console.log(JSON.stringify({ configPath, fixtureEnv: { CF_ACCESS_CLIENT_ID: clientId, CF_ACCESS_CLIENT_SECRET: clientSecret, PREVIEW_ACCESS_ORIGIN: origin }, variants }))
})
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  server.close()
  server.closeAllConnections()
  sink.close()
  sink.closeAllConnections()
})
