import test from 'node:test'
import assert from 'node:assert/strict'
import { activationIdentity, main } from './controller-cli.mjs'

test('activation uses staging gateway Access identity for all preview environments', () => {
  const config = { environments: { stage: { accessTeamDomain: 'stage.cloudflareaccess.com', accessAud: 'stage-aud' }, dev: { accessTeamDomain: 'dev.cloudflareaccess.com', accessAud: 'dev-aud' } } }
  assert.deepEqual(activationIdentity(config, { 'cf-access-client-id': 'service.access' }), { accessTeamDomain: 'stage.cloudflareaccess.com', accessAud: 'stage-aud', serviceTokenId: 'service.access' })
  assert.throws(() => activationIdentity(config, {}), /client ID/)
})

test('invalid reconciliation and deploy inputs fail before cloud access', async () => {
  await assert.rejects(main({ PREVIEW_ACTION: 'reconcile' }), /Invalid preview reconciliation configuration/)
  await assert.rejects(main({ PREVIEW_ACTION: 'deploy', PREVIEW_BRANCH: 'main', PREVIEW_SHA: 'a'.repeat(40) }), /Invalid branch/)
  await assert.rejects(main({ PREVIEW_ACTION: 'deploy', PREVIEW_BRANCH: 'feat/new', PREVIEW_SHA: 'a'.repeat(40) }), /PREVIEW_BRANCH_CONFIG/)
})
