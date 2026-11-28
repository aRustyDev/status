import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const origin = 'https://status.sow.foo'
const helper = join(homedir(), 'Library/Application Support/Status Preview Browser/status-preview-vault')

async function credentialJson(file, args, message) {
  try {
    const { stdout } = await exec(file, args, {
      cwd: homedir(), timeout: 30_000, maxBuffer: 128 * 1024,
      env: { HOME: homedir(), PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', LANG: 'en_US.UTF-8' },
    })
    return JSON.parse(stdout)
  } catch {
    // execFile errors retain stdout/stderr and can contain credentials.
    throw new Error(message)
  }
}

export async function statusPreviewEnvironment(config, env = process.env) {
  if (config.origin !== origin || config.auth !== 'access' || process.platform !== 'darwin') return env
  const supplied = ['PREVIEW_ACCESS_ORIGIN', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET'].filter(key => env[key])
  if (supplied.length && supplied.length !== 3) throw new Error('Supply the complete Access viewer credential or clear it to use the project runner.')
  if (supplied.length) return env
  const viewer = await credentialJson(helper, ['viewer'], 'Cannot resolve the staging viewer. Verify the installed runner Keychain helper and service account.')
  const resolved = { ...viewer, BROWSER_RUN_API_TOKEN: env.BROWSER_RUN_API_TOKEN }
  if (config.backend === 'cloudflare' && !resolved.BROWSER_RUN_API_TOKEN) {
    // The provisioned Mac has a separate Cloudflare login. Only the Browser
    // Run provider receives its token, and only for its own account API calls.
    const wrangler = ['/opt/homebrew/bin/wrangler', '/usr/local/bin/wrangler'].find(existsSync)
    if (!wrangler) throw new Error('Supply BROWSER_RUN_API_TOKEN or install Wrangler on the runner Mac.')
    const auth = await credentialJson(wrangler, ['auth', 'token', '--json'], 'Unable to obtain the runner’s Cloudflare credential. Supply BROWSER_RUN_API_TOKEN or check the existing Wrangler login.')
    resolved.BROWSER_RUN_API_TOKEN = auth.token
  }
  return resolved
}
