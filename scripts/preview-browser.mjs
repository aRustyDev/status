#!/usr/bin/env node
import { chromium } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function previewRule(url, selector) {
  const target = new URL(url)
  if (target.protocol !== 'https:' || target.username || target.password || !/^[a-z0-9.-]+$/i.test(target.hostname)) {
    throw new Error('The staging URL must be an HTTPS URL with a DNS hostname and no credentials')
  }
  if (!/^[1-6]\.[a-f0-9]{32}$/.test(selector)) {
    throw new Error('The preview selector must contain a slot number and 32 lowercase hexadecimal characters')
  }
  const origin = target.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return {
    manifest: {
      manifest_version: 3,
      name: 'Staging preview selector',
      version: '1.0.0',
      permissions: ['declarativeNetRequest'],
      host_permissions: [`https://${target.hostname}/*`],
      declarative_net_request: { rule_resources: [{ id: 'preview', enabled: true, path: 'rules.json' }] },
    },
    rules: [{
      id: 1,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'X-Status-Preview', operation: 'set', value: selector }] },
      condition: {
        regexFilter: `^${origin}/`,
        resourceTypes: ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other'],
      },
    }],
  }
}

async function main() {
  const [url, selector, ...extra] = process.argv.slice(2)
  if (!url || !selector || extra.length) {
    throw new Error('Usage: node scripts/preview-browser.mjs <staging-url> <preview-selector>')
  }
  const { manifest, rules } = previewRule(url, selector)
  const directory = await mkdtemp(join(tmpdir(), 'status-preview-'))
  let context
  try {
    const extension = join(directory, 'extension')
    await mkdir(extension)
    await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest))
    await writeFile(join(extension, 'rules.json'), JSON.stringify(rules))
    context = await chromium.launchPersistentContext(join(directory, 'profile'), {
      channel: 'chromium',
      headless: false,
      serviceWorkers: 'block',
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    })
    const page = context.pages()[0] ?? await context.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    console.log(`Preview ${selector} is open. Close the browser to finish.`)
    await new Promise(resolve => context.once('close', resolve))
  } finally {
    if (context) await context.close().catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
