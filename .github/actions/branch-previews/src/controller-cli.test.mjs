import test from 'node:test'
import assert from 'node:assert/strict'
import { activationIdentity, browserViewerSettings, main, selectWorkerSecrets, redactSubscriberAddresses } from './controller-cli.mjs'

test('schema diagnostics redact approved sender and recipient regardless of case', () => {
  const redacted = redactSubscriberAddresses('Sender@Example.com -> recipient@example.com', {sender:'sender@example.com',recipient:'RECIPIENT@example.com'})
  assert.equal(redacted, '[redacted] -> [redacted]')
})

const workers = key => ({ gateway: {}, api: key ? { VAULT_ENCRYPTION_KEY: key } : {}, statusApi: {}, monitoring: {}, status: {}, admin: {}, probe: key ? { VAULT_ENCRYPTION_KEY: key } : {} })

test('selects only the Worker secrets of the deployed environment', () => {
  const secrets = { environments: { dev: { workers: workers('dev-key') }, stage: { workers: workers('stage-key') }, schema: { workers: workers() } } }
  assert.equal(selectWorkerSecrets(secrets, 'dev').api.VAULT_ENCRYPTION_KEY, 'dev-key')
  assert.equal(selectWorkerSecrets(secrets, 'stage').api.VAULT_ENCRYPTION_KEY, 'stage-key')
  assert.deepEqual(selectWorkerSecrets(secrets, 'schema').api, {})
  assert.throws(() => selectWorkerSecrets({ workers: workers('stage-key') }, 'dev'), /secret environments/)
  assert.throws(() => selectWorkerSecrets({ environments: { ...secrets.environments, schema: { workers: { ...workers(), gateway: undefined } } } }, 'stage'), /schema gateway/)
  assert.throws(() => selectWorkerSecrets(secrets, 'prod'), /Invalid Worker secret environment/)
})

test('activation uses staging gateway Access identity for all preview environments', () => {
  const config = { environments: { stage: { accessTeamDomain: 'stage.cloudflareaccess.com', accessAud: 'stage-aud' }, dev: { accessTeamDomain: 'dev.cloudflareaccess.com', accessAud: 'dev-aud' } } }
  assert.deepEqual(activationIdentity(config, { 'cf-access-client-id': 'service.access' }), { accessTeamDomain: 'stage.cloudflareaccess.com', accessAud: 'stage-aud', serviceTokenId: 'service.access' })
  assert.throws(() => activationIdentity(config, {}), /client ID/)
})

test('viewer settings preserve protected branch settings and require a matching HTTPS origin', () => {
  const existing = { endpoints:'[]', previewBrowserClientId:'old.access' }
  const url = new URL('https://stage.example/preview')
  assert.equal(browserViewerSettings(existing, url, {}), existing)
  const env = { PREVIEW_BROWSER_ORIGIN:'https://stage.example', PREVIEW_BROWSER_CLIENT_ID:'viewer.access' }
  assert.deepEqual(browserViewerSettings(existing, url, env), { ...existing, previewBrowserOrigin:'https://stage.example', previewBrowserClientId:'viewer.access' })
  assert.equal(existing.previewBrowserClientId, 'old.access')
  for (const invalid of [
    { ...env, PREVIEW_BROWSER_CLIENT_ID:'' },
    { ...env, PREVIEW_BROWSER_ORIGIN:'' },
    { ...env, PREVIEW_BROWSER_CLIENT_ID:'viewer access' },
    { ...env, PREVIEW_BROWSER_ORIGIN:'http://stage.example' },
    { ...env, PREVIEW_BROWSER_ORIGIN:'https://elsewhere.example' },
    { ...env, PREVIEW_BROWSER_ORIGIN:'https://stage.example/path' },
  ]) assert.throws(() => browserViewerSettings(existing, url, invalid), /preview browser/i)
})

test('invalid reconciliation and deploy inputs fail before cloud access', async () => {
  await assert.rejects(main({ PREVIEW_ACTION: 'reconcile' }), /Invalid preview reconciliation configuration/)
  await assert.rejects(main({ PREVIEW_ACTION: 'deploy', PREVIEW_BRANCH: 'main', PREVIEW_SHA: 'a'.repeat(40) }), /Invalid branch/)
  await assert.rejects(main({ PREVIEW_ACTION: 'deploy', PREVIEW_BRANCH: 'feat/new', PREVIEW_SHA: 'a'.repeat(40) }), /PREVIEW_BRANCH_CONFIG/)
})
