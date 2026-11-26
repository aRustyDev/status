import assert from 'node:assert/strict'
import test from 'node:test'
import { previewRule } from './preview-browser.mjs'

const selector = '1.0123456789abcdef0123456789abcdef'

test('preview header matches only the configured HTTPS origin', () => {
  const { manifest, rules } = previewRule('https://status.example:8443/admin/', selector)
  const rule = rules[0]
  const matches = new RegExp(rule.condition.regexFilter)
  assert.deepEqual(manifest.host_permissions, ['https://status.example/*'])
  assert.deepEqual(rule.action.requestHeaders, [{ header: 'X-Status-Preview', operation: 'set', value: selector }])
  assert.ok(matches.test('https://status.example:8443/api/v1/auth/me'))
  assert.ok(matches.test('https://status.example:8443/admin/assets/app.js'))
  assert.equal(matches.test('https://status.example/api/v1/auth/me'), false)
  assert.equal(matches.test('https://status.example.evil:8443/'), false)
  assert.equal(matches.test('https://other.example/'), false)
  assert.equal(matches.test('http://status.example:8443/'), false)
})

test('preview launcher validates the URL and selector', () => {
  for (const url of ['http://status.example/', 'https://user:pass@status.example/', 'file:///tmp/example']) {
    assert.throws(() => previewRule(url, selector))
  }
  for (const invalid of ['0.0123456789abcdef0123456789abcdef', '7.0123456789abcdef0123456789abcdef', '1.bad', '1.0123456789ABCDEF0123456789ABCDEF']) {
    assert.throws(() => previewRule('https://status.example/', invalid))
  }
})
