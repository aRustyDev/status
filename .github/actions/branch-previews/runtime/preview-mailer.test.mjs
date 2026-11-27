import test from 'node:test'
import assert from 'node:assert/strict'
import { branchPreviewEmailProxy, handleBranchPreviewMail } from './preview-mailer.mjs'

const from = 'preview@example.test', to = 'test@example.test', origin = 'https://status.example.test'
const confirmation = { from, to, subject: 'Confirm your status subscription', text: `Confirm your subscription: ${origin}/#subscription=confirm&token=${'a'.repeat(64)}` }
const update = { from, to, subject: 'Status page update', text: `A status update has been published. Visit ${origin} to view it or manage your subscription.` }
function harness({ current = [true,true], quota = true, failure = false } = {}) {
  const sent = [], claims = []
  const env = { PREVIEW_MAIL_FROM: from, PREVIEW_MAIL_TO: to, PREVIEW_MAIL_PUBLIC_URL: origin, EMAIL: { async send(value) { if (failure) throw Error('failure'); sent.push(value) } } }
  const fence = async (_env, fn) => fn(async () => current.shift() ?? false, async () => { claims.push(1); return quota })
  const request = value => new Request('https://preview-mailer.invalid/send', { method:'POST', body:JSON.stringify(value) })
  return { env, sent, claims, fence, request }
}

test('permits only the two fixed templates to the approved addresses', async () => {
  for (const message of [confirmation, update]) {
    const h = harness()
    assert.equal((await handleBranchPreviewMail(h.request(message), h.env, h.fence)).status, 204)
    assert.deepEqual(h.sent, [message])
    assert.equal(h.claims.length, 1)
  }
})

test('rejects arbitrary recipients, URLs, content, headers, or subjects', async () => {
  for (const message of [
    { ...update, to:'other@example.test' }, { ...update, from:'other@example.test' },
    { ...confirmation, text:confirmation.text.replace(origin,'https://other.example.test') },
    { ...confirmation, text:confirmation.text + '&extra=1' }, { ...update, text:update.text + ' secret' },
    { ...update, subject:'Other' }, { ...update, cc:'other@example.test' },
  ]) {
    const h = harness()
    assert.equal((await handleBranchPreviewMail(h.request(message), h.env, h.fence)).status, 400)
    assert.equal(h.sent.length, 0)
    assert.equal(h.claims.length, 0)
  }
})

test('rejects oversized streamed input before buffering the whole body', async () => {
  const h = harness()
  let pulls = 0, cancelled = false
  const stream = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(1500)); },
    cancel() { cancelled = true },
  })
  const request = new Request('https://preview-mailer.invalid/send', { method:'POST', body:stream, duplex:'half' })
  assert.equal((await handleBranchPreviewMail(request, h.env, h.fence)).status, 400)
  assert.ok(pulls < 5)
  assert.equal(cancelled, true)
  assert.equal(h.sent.length, 0)
  const advertised = new Request('https://preview-mailer.invalid/send', { method:'POST', headers:{'content-length':'2049'}, body:'{}' })
  assert.equal((await handleBranchPreviewMail(advertised, h.env, h.fence)).status, 400)
})

test('inactive, superseded, quota-exhausted and provider failures never report delivery', async () => {
  for (const options of [{ current:[false] }, { current:[true,false] }, { quota:false }, { failure:true }]) {
    const h = harness(options)
    assert.equal((await handleBranchPreviewMail(h.request(update), h.env, h.fence)).status, 503)
    assert.equal(h.sent.length, 0)
  }
})

test('the proxy forwards only to the private service and rejects failure', async () => {
  const requests = []
  const proxy = branchPreviewEmailProxy({ async fetch(url, init) { requests.push({ url, init }); return new Response(null, { status:204 }) } })
  await proxy.send(update)
  assert.equal(requests[0].url, 'https://preview-mailer.invalid/send')
  assert.deepEqual(JSON.parse(requests[0].init.body), update)
  await assert.rejects(branchPreviewEmailProxy({ async fetch() { return new Response(null, { status:503 }) } }).send(update))
})

test('passes an inherited scheduler lease only to the private fence', async () => {
  const h = harness()
  let seen
  const fence = async (env, fn, options) => { seen = options; await h.fence(env, fn) }
  const request = new Request('https://preview-mailer.invalid/send', { method:'POST', headers: { 'x-preview-execution-lease':'owned-lease' }, body:JSON.stringify(update) })
  assert.equal((await handleBranchPreviewMail(request, h.env, fence)).status, 204)
  assert.deepEqual(seen, { leaseToken:'owned-lease' })
  let passed
  const proxy = branchPreviewEmailProxy({ async fetch(_url, init) { passed = init.headers; return new Response(null, { status:204 }) } }, 'owned-lease')
  await proxy.send(update)
  assert.equal(passed['x-preview-execution-lease'], 'owned-lease')
})
