import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { projectSettings } from './variant.mjs'

const config = {
  origin: 'https://preview.example.org', backend: 'cloudflare', auth: 'access',
  selectorHeader: 'X-Preview', revisionHeader: 'X-Revision',
  identity: { path: '/me', equals: { role: 'viewer' } },
}

test('credentials are pinned independently of the project configuration', () => {
  const vars = { PREVIEW_ACCESS_ORIGIN: config.origin, CF_ACCESS_CLIENT_ID: 'test-id', CF_ACCESS_CLIENT_SECRET: 'test-secret' }
  assert.throws(() => projectSettings({ ...config, origin: 'https://example.org' }, vars))
  assert.throws(() => projectSettings(config, { ...vars, CF_ACCESS_CLIENT_SECRET: '' }))
  assert.throws(() => projectSettings({ ...config, allowSelfSignedLoopback: true }, vars))
  assert.throws(() => projectSettings({ ...config, identity: { ...config.identity, path: '//example.org/' } }, vars))
})

test('the installed CLI loads the optional Access adapter only from the working checkout', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'preview-adapter-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const configDir = join(cwd, 'configs')
  await mkdir(join(configDir, '.github/workflows/branch-previews/scripts'), { recursive: true })
  await writeFile(join(configDir, '.github/workflows/branch-previews/scripts/runner-auth.mjs'), 'throw Error("wrong adapter")')
  const configPath = join(configDir, 'preview.json')
  await writeFile(configPath, JSON.stringify(config))

  const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url))
  const run = (...args) => promisify(execFile)(process.execPath, [cli, ...args], { cwd, env: {} })
  const open = () => run('open', 'test', 'v1', '--config', configPath)
  await assert.rejects(open(), { stderr: /must match PREVIEW_ACCESS_ORIGIN/ })
  await mkdir(join(cwd, '.github/workflows/branch-previews/scripts'), { recursive: true })
  await writeFile(join(cwd, '.github/workflows/branch-previews/scripts/runner-auth.mjs'), 'export default () => { throw Error("checkout adapter called") }')
  await assert.rejects(open(), { stderr: /checkout adapter called/ })
  await assert.rejects(run('inspect', 'invalid', 'a'), { stderr: /Invalid run ID/ })
})
