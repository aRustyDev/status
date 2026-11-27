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

test('schema scheduler fence revokes old release before activating and publishing candidate', async t => {
  const directory = mkdtempSync(path.join(tmpdir(),'schema-activation-'))
  t.after(() => rmSync(directory,{recursive:true,force:true}))
  const ref = 'refs/heads/schema/one', sha = 'a'.repeat(40), oldSha = 'b'.repeat(40)
  const record = newRelease({ref,sha}), stem = release => `status-p-${createHash('sha256').update(`${record.selector}:${release}`).digest('hex').slice(0,24)}`
  const active = {sha:oldSha,generation:1,resources:{gateway:stem(oldSha)+'-gateway',workers:{subscriber:stem(oldSha)+'-subscriber'}}}
  record.active=active
  record.candidate={sha,generation:1,phase:'activating',resources:{gateway:stem(sha)+'-gateway',workers:{subscriber:stem(sha)+'-subscriber'}}}
  let flag = {enabled:true,default_variation:'current',rules:[],variations:{current:{selector:record.selector,release:oldSha}}}
  const events = []
  const adapter = createActivationAdapter({store:{list:async()=>[{record}]},appId:'app',accountId:'account',token:'token',dispatcherName:'dispatcher',dispatcherSource:'/trusted.ts',directory,run:async()=>{},verificationSecret:'x'.repeat(32),previewUrl:'https://preview.example',accessTeamDomain:'team',accessAud:'aud',serviceTokenId:'service',wait:async()=>{},
    subscriberFence:{revoke:async()=>events.push('revoke'),activate:async()=>events.push('activate')},
    fetchImpl:async (url,options) => {
      if (url === 'https://preview.example/__preview/verify') return {ok:true,headers:new Headers({'X-Status-Preview-Commit':sha})}
      if (options.method === 'PUT') {events.push('publish');flag=JSON.parse(options.body)}
      return {ok:true,json:async()=>({success:true,result:flag})}
    }})
  await adapter({ref,sha,generation:1,selector:record.selector,resources:record.candidate.resources,active})
  assert.deepEqual(events,['revoke','activate','publish'])
  // A new release without approval still revokes its opted-in predecessor.
  events.length = 0
  record.candidate.resources.workers = {}
  flag = {enabled:true,default_variation:'current',rules:[],variations:{current:{selector:record.selector,release:oldSha}}}
  await adapter({ref,sha,generation:1,selector:record.selector,resources:record.candidate.resources,active})
  assert.deepEqual(events,['revoke','activate','publish'])
})

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
  let writes = 0
  let candidateProbes = 0
  let activeProbes = 0
  let waits = 0
  const calls = []
  const adapter = createActivationAdapter({ store: { list: async () => [{ record }, { record: other }] }, appId: 'app', accountId: 'account', token: 'token', dispatcherName: 'dispatcher', dispatcherSource: '/trusted/dispatcher.ts', directory,
    run: async args => { calls.push(args); const config = JSON.parse(readFileSync(path.join(directory, 'preview-dispatcher.json'), 'utf8')); assert.equal(config.services.length, 2) },
    verificationSecret: 'x'.repeat(32), previewUrl: 'https://preview.example', accessTeamDomain: 'team.cloudflareaccess.com', accessAud: 'aud', serviceTokenId: 'client.access', wait: async () => { waits++ },
    fetchImpl: async (url, options) => {
      if (url === 'https://preview.example/__preview/verify') {
        const proof = options.headers['X-Status-Preview-Verify']
        if (proof.includes('.candidate.')) {
          if (++candidateProbes <= 4) return { ok: false, status: 503 }
          verified = true
        }
        if (proof.includes('.active.') && ++activeProbes <= 35) return { ok: false, status: 503 }
        return { ok: true, headers: new Headers({ 'X-Status-Preview-Commit': sha }) }
      }
      if (options.method === 'POST' || options.method === 'PUT') { assert.equal(verified, true); writes++; flag = JSON.parse(options.body); return { ok: true, status: 200, json: async () => ({ success: true, result: flag }) } }
      if (!flag) return { status: 404 }
      return { ok: true, status: 200, json: async () => ({ success: true, result: flag }) }
    },
  })
  await adapter({ ref, sha, generation: 1, selector: record.selector, resources: record.candidate.resources, active: null })
  assert.equal(calls.length, 2)
  assert.equal(waits, 39, 'candidate and flag propagation are retried before publishing')
  assert.equal(flag.variations.current.release, sha)
  await adapter({ ref, sha, generation: 1, selector: record.selector, resources: record.candidate.resources, active: null })
  assert.equal(writes, 1, 'a retry must not write the already active flag again')
})

test('does not publish a flag if the candidate remains unavailable', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'preview-activation-'))
  t.after(() => rmSync(directory, { force: true, recursive: true }))
  const record = newRelease({ ref, sha })
  const stem = createHash('sha256').update(`${record.selector}:${sha}`).digest('hex').slice(0, 24)
  record.candidate = { sha, generation: 1, phase: 'activating', resources: { gateway: `status-p-${stem}-gateway` } }
  let waits = 0
  let attempts = 0
  const adapter = createActivationAdapter({ store: { list: async () => [{ record }] }, appId: 'app', accountId: 'account', token: 'token', dispatcherName: 'dispatcher', dispatcherSource: '/trusted/dispatcher.ts', directory,
    run: async () => {}, verificationSecret: 'x'.repeat(32), previewUrl: 'https://preview.example', accessTeamDomain: 'team.cloudflareaccess.com', accessAud: 'aud', serviceTokenId: 'client.access', wait: async () => { waits++ },
    fetchImpl: async url => {
      assert.equal(url, 'https://preview.example/__preview/verify', 'Flagship must not be changed')
      attempts++
      return { ok: false, status: 503 }
    },
  })
  await assert.rejects(adapter({ ref, sha, generation: 1, selector: record.selector, resources: record.candidate.resources, active: null }), /Private candidate verification failed after 60 seconds \(HTTP 503\)/)
  assert.equal(attempts, 61)
  assert.equal(waits, 60)
})

test('reports the last HTTP status after the full propagation window', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'preview-activation-'))
  t.after(() => rmSync(directory, { force: true, recursive: true }))
  const record = newRelease({ ref, sha })
  const stem = createHash('sha256').update(`${record.selector}:${sha}`).digest('hex').slice(0, 24)
  record.candidate = { sha, generation: 1, phase: 'activating', resources: { gateway: `status-p-${stem}-gateway` } }
  let flag = null
  let waits = 0
  let attempts = 0
  const adapter = createActivationAdapter({ store: { list: async () => [{ record }] }, appId: 'app', accountId: 'account', token: 'token', dispatcherName: 'dispatcher', dispatcherSource: '/trusted/dispatcher.ts', directory,
    run: async () => {}, verificationSecret: 'x'.repeat(32), previewUrl: 'https://preview.example', accessTeamDomain: 'team.cloudflareaccess.com', accessAud: 'aud', serviceTokenId: 'client.access', wait: async () => { waits++ },
    fetchImpl: async (url, options) => {
      if (url === 'https://preview.example/__preview/verify') {
        if (options.headers['X-Status-Preview-Verify'].includes('.active.')) { attempts++; return { ok: false, status: 503 } }
        return { ok: true, headers: new Headers({ 'X-Status-Preview-Commit': sha }) }
      }
      if (options.method === 'POST') { flag = JSON.parse(options.body); return { ok: true, status: 200, json: async () => ({ success: true, result: flag }) } }
      return flag ? { ok: true, status: 200, json: async () => ({ success: true, result: flag }) } : { status: 404 }
    },
  })
  await assert.rejects(adapter({ ref, sha, generation: 1, selector: record.selector, resources: record.candidate.resources, active: null }), /after 120 seconds \(HTTP 503\)/)
  assert.equal(attempts, 121)
  assert.equal(waits, 120)
})

test('reuses only a cleared tombstone for a branch with no active release', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'preview-activation-'))
  t.after(() => rmSync(directory, { force: true, recursive: true }))
  const record = newRelease({ ref, sha })
  const stem = createHash('sha256').update(`${record.selector}:${sha}`).digest('hex').slice(0, 24)
  record.candidate = { sha, generation: 1, phase: 'activating', resources: { gateway: `status-p-${stem}-gateway` } }
  const tombstone = { type: 'json', enabled: true, default_variation: 'current', rules: [], variations: { current: {} } }

  async function attempt(initial, active = null) {
    let flag = structuredClone(initial)
    let writes = 0
    const adapter = createActivationAdapter({ store: { list: async () => [{ record }] }, appId: 'app', accountId: 'account', token: 'token', dispatcherName: 'dispatcher', dispatcherSource: '/trusted/dispatcher.ts', directory,
      run: async () => {}, verificationSecret: 'x'.repeat(32), previewUrl: 'https://preview.example', accessTeamDomain: 'team.cloudflareaccess.com', accessAud: 'aud', serviceTokenId: 'client.access', wait: async () => {},
      fetchImpl: async (url, options) => {
        if (url === 'https://preview.example/__preview/verify') return { ok: true, status: 204, headers: new Headers({ 'X-Status-Preview-Commit': sha }) }
        if (options.method === 'PUT') { writes++; flag = JSON.parse(options.body) }
        return { ok: true, status: 200, json: async () => ({ success: true, result: flag }) }
      },
    })
    try {
      await adapter({ ref, sha, generation: 1, selector: record.selector, resources: record.candidate.resources, active })
      return { writes, flag }
    } catch (error) {
      return { writes, error }
    }
  }

  const reused = await attempt(tombstone)
  assert.equal(reused.writes, 1)
  assert.deepEqual(reused.flag.variations.current, { selector: record.selector, release: sha })
  const incompatible = [
    { flag: tombstone, active: { sha: 'b'.repeat(40) } },
    { flag: { ...tombstone, enabled: false } },
    { flag: { ...tombstone, type: 'string' } },
    { flag: { ...tombstone, rules: [{ priority: 1 }] } },
    { flag: { ...tombstone, variations: { current: {}, other: {} } } },
    { flag: { ...tombstone, variations: { current: [] } } },
    { flag: { ...tombstone, variations: { current: { selector: 'branch-other', release: sha } } } },
  ]
  for (const { flag, active } of incompatible) {
    const result = await attempt(flag, active)
    assert.equal(result.writes, 0)
    assert.match(result.error?.message || '', /Unexpected existing Flagship state/)
  }
})
