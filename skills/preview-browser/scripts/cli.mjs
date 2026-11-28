#!/usr/bin/env node
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile, lstat } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { startBrowser } from './provider.mjs'
import { checkVariant, openVariant, projectSettings } from './variant.mjs'
import { localView } from './local-view.mjs'

const usage = [
  'preview-browser open SELECTOR REVISION [--path /] [--config FILE]',
  'preview-browser compare SELECTOR_A REVISION_A SELECTOR_B REVISION_B [--path /] [--config FILE]',
  'preview-browser inspect RUN SIDE | screenshot RUN SIDE FILE | goto RUN SIDE PATH',
  'preview-browser click RUN SIDE ROLE NAME | fill RUN SIDE LABEL VALUE',
  'preview-browser show RUN SIDE [--control] | resume RUN | close RUN',
].join('\n')
const prefix = 'preview-browser-'
// macOS sockaddr_un is only 104 bytes. /tmp is shared but mkdtemp creates a private 0700 directory.
const base = process.platform === 'darwin' ? '/tmp' : tmpdir()

function sessionSocket(id) {
  if (!/^[A-Za-z0-9]{6}$/.test(id || '')) throw new Error('Invalid run ID.')
  return join(base, prefix + id, 'control.sock')
}

async function readBody(stream, limit) {
  let length = 0
  const chunks = []
  for await (const chunk of stream) {
    length += chunk.length
    if (length > limit) throw new Error('Request too large.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function command(id, action, args, control) {
  const socketPath = sessionSocket(id)
  const dir = await lstat(join(base, prefix + id))
  if (!dir.isDirectory() || (dir.mode & 0o077) || (process.getuid && dir.uid !== process.getuid())) throw new Error('Unsafe run directory.')
  const req = request({ socketPath, path: '/', method: 'POST', timeout: 30_000 })
  req.on('timeout', () => req.destroy(new Error('Session command timed out.')))
  const response = once(req, 'response')
  req.end(JSON.stringify({ action, args, control }))
  const [res] = await response
  const bytes = await readBody(res, 24 * 1024 * 1024)
  if (res.statusCode !== 200) throw new Error(bytes.toString())
  return bytes
}

async function ownRun(settings, pairs, path, env) {
  for (const [selector, revision] of pairs) checkVariant(settings, selector, revision)
  const require = createRequire(resolve('package.json'))
  const { chromium } = require('playwright')
  const dir = await mkdtemp(join(base, prefix))
  const id = dir.slice(-6)
  const variants = []
  const viewers = new Set()
  const closeRequests = []
  let provider, server, timer, finish, handedOff = false, active = false
  const done = new Promise(resolve => { finish = resolve })
  async function shutdown() {
    clearTimeout(timer)
    for (const view of viewers) view.close()
    server?.close()
    try {
      try {
        if (provider) {
          // Provider shutdown is idempotent. Retry once after a transport failure.
          try { await provider.close() } catch { await provider.close() }
        }
      } finally { await rm(dir, { recursive: true, force: true }) }
      for (const response of closeRequests) response.end('closed')
    } catch (error) {
      for (const response of closeRequests) response.writeHead(500).end('Preview shutdown could not be confirmed.')
      throw error
    } finally {
      for (const signal of signals) process.removeListener(signal, stop)
    }
  }
  const stop = () => finish()
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP']
  for (const signal of signals) process.once(signal, stop)
  const resetIdle = () => {
    clearTimeout(timer)
    timer = setTimeout(stop, 120_000)
  }
  try {
    provider = await startBrowser({ chromium, backend: settings.backend, env })
    provider.browser.on('disconnected', stop)
    for (const [selector, revision] of pairs) variants.push(await openVariant(provider.browser, settings, selector, revision, path))
    server = createServer(async (req, res) => {
      try {
        if (req.method !== 'POST' || req.url !== '/') throw new Error('Unknown request.')
        const { action, args, control } = JSON.parse(await readBody(req, 32_768))
        if (action === 'close') { closeRequests.push(res); stop(); return }
        if (active) throw new Error('A command is already running.')
        active = true
        try {
          resetIdle()
          if (action === 'resume') { handedOff = false; res.end('resumed'); return }
          const v = variants[['a', 'b'].indexOf(args[0])]
          if (!v) throw new Error('Choose an active side (a or b).')
          if (handedOff && ['click','fill','goto'].includes(action)) throw new Error('Human control is active. Resume automation first.')
          if (action !== 'goto') await v.verifyPage()
          const page = v.page
          switch (action) {
            case 'inspect':
              res.end(JSON.stringify({ selector: v.selector, revision: v.revision, snapshot: await page.locator('body').ariaSnapshot({ timeout: 5000 }) }))
              break
            case 'screenshot': res.end(await page.screenshot({ timeout: 8000 })); break
            case 'goto': await v.navigate(args[1]); res.end('loaded'); break
            case 'click': await page.getByRole(args[1], { name: args[2], exact: true }).click({ timeout: 5000 }); res.end('clicked'); break
            case 'fill': await page.getByLabel(args[1], { exact: true }).fill(args[2], { timeout: 5000 }); res.end('filled'); break
            case 'show': {
              if (settings.backend === 'local') {
                if (control) throw new Error('Interactive handoff requires the Cloudflare backend.')
                const viewer = await localView(page)
                viewers.add(viewer)
                res.end(viewer.url)
              } else {
                const url = await provider.liveView(page, { control })
                if (control) handedOff = true
                res.end(url)
              }
              break
            }
            default: throw new Error('Unknown session command.')
          }
        } finally { active = false }
      } catch (error) {
        // Playwright action errors may contain page text or input values.
        res.writeHead(400).end(error.name === 'Error' && /^(Choose|Human control|Interactive handoff|Unknown|A command|Preview response|Browser Run did not)/.test(error.message)
          ? error.message : 'The browser command failed.')
      }
    })
    server.listen(sessionSocket(id))
    await once(server, 'listening')
    resetIdle()
    console.log(JSON.stringify({ run: id, backend: settings.backend, variants: variants.map(({ selector, revision }, i) => ({ side: i ? 'b' : 'a', selector, revision })) }))
    await done
  } finally {
    await shutdown()
  }
}

export async function main(argv = process.argv.slice(2), ownerEnvironment = () => process.env) {
  const { values, positionals: [action, ...args] } = parseArgs({ args: argv, allowPositionals: true, options: {
    config: { type: 'string', default: 'preview-browser.config.json' }, path: { type: 'string', default: '/' },
    control: { type: 'boolean', default: false }, help: { type: 'boolean' },
  } })
  if (values.help) { console.log(usage); return }
  if (action === 'open' || action === 'compare') {
    if (args.length !== (action === 'open' ? 2 : 4)) throw new Error(usage)
    const pairs = [args.slice(0,2)]
    if (action === 'compare') pairs.push(args.slice(2,4))
    const config = JSON.parse(await readFile(values.config, 'utf8'))
    const env = await ownerEnvironment(config)
    const settings = projectSettings(config, env)
    await ownRun(settings, pairs, values.path, env)
    return
  }
  const counts = { close: 1, resume: 1, inspect: 2, screenshot: 3, goto: 3, click: 4, fill: 4, show: 2 }
  if (!Object.hasOwn(counts, action) || args.length !== counts[action] || (values.control && action !== 'show')) throw new Error(usage)
  const [id, ...rest] = args
  const bytes = await command(id, action, action === 'screenshot' ? rest.slice(0,1) : rest, values.control)
  if (action === 'screenshot') await writeFile(rest[1], bytes, { mode: 0o600 })
  else console.log(bytes.toString())
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
