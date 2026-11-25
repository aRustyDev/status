import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emailChannelFingerprint, emailDestinations, emailReady } from '../src/email-channel.ts'

const destinations = JSON.stringify([{ id: 'ops', name: 'Operations', address: 'ops@example.com' }])

test('email destinations reject malformed, duplicate, and unapproved entries', () => {
  assert.deepEqual([...emailDestinations(destinations).keys()], ['ops'])
  for (const input of ['{', JSON.stringify([{ id: 'ops', name: 'Ops', address: 'a@example.com\nBcc: x@y' }]), JSON.stringify([{ id: 'x', name: 'X', address: 'a@example.com' }, { id: 'x', name: 'Y', address: 'b@example.com' }]), JSON.stringify([{ id: 'x', name: 'X', address: 'a@example.com' }, { id: 'y', name: 'Y', address: 'A@example.com' }])]) {
    assert.equal(emailDestinations(input).size, 0)
  }
})

test('email delivery remains gated until sender, destination and binding are present', () => {
  const binding = { send: async () => ({}) } as unknown as SendEmail
  const config = { EMAIL_READY: 'true', EMAIL_FROM: 'status@example.com', EMAIL_DESTINATIONS: destinations, EMAIL: binding }
  assert.equal(emailReady(config), true)
  assert.equal(emailReady({ ...config, EMAIL_READY: 'false' }), false)
  assert.equal(emailReady({ ...config, EMAIL_FROM: 'bad\naddress' }), false)
  assert.equal(emailReady({ ...config, EMAIL: undefined }), false)
})

test('email destination fingerprint changes with either sender or recipient', async () => {
  const original = await emailChannelFingerprint('status@example.com', 'ops@example.com')
  assert.equal(original, await emailChannelFingerprint('status@example.com', 'ops@example.com'))
  assert.notEqual(original, await emailChannelFingerprint('other@example.com', 'ops@example.com'))
  assert.notEqual(original, await emailChannelFingerprint('status@example.com', 'other@example.com'))
})

test('email delivery uses approved sender and recipient, escapes content, and fails closed on drift', async () => {
  const { sendApprovedEmail } = await import('../src/email-channel.ts')
  const sent: unknown[] = []
  const binding = { send: async (message: unknown) => { sent.push(message); return { messageId: 'accepted' } } } as SendEmail
  const env = { EMAIL_READY: 'true', EMAIL_FROM: 'status@example.com', EMAIL_DESTINATIONS: destinations, EMAIL: binding }
  const fingerprint = await emailChannelFingerprint(env.EMAIL_FROM, 'ops@example.com')
  assert.equal(await sendApprovedEmail(env, 'ops', fingerprint, { monitorName: '<API>', status: 'down', scheduledAt: 0 }), 'sent')
  assert.deepEqual(sent, [{ from: 'status@example.com', to: 'ops@example.com', subject: 'Monitor down: <API>', text: 'Monitor <API> changed to down at 1970-01-01T00:00:00.000Z.', html: '<p>Monitor &lt;API&gt; changed to down at 1970-01-01T00:00:00.000Z.</p>' }])
  assert.equal(await sendApprovedEmail(env, 'ops', 'outdated', null), 'unavailable')
  assert.equal(sent.length, 1)
  const failing = { ...env, EMAIL: { send: async () => { throw new Error('private provider details') } } as SendEmail }
  assert.equal(await sendApprovedEmail(failing, 'ops', fingerprint, null), 'delivery_failed')
})
