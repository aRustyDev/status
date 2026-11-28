import { validateHeaderName } from 'node:http'

export function localOrigin(url) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
}

export function projectSettings(config, env = process.env) {
  const url = new URL(config.origin)
  if (url.origin !== config.origin || !(url.protocol === 'https:' || (url.protocol === 'http:' && localOrigin(url)))) {
    throw new Error('Configure an exact HTTPS origin or a loopback HTTP origin.')
  }
  if (!['cloudflare', 'local'].includes(config.backend)) throw new Error('Unknown preview backend.')
  for (const header of [config.selectorHeader, config.revisionHeader]) validateHeaderName(header)
  if (!/^x-/i.test(config.selectorHeader) || config.selectorHeader.toLowerCase() === config.revisionHeader.toLowerCase()) {
    throw new Error('Configure distinct routing and revision headers with an X-prefixed routing header.')
  }
  if (config.allowSelfSignedLoopback && (!localOrigin(url) || config.backend !== 'local')) {
    throw new Error('Self-signed TLS is available only for a local browser testing a loopback origin.')
  }
  const headers = {}
  if (config.auth === 'access') {
    if (url.protocol !== 'https:' || env.PREVIEW_ACCESS_ORIGIN !== url.origin) {
      throw new Error('The configured HTTPS origin must match PREVIEW_ACCESS_ORIGIN from the credential store.')
    }
    if (!env.CF_ACCESS_CLIENT_ID || !env.CF_ACCESS_CLIENT_SECRET) {
      throw new Error('Provide CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET from the project secret store.')
    }
    headers['CF-Access-Client-Id'] = env.CF_ACCESS_CLIENT_ID
    headers['CF-Access-Client-Secret'] = env.CF_ACCESS_CLIENT_SECRET
  } else if (config.auth !== 'none') {
    throw new Error('Configure auth as access or none.')
  }
  if (config.auth === 'access' || config.identity) {
    if (!config.identity?.path || !Object.keys(config.identity.equals ?? {}).length) throw new Error('Configure an identity endpoint and expected principal fields.')
    projectUrl(config.origin, config.identity.path)
  }
  return { ...config, headers }
}

function projectUrl(origin, path) {
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('Supply a project-relative path.')
  const url = new URL(path, origin)
  if (url.origin !== origin || url.username || url.password) throw new Error('The path must stay on the configured origin.')
  return url.href
}

export function checkVariant(settings, selector, revision) {
  if (!/^[\w.-]{1,200}$/.test(selector) || (settings.selectorPattern && !new RegExp(settings.selectorPattern, 'u').test(selector))) {
    throw new Error('Invalid preview selector.')
  }
  if (!/^[\w.-]{1,128}$/.test(revision) || (settings.revisionPattern && !new RegExp(settings.revisionPattern, 'u').test(revision))) {
    throw new Error('Supply the expected revision for this selector.')
  }
}

async function intercept(page, origin, headers) {
  const session = await page.context().newCDPSession(page)
  // Fetch.continueRequest overrides apply to one network hop. A redirect is
  // evaluated afresh by Chromium, including redirects to a different port.
  session.on('Fetch.requestPaused', async event => {
    try {
      const params = { requestId: event.requestId }
      if (new URL(event.request.url).origin === origin) {
        const entries = new Headers(event.request.headers)
        for (const [key, value] of Object.entries(headers)) entries.set(key, value)
        params.headers = Array.from(entries, ([name, value]) => ({ name, value }))
      }
      await session.send('Fetch.continueRequest', params)
    } catch {
      await session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Failed' }).catch(() => {})
    }
  })
  await session.send('Fetch.enable', { patterns: [{ urlPattern: origin + '/*', requestStage: 'Request' }] })
}

export async function openVariant(browser, settings, selector, revision, path) {
  checkVariant(settings, selector, revision)
  const dest = projectUrl(settings.origin, path)
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US',
    timezoneId: 'UTC', ignoreHTTPSErrors: settings.allowSelfSignedLoopback === true, reducedMotion: 'reduce', serviceWorkers: 'block' })
  try {
    const page = await context.newPage()
    // Commands and grants address this specific tab. A popup is a separate target.
    context.on('page', other => { if (other !== page) void other.close().catch(() => {}) })
    await intercept(page, settings.origin, { ...settings.headers, [settings.selectorHeader]: selector })
    let documentRevision = Promise.resolve(null)
    page.on('response', response => {
      const request = response.request()
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        documentRevision = response.ok() ? response.headerValue(settings.revisionHeader).catch(() => null) : Promise.resolve(null)
      }
    })
    const verifyPage = async () => {
      if (new URL(page.url()).origin !== settings.origin || await documentRevision !== revision) {
        throw new Error('Preview response no longer matches the requested revision.')
      }
    }
    const goto = async url => {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 })
      if (!response?.ok() || new URL(response.url()).origin !== settings.origin ||
          await response.headerValue(settings.revisionHeader) !== revision) {
        throw new Error('Preview response did not match the expected origin, HTTP success, and revision.')
      }
      return response
    }
    if (settings.identity) {
      const response = await goto(projectUrl(settings.origin, settings.identity.path))
      const principal = await response.json().catch(() => null)
      if (!principal || !Object.entries(settings.identity.equals).every(([k,v]) => principal[k] === v)) {
        throw new Error('The app did not confirm the expected preview identity and role.')
      }
    }
    await goto(dest)
    return { context, page, selector, revision, verifyPage, navigate: path => goto(projectUrl(settings.origin, path)) }
  } catch (error) {
    await context.close()
    throw error
  }
}
