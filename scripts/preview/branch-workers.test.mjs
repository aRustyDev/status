import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createBranchConfigs, deployBranchWorkers } from './branch-workers.mjs'

const settings = { d1DatabaseId: 'id', d1DatabaseName: 'db', accessTeamDomain: 'access', accessAud: 'aud', previewBrowserOrigin: 'https://stage.example', previewBrowserClientId: 'browser.access', endpoints: '[]', apiVars: { SUBSCRIBERS_READY: 'true' } }
const selector = 'branch-' + 'a'.repeat(24)
const sha = 'b'.repeat(40)

test('creates a private release stack with the selected database and disabled schedules', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'branch-workers-test-'))
  try {
    const { names, order } = createBranchConfigs({ settings, selector, sha, branchDir: '/feature', dir })
    assert.equal(order.at(-1), 'gateway')
    assert.equal(new Set(Object.values(names)).size, order.length)
    for (const name of order) {
      const config = JSON.parse(readFileSync(path.join(dir, `${name}.json`)))
      if (['api', 'statusApi', 'monitoring'].includes(name)) {
        assert.equal(config.vars.DEPLOYMENT_ENVIRONMENT, 'staging')
        assert.equal(config.vars.PREVIEW_BROWSER_ORIGIN, 'https://stage.example')
        assert.equal(config.vars.PREVIEW_BROWSER_CLIENT_ID, 'browser.access')
      }
      assert.equal(config.workers_dev, false)
      assert.equal(config.preview_urls, false)
      assert.ok(names[name].length <= 63)
      if (config.d1_databases) assert.equal(config.d1_databases[0].database_id, 'id')
      assert.deepEqual(config.triggers?.crons ?? [], [])
    }
    const api = JSON.parse(readFileSync(path.join(dir, 'api.json')))
    assert.equal(api.vars.SUBSCRIBERS_READY, 'false')
    assert.equal(api.vars.SUBSCRIBER_EMAIL_READY, 'false')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('runs every dry run before deployment and stops after a secret failure', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'branch-workers-test-'))
  const events = []
  try {
    await assert.rejects(deployBranchWorkers({ settings, selector, sha, branchDir: '/feature', dir,
      run: async args => events.push(args.includes('--dry-run') ? 'dry' : 'deploy'),
      installSecrets: async name => { events.push(`secret:${name}`); throw new Error('secret failed') },
    }), /secret failed/)
    assert.deepEqual(events.slice(0, 7), Array(7).fill('dry'))
    assert.deepEqual(events.slice(7), ['deploy', 'secret:probe'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
