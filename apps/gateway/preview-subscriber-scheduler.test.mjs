import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { runPreviewSubscriberScheduler } from './preview-subscriber-scheduler.mjs'

function fixture() {
  const selector = `1.${'a'.repeat(32)}`
  const scope = createHash('sha256').update(selector).digest('hex')
  const route = { selector, target: 'a', release: 'b'.repeat(40), expiresAt: Date.now() + 60_000, subscriberScheduler: true }
  let dispatched = 0
  const env = {
    PREVIEW_SLOT: '1', PREVIEW_TARGET: 'a', PREVIEW_SELECTOR: selector,
    PREVIEW_RELEASE: route.release, PREVIEW_SUBSCRIBER_SCOPE: scope,
    FLAGS: { async getBooleanDetails() { return { value: true } }, async getObjectDetails() { return { value: route } } },
    DB: { prepare() { return { bind(...args) { return { async first() { return args[0] === scope && args[1] === 1 && args[2] === 'a' && args[3] === route.release ? { expires_at: Date.now() + 60_000 } : null } } } } } },
  }
  return { env, route, dispatch: async () => { dispatched++ }, count: () => dispatched }
}

test('only a matching live Flagship route and durable fence dispatch', async () => {
  const f = fixture()
  await runPreviewSubscriberScheduler(f.env, f.dispatch)
  assert.equal(f.count(), 1)
  for (const change of [
    () => { f.route.target = 'b' },
    () => { f.route.release = 'c'.repeat(40) },
    () => { f.route.expiresAt = 0 },
    () => { f.route.subscriberScheduler = false },
  ]) {
    const previous = { ...f.route }
    change()
    await runPreviewSubscriberScheduler(f.env, f.dispatch)
    assert.equal(f.count(), 1)
    Object.assign(f.route, previous)
  }
  f.env.PREVIEW_SUBSCRIBER_SCOPE = '0'.repeat(64)
  await runPreviewSubscriberScheduler(f.env, f.dispatch)
  assert.equal(f.count(), 1)
})

test('reauthorizes every send and fails closed on switch, route changes and errors', async () => {
  const f = fixture()
  let checks = 0
  await runPreviewSubscriberScheduler(f.env, async (_env, authorize) => {
    assert.equal(await authorize(), true)
    checks++
    f.env.FLAGS.getBooleanDetails = async () => ({ value: false })
    assert.equal(await authorize(), false)
    f.env.FLAGS.getBooleanDetails = async () => ({ value: true })
    f.route.target = 'b'
    assert.equal(await authorize(), false)
    f.route.target = 'a'
    f.env.FLAGS.getObjectDetails = async () => { throw new Error('unavailable') }
    assert.equal(await authorize(), false)
  })
  assert.equal(checks, 1)
})

test('a fence expiring while it is read fails closed', async () => {
  const f = fixture()
  f.env.DB.prepare = () => ({ bind: () => ({ first: async () => ({ expires_at: Date.now() - 1 }) }) })
  await runPreviewSubscriberScheduler(f.env, f.dispatch)
  assert.equal(f.count(), 0)
})

test('Flagship or fence failures fail closed; dispatcher failures remain visible', async () => {
  const f = fixture()
  f.env.FLAGS.getBooleanDetails = async () => { throw new Error('offline') }
  await runPreviewSubscriberScheduler(f.env, f.dispatch)
  assert.equal(f.count(), 0)
  f.env.FLAGS.getBooleanDetails = async () => ({ value: true })
  f.env.DB.prepare = () => ({ bind: () => ({ first: async () => null }) })
  await runPreviewSubscriberScheduler(f.env, f.dispatch)
  assert.equal(f.count(), 0)
  const g = fixture()
  await assert.rejects(runPreviewSubscriberScheduler(g.env, async () => { throw new Error('dispatch failed') }), /dispatch failed/)
})
