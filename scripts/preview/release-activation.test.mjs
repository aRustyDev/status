import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { newRelease } from './release-contract.mjs'
import { createActivationAdapter } from './release-activation.mjs'

const ref = 'refs/heads/feat/test'
const sha = 'a'.repeat(40)

test('keeps other bindings and verifies candidate before publishing the flag', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'preview-activation-'))
  t.after(() => rmSync(directory, { force: true, recursive: true }))
  const record = newRelease({ ref, sha })
  const workerName = (selector, release) => `status-p-${createHash('sha256').update(`${selector}:${release}`).digest('hex').slice(0, 24)}-gateway`
  record.candidate = { sha, generation: 1, phase: 'activating', resources: { gateway: workerName(record.selector, sha) } }
  const other = newRelease({ ref: 'refs/heads/feat/other', sha: 'b'.repeat(40) })
  other.active = { sha: other.desiredSha, generation: 1, resources: { gateway: workerName(other.selector, other.desiredSha) } }
  let flag = null
  let verified = false
  const calls = []
  const adapter = createActivationAdapter({ store: { list: async () => [{ record }, { record: other }] }, appId: 'app', accountId: 'account', token: 'token', dispatcherName: 'dispatcher', dispatcherSource: '/trusted/dispatcher.ts', directory,
    run: async args => { calls.push(args); const config = JSON.parse(readFileSync(path.join(directory, 'preview-dispatcher.json'), 'utf8')); assert.equal(config.services.length, 2) },
    verificationSecret: 'x'.repeat(32), previewUrl: 'https://preview.example', accessTeamDomain: 'team.cloudflareaccess.com', accessAud: 'aud', serviceTokenId: 'client.access', wait: async () => {},
    fetchImpl: async (url, options) => {
      if (url === 'https://preview.example/__preview/verify') { if (options.headers['X-Status-Preview-Verify']) verified = true; return { ok: true, headers: new Headers({ 'X-Status-Preview-Commit': sha }) } }
      if (options.method === 'POST') { assert.equal(verified, true); flag = JSON.parse(options.body); return { ok: true, status: 200, json: async () => ({ success: true, result: flag }) } }
      if (!flag) return { status: 404 }
      return { ok: true, status: 200, json: async () => ({ success: true, result: flag }) }
    },
  })
  await adapter({ ref, sha, generation: 1, selector: record.selector, resources: record.candidate.resources, active: null })
  assert.equal(calls.length, 2)
  assert.equal(flag.variations.current.release, sha)
})
