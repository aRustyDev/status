import assert from 'node:assert/strict'
import test from 'node:test'
import { startBrowser } from './provider.mjs'

const sessionId = '930dfc1a-e1e2-4835-bd3a-b8bc2c329346'
const account = 'a'.repeat(32)
const liveUrl = 'https://live.browser.run/ui/view?fixture'
const base = `https://api.cloudflare.com/client/v4/accounts/${account}/browser-run/devtools`

function setEnv(t, key, value) {
  const original = process.env[key]
  t.after(() => {
    if (original === undefined) delete process.env[key]
    else process.env[key] = original
  })
  process.env[key] = value
}

function remote(t, handle) {
  setEnv(t, 'BROWSER_RUN_ACCOUNT_ID', account)
  setEnv(t, 'BROWSER_RUN_API_TOKEN', 'fixture')
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer fixture')
    assert.equal(options.redirect, 'error')
    assert.ok(url.startsWith(base + '/'))
    const path = url.slice(base.length)
    const body = options.body && JSON.parse(options.body)
    calls.push([options.method, path, body])
    const response = await handle(options.method, path, body)
    return response instanceof Response ? response : Response.json(response)
  })
  const browser = { close: t.mock.fn(async () => {}), isConnected: () => false }
  const chromium = { connectOverCDP: t.mock.fn(async (url, options) => {
    assert.equal(url, base.replace('https:', 'wss:') + '/browser/' + sessionId)
    assert.equal(options.headers.Authorization, 'Bearer fixture')
    return browser
  }) }
  const cdp = { send: t.mock.fn(async method => {
    assert.equal(method, 'Target.getTargetInfo')
    return { targetInfo: { type: 'page', targetId: 'SECOND-TAB' } }
  }), detach: t.mock.fn(async () => {}) }
  const context = { browser: () => browser, newCDPSession: async () => cdp }
  return { calls, chromium, browser, cdp, page: { context: () => context } }
}

test('local Chromium is headless and receives only OS runtime variables', async t => {
  setEnv(t, 'UNRELATED_CUSTOM_SECRET', 'fixture')
  setEnv(t, 'OP_SERVICE_ACCOUNT_TOKEN', 'fixture')
  const browser = { close: t.mock.fn(async () => {}) }
  const chromium = { launch: t.mock.fn(async () => browser) }
  const session = await startBrowser({ chromium, backend: 'local' })
  const [options] = chromium.launch.mock.calls[0].arguments
  assert.equal(options.headless, true)
  assert.ok(options.env.PATH)
  assert.equal(options.env.UNRELATED_CUSTOM_SECRET, undefined)
  assert.equal(options.env.OP_SERVICE_ACCOUNT_TOKEN, undefined)
  assert.throws(() => session.liveView(), /local preview viewer/)
  await session.close()
  assert.equal(browser.close.mock.callCount(), 1)
})

test('remote views are opt-in, target-specific, short-lived and readonly by default', async t => {
  const { chromium, page, calls, cdp } = remote(t, (method, path, body) => {
    if (path === '/browser?keep_alive=180000') return { sessionId }
    if (path.endsWith('/live_view')) return { id: body.targetId, options: body, devtoolsFrontendUrl: liveUrl }
    assert.equal(method, 'DELETE')
    return { status: 'closed' }
  })
  const session = await startBrowser({ chromium, backend: 'cloudflare' })
  assert.equal(calls.length, 1)
  assert.equal(await session.liveView(page), liveUrl)
  assert.equal(await session.liveView(page, { control: true }), liveUrl)
  assert.deepEqual(calls[1], ['POST', `/browser/${sessionId}/live_view`, {
    mode: 'tab', expiresInMs: 120_000, targetId: 'SECOND-TAB', guardrails: { mode: 'readonly' },
  }])
  assert.equal(calls[2][2].guardrails, undefined)
  assert.equal(cdp.detach.mock.callCount(), 2)
  await Promise.all([session.close(), session.close()])
  assert.equal(calls.length, 4)
})

test('a different tab or missing read-only grant is never shared', async t => {
  let returned = { id: 'FIRST-TAB', options: { mode: 'tab', guardrails: { mode: 'readonly' } } }
  const { chromium, page } = remote(t, (method, path) => {
    if (method === 'DELETE') return { status: 'closed' }
    return path.endsWith('/live_view') ? { ...returned, devtoolsFrontendUrl: liveUrl } : { sessionId }
  })
  const session = await startBrowser({ chromium, backend: 'cloudflare' })
  await assert.rejects(session.liveView(page), /did not confirm/)
  returned = { id: 'SECOND-TAB', options: { mode: 'tab' } }
  await assert.rejects(session.liveView(page), /did not confirm/)
  await session.close()
})

test('failed connections release the acquired lease and verify async shutdown', async t => {
  const { chromium, calls } = remote(t, (method, path) => {
    if (method === 'DELETE') return { status: 'closing' }
    if (path === '/session/' + sessionId) return { sessionId, endTime: Date.now() }
    return { sessionId }
  })
  chromium.connectOverCDP = async () => { throw new Error('connection failed') }
  await assert.rejects(startBrowser({ chromium, backend: 'cloudflare' }), /Unable to attach/)
  assert.deepEqual(calls.map(([method]) => method), ['POST', 'DELETE', 'GET'])
})

test('release still runs on detach failure and can be retried after provider failure', async t => {
  let deletes = 0
  const { chromium, browser } = remote(t, method => {
    if (method === 'POST') return { sessionId }
    deletes++
    return new Response(null, { status: deletes === 1 ? 503 : 404 })
  })
  browser.close = async () => { throw new Error('lost transport') }
  const session = await startBrowser({ chromium, backend: 'cloudflare' })
  await assert.rejects(session.close(), /HTTP 503/)
  await session.close()
  assert.equal(deletes, 2)
})
