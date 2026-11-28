import path from 'node:path'
import { appendFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { main } from './controller-cli.mjs'
import { configure } from './installation.mjs'
import { loadManifest } from './manifest.mjs'
import { githubBranches } from './branch-github.mjs'
import { buildArtifact } from './build.mjs'

const env = process.env
const root = path.resolve(env.PREVIEW_CONTROL_DIR)
const manifest = loadManifest(root, env.PREVIEW_MANIFEST)
configure(env.PREVIEW_REPOSITORY_ID, manifest)
const action = env.PREVIEW_ACTION
if (action === 'build') {
  await buildArtifact(path.resolve(env.PREVIEW_FEATURE_DIR), path.resolve(env.PREVIEW_ARTIFACT_DIR))
  if (env.PREVIEW_ARCHIVE) {
    const artifact = path.resolve(env.PREVIEW_ARTIFACT_DIR)
    const entries = ['workers', 'migrations']
    if (existsSync(path.join(artifact, 'assets'))) entries.push('assets')
    execFileSync('tar', ['-C', artifact, '-czf', path.resolve(env.PREVIEW_ARCHIVE), ...entries])
  }
} else if (action === 'check') {
  const branches = githubBranches({repository:env.PREVIEW_SOURCE_REPOSITORY || env.GITHUB_REPOSITORY,token:env.PREVIEW_SOURCE_TOKEN || env.GH_TOKEN,apiUrl:env.GITHUB_API_URL,defaultBranch:env.PREVIEW_DEFAULT_BRANCH})
  const ref = 'refs/heads/' + env.PREVIEW_BRANCH
  const run = await branches.verifiedRun(ref, env.PREVIEW_SHA)
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, 'ci_run_id=' + run + '\n')
} else if (action === 'deploy' || action === 'reconcile') {
  await main(env)
} else throw new Error('Unsupported release action')
