import test from 'node:test'
import assert from 'node:assert/strict'
import { githubBranches } from './branch-github.mjs'

const sha = 'a'.repeat(40)
test('reads current branch SHA and distinguishes a deleted branch', async () => {
  const urls = []
  const api = githubBranches({ repository: 'owner/repo', token: 'token', fetcher: async url => {
    urls.push(url)
    return url.endsWith('feat%2Fdeleted') ? { status: 404 } : { ok: true, json: async () => ({ sha }) }
  } })
  assert.equal(await api.head('refs/heads/feat/example'), sha)
  assert.equal(await api.head('refs/heads/feat/deleted'), null)
  await assert.rejects(api.head('refs/heads/main'), /Invalid branch/)
  assert.match(urls[0], /feat%2Fexample$/)
})
test('lists eligible branches across pages without treating errors as deletion', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ name: `other/${i}`, commit: { sha } }))
  const api = githubBranches({ repository: 'owner/repo', token: 'token', fetcher: async url => ({ ok: true, json: async () => url.endsWith('page=1') ? page1 : [{ name: 'schema/new', commit: { sha } }, { name: 'main', commit: { sha } }] }) })
  assert.deepEqual(await api.list(), [{ ref: 'refs/heads/schema/new', sha }])
  const failing = githubBranches({ repository: 'owner/repo', token: 'token', fetcher: async () => ({ ok: false, status: 403 }) })
  await assert.rejects(failing.list(), /403/)
})

test('checks CI for the exact SHA and dispatches only eligible branches', async () => {
  const calls = []
  const api = githubBranches({ repository: 'owner/repo', token: 'token', fetcher: async (url, options) => {
    calls.push({ url, options })
    if (options.method === 'POST') return { ok: true, status: 204 }
    return { ok: true, json: async () => ({ workflow_runs: [{ id: 1, run_started_at: '2026-01-01T00:00:00Z', head_repository: { full_name: 'owner/repo' }, head_sha: sha, head_branch: 'feat/new', status: 'completed', conclusion: 'success', event: 'push' }] }) }
  } })
  assert.equal(await api.ciStatus('refs/heads/feat/new', sha), 'success')
  assert.equal(await api.ciStatus('refs/heads/feat/new', 'b'.repeat(40)), 'missing')
  await api.dispatchPreview('refs/heads/feat/new', sha)
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { ref: 'main', inputs: { branch: 'feat/new', sha } })
  await assert.rejects(api.dispatchPreview('refs/heads/main', sha), /Invalid/)
})

test('uses the latest same-repository CI run and rejects stale success', async () => {
  const base = { head_sha: sha, head_branch: 'feat/new', event: 'push', head_repository: { full_name: 'owner/repo' } }
  const runs = [
    { ...base, id: 1, run_started_at: '2026-01-01T00:00:00Z', status: 'completed', conclusion: 'success' },
    { ...base, id: 2, run_started_at: '2026-01-01T01:00:00Z', status: 'completed', conclusion: 'failure' },
    { ...base, id: 3, run_started_at: '2026-01-01T02:00:00Z', status: 'completed', conclusion: 'success', head_repository: { full_name: 'fork/repo' } },
  ]
  const api = githubBranches({ repository: 'owner/repo', token: 'token', fetcher: async () => ({ ok: true, json: async () => ({ workflow_runs: runs }) }) })
  assert.equal(await api.ciStatus('refs/heads/feat/new', sha), 'failure')
  runs[1].status = 'in_progress'
  assert.equal(await api.ciStatus('refs/heads/feat/new', sha), 'pending')
  runs[1].status = 'completed'
  runs[1].conclusion = 'success'
  assert.equal(await api.ciStatus('refs/heads/feat/new', sha), 'success')
})
