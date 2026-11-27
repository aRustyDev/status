import { installation } from './installation.mjs'
import { branchPolicy } from './release-contract.mjs'

/** Read authoritative branch state from GitHub without executing branch code. */
export function githubBranches({ repository, token, defaultBranch = 'main', dispatchRepository = repository, dispatchToken = token, dispatchBranch = defaultBranch, apiUrl = 'https://api.github.com', fetcher = fetch }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') || !token) throw new Error('Missing GitHub branch credentials')
  const root = `${apiUrl.replace(/\/$/, '')}/repos/${repository}`
  async function request(url, missingAllowed = false, options = {}, credential = token) {
    const response = await fetcher(url, { ...options, headers: { Authorization: `Bearer ${credential}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' } })
    if (response.status === 404 && missingAllowed) return null
    if (!response.ok) throw new Error(`GitHub branch lookup failed (${response.status})`)
    if (response.status === 204) return null
    return response.json()
  }
  async function latestCI(ref, sha) {
      const policy = branchPolicy(ref)
      if (!policy || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid CI branch or SHA')
      const params = new URLSearchParams({ branch: policy.name, head_sha: sha, per_page: '100' })
      const result = await request(`${root}/actions/workflows/${installation().manifest.workflows.ci}/runs?${params}`)
      if (!Array.isArray(result?.workflow_runs)) throw new Error('Invalid CI workflow runs')
      const matching = result.workflow_runs.filter(run => run.head_sha === sha && run.head_branch === policy.name && run.head_repository?.full_name === repository && ['push', 'workflow_dispatch'].includes(run.event))
      if (!matching.length) return null
      for (const run of matching) {
        if (!Number.isSafeInteger(run.id) || run.id < 1 || !Number.isFinite(Date.parse(run.run_started_at || run.created_at))) throw new Error('Invalid CI workflow run metadata')
      }
      // A later failure or rerun supersedes an earlier success for the same commit.
      matching.sort((a, b) => Date.parse(b.run_started_at || b.created_at) - Date.parse(a.run_started_at || a.created_at) || b.id - a.id)
      return matching[0]
  }
  return {
    async head(ref) {
      const policy = branchPolicy(ref)
      if (!policy) throw new Error('Invalid branch ref')
      // The commits endpoint responds 422 for an absent branch. The exact Git
      // reference endpoint returns 404, allowing deletion to be distinguished
      // from validation and permission errors without interpreting messages.
      const path = policy.name.split('/').map(encodeURIComponent).join('/')
      const result = await request(`${root}/git/ref/heads/${path}`, true)
      if (result === null) return null
      if (result.ref !== ref || result.object?.type !== 'commit' || !/^[a-f0-9]{40}$/.test(result.object.sha || '')) throw new Error('Invalid GitHub branch reference')
      return result.object.sha
    },
    async list() {
      const found = []
      for (let page = 1; ; page++) {
        const results = await request(`${root}/branches?per_page=100&page=${page}`)
        if (!Array.isArray(results) || results.length > 100) throw new Error('Invalid GitHub branch list')
        for (const row of results) {
          const ref = `refs/heads/${row.name}`
          if (branchPolicy(ref)) {
            if (!/^[a-f0-9]{40}$/.test(row.commit?.sha || '')) throw new Error('Invalid GitHub branch SHA')
            found.push({ ref, sha: row.commit.sha })
          }
        }
        if (results.length < 100) return found
      }
    },
    async ciStatus(ref, sha) {
      const run = await latestCI(ref, sha)
      if (!run) return 'missing'
      if (run.status !== 'completed') return 'pending'
      return run.conclusion === 'success' ? 'success' : 'failure'
    },
    async verifiedRun(ref, sha) {
      const run = await latestCI(ref, sha)
      if (!run || run.status !== 'completed' || run.conclusion !== 'success' || await this.head(ref) !== sha) throw new Error('Commit is not the current tested branch head')
      return run.id
    },
    async dispatchCi(ref) {
      const policy = branchPolicy(ref)
      if (!policy) throw new Error('Invalid CI branch')
      if (dispatchRepository !== repository) return false
      await request(`${root}/actions/workflows/${installation().manifest.workflows.ci}/dispatches`, false, { method: 'POST', body: JSON.stringify({ ref: policy.name }) })
    },
    async dispatchPreview(ref, sha) {
      const policy = branchPolicy(ref)
      if (!policy || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid preview branch or SHA')
      const destination = apiUrl.replace(/\/$/, '') + '/repos/' + dispatchRepository
      await request(`${destination}/actions/workflows/${installation().manifest.workflows.preview}/dispatches`, false, { method: 'POST', body: JSON.stringify({ ref: dispatchBranch, inputs: { branch: policy.name, sha } }) }, dispatchToken)
    },
  }
}
