import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { projectSettings, checkVariant } from '../.agents/skills/preview-browser/scripts/variant.mjs'
import { statusPreviewEnvironment } from '../.github/workflows/branch-previews/scripts/runner-auth.mjs'

const config = JSON.parse(await readFile(new URL('../preview-browser.config.json', import.meta.url)))
const vars = { PREVIEW_ACCESS_ORIGIN: config.origin, CF_ACCESS_CLIENT_ID: 'test-id', CF_ACCESS_CLIENT_SECRET: 'test-secret' }

test('explicit project credentials and other origins do not invoke the Mac bootstrap', async () => {
  assert.equal(await statusPreviewEnvironment(config, vars), vars)
  const unrelated = {}
  assert.equal(await statusPreviewEnvironment({ ...config, origin: 'https://example.org' }, unrelated), unrelated)
  assert.equal(await statusPreviewEnvironment({ ...config, auth: 'none' }, unrelated), unrelated)
})

test('Status Page accepts only its deployed flag and commit formats', () => {
  const s = projectSettings(config, vars)
  for (const flag of ['1.' + '0'.repeat(32), 'branch-' + 'a'.repeat(24)]) {
    checkVariant(s, flag, 'a'.repeat(40))
  }
  for (const flag of ['7.' + '0'.repeat(32), 'branch-' + 'A'.repeat(24), 'a\r\nother: bad']) {
    assert.throws(() => checkVariant(s, flag, 'a'.repeat(40)))
  }
  assert.throws(() => checkVariant(s, 'branch-' + 'a'.repeat(24), 'HEAD'))
})

test('credentials are pinned independently of the project configuration', () => {
  assert.throws(() => projectSettings({ ...config, origin: 'https://example.org' }, vars))
  assert.throws(() => projectSettings(config, { ...vars, CF_ACCESS_CLIENT_SECRET: '' }))
  assert.throws(() => projectSettings({ ...config, allowSelfSignedLoopback: true }, vars))
  assert.throws(() => projectSettings({ ...config, identity: { ...config.identity, path: '//example.org/' } }, vars))
})
