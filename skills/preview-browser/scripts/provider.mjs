import { setTimeout as delay } from 'node:timers/promises'

// Chromium needs a cache/home and OS runtime directories, but never the
// launcher's project credentials (which can have arbitrary environment names).
function localBrowserEnv() {
  const allowed = /^(?:PATH|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|SYSTEMROOT|WINDIR|TMPDIR|TMP|TEMP|LANG|LC_[A-Z_]+|XDG_RUNTIME_DIR|FONTCONFIG_PATH|FONTCONFIG_FILE)$/i
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)))
}

export async function startBrowser({ chromium, backend, env = process.env }) {
  if (backend === 'local') {
    const browser = await chromium.launch({ headless: true, env: localBrowserEnv() })
    return {
      browser,
      close: () => browser.close(),
      liveView() { throw new Error('Use the local preview viewer for this browser.') },
    }
  }
  if (backend !== 'cloudflare') throw new Error('Expected a local or cloudflare browser backend.')
  const account = env.BROWSER_RUN_ACCOUNT_ID
  const token = env.BROWSER_RUN_API_TOKEN
  if (!/^[a-f0-9]{32}$/i.test(account ?? '') || !token) {
    throw new Error('Set BROWSER_RUN_ACCOUNT_ID and BROWSER_RUN_API_TOKEN for the Cloudflare backend.')
  }
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/browser-run/devtools`
  async function request(path, method, body, missingOK = false) {
    const headers = { Authorization: `Bearer ${token}` }
    if (body) headers['Content-Type'] = 'application/json'
    const response = await fetch(base + path, {
      method, headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15_000),
    })
    if (missingOK && response.status === 404) return null
    if (!response.ok) throw new Error(`Browser Run ${method} failed (HTTP ${response.status}).`)
    return response.json()
  }

  const { sessionId } = await request('/browser?keep_alive=180000', 'POST')
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) {
    throw new Error('Browser Run returned an invalid session ID.')
  }
  const path = `/browser/${sessionId}`
  async function release() {
    const result = await request(path, 'DELETE', undefined, true)
    if (!result || result.status === 'closed') return
    if (result.status !== 'closing') throw new Error('Browser Run did not acknowledge closing the session.')
    // A successful DELETE can mean that shutdown is still in progress.
    for (let attempt = 0; attempt < 6; attempt++) {
      const state = await request(`/session/${sessionId}`, 'GET', undefined, true)
      if (!state || (state.sessionId === sessionId && state.endTime > 0)) return
      await delay(500)
    }
    throw new Error('Browser Run has not confirmed session shutdown.')
  }

  let browser
  try {
    browser = await chromium.connectOverCDP(base.replace('https:', 'wss:') + path, {
      headers: { Authorization: `Bearer ${token}` }, timeout: 15_000,
    })
  } catch {
    await release()
    throw new Error('Unable to attach to the Browser Run session.')
  }

  let closing
  return {
    browser,
    async liveView(page, { control = false } = {}) {
      if (typeof control !== 'boolean' || page.context().browser() !== browser) {
        throw new Error('Invalid Live View access mode or page.')
      }
      const cdp = await page.context().newCDPSession(page)
      let targetInfo
      try {
        const result = await cdp.send('Target.getTargetInfo')
        targetInfo = result.targetInfo
      } finally {
        await cdp.detach()
      }
      if (targetInfo?.type !== 'page' || !targetInfo.targetId) throw new Error('Unable to identify the requested tab.')
      const body = { mode: 'tab', expiresInMs: 120_000, targetId: targetInfo.targetId }
      if (!control) body.guardrails = { mode: 'readonly' }
      const view = await request(path + '/live_view', 'POST', body)
      if (view.id !== body.targetId || view.options?.mode !== 'tab' ||
          (!control && view.options.guardrails?.mode !== 'readonly') ||
          !URL.canParse(view.devtoolsFrontendUrl) ||
          new URL(view.devtoolsFrontendUrl).origin !== 'https://live.browser.run') {
        throw new Error('Browser Run did not confirm the requested tab and permissions.')
      }
      return view.devtoolsFrontendUrl
    },
    close() {
      // Playwright closes its CDP connection; DELETE releases the provider lease.
      // Issue both even if one fails, and let callers retry failed cleanup.
      closing ??= Promise.allSettled([browser.close(), release()]).then(([connection, lease]) => {
        if (lease.status === 'rejected') throw lease.reason
        if (connection.status === 'rejected' && browser.isConnected()) throw new Error('Browser connection did not close.')
      }).catch(error => {
        closing = undefined
        throw error
      })
      return closing
    },
  }
}
