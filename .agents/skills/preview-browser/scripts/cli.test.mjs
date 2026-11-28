import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { openVariant, projectSettings } from './variant.mjs'

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
  assert.throws(() => projectSettings({ ...config, requiredPaths: ['//example.org/'] }, vars))
  assert.throws(() => projectSettings({ ...config, requiredPaths: 'invalid' }, vars))
  for (const header of ['Authorization', 'X-Preview', 'x-revision', '', 'X-Bad Header', null]) {
    assert.throws(() => projectSettings({ ...config, expectedRevisionRequestHeader: header }, vars))
  }
  assert.equal(projectSettings({ ...config, expectedRevisionRequestHeader: 'X-Expected-Revision' }, vars).expectedRevisionRequestHeader, 'X-Expected-Revision')
})

test('expected revision request headers are isolated by context and never added cross-origin', async () => {
  const contexts = []
  const browser = { newContext: async () => {
    const revision = contexts.length === 0 ? 'revision-a' : contexts.length === 1 ? 'revision-b' : 'revision-default'
    const sent = []
    let paused
    const session = { on: (event, handler) => { if (event === 'Fetch.requestPaused') paused = handler }, send: async (method, params) => { sent.push({method,params}) } }
    const context = { on: () => {}, close: async () => {}, newCDPSession: async () => session, newPage: async () => page }
    const page = { context: () => context, on: () => {}, goto: async url => ({ ok: () => true, url: () => url, headerValue: async () => revision }) }
    contexts.push({sent, request: event => paused(event)})
    return context
  } }
  const settings = { ...config, headers: {}, identity: undefined, expectedRevisionRequestHeader: 'X-Expected-Revision' }
  await openVariant(browser, settings, 'branch-a', 'revision-a', '/')
  await openVariant(browser, settings, 'branch-b', 'revision-b', '/')
  await openVariant(browser, { ...settings, expectedRevisionRequestHeader: undefined }, 'branch-default', 'revision-default', '/')
  for (const [index, expected] of ['revision-a', 'revision-b', undefined].entries()) {
    const context = contexts[index]
    assert.deepEqual(context.sent[0], {method:'Fetch.enable',params:{patterns:[{urlPattern:config.origin+'/*',requestStage:'Request'}]}})
    await context.request({requestId:'same',request:{url:config.origin+'/api',headers:{'X-Expected-Revision':'caller-value'}}})
    const headers = new Headers(context.sent.at(-1).params.headers.map(({name,value})=>[name,value]))
    assert.equal(headers.get('X-Preview'), index === 0 ? 'branch-a' : index === 1 ? 'branch-b' : 'branch-default')
    assert.equal(headers.get('X-Expected-Revision'), expected ?? 'caller-value')
    await context.request({requestId:'other',request:{url:'https://other.example.net/api',headers:{}}})
    assert.deepEqual(context.sent.at(-1), {method:'Fetch.continueRequest',params:{requestId:'other'}})
  }
})

test('a failing required API check closes its browser context before reporting readiness', async () => {
  let closed = false
  const visits = []
  const page = {
    context: () => context,
    on: () => {},
    goto: async url => {
      visits.push(new URL(url).pathname)
      return {
        ok: () => !url.endsWith('/locales'), url: () => url,
        headerValue: async () => 'v1', json: async () => ({ role: 'viewer' }),
      }
    },
  }
  const context = {
    newPage: async () => page,
    newCDPSession: async () => ({ on: () => {}, send: async () => {} }),
    on: () => {}, close: async () => { closed = true },
  }
  const settings = { ...config, headers: {}, requiredPaths: ['/locales'] }
  await assert.rejects(openVariant({ newContext: async () => context }, settings, 'branch-1', 'v1', '/'), /readiness check failed for \/locales/)
  assert.deepEqual(visits, ['/me', '/locales'])
  assert.equal(closed, true)
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
