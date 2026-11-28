import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { parse } from 'yaml'

const repo = fileURLToPath(new URL('../../../..', import.meta.url))
const actionDir = fileURLToPath(new URL('..', import.meta.url))
const readWorkflow = name => parse(readFileSync(new URL(`../../../workflows/${name}.yml`, import.meta.url), 'utf8'))
const actionPrefix = 'aRustyDev/status/.github/actions/branch-previews@'
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

test('Status caller uses its own trusted reusable workflows and a consistent immutable controller', () => {
  const caller = readWorkflow('branch-previews')
  assert.equal(caller.jobs.deploy.uses, './.github/workflows/deploy.yml')
  assert.equal(caller.jobs.reconcile.uses, './.github/workflows/reconcile.yml')

  const deploy = readWorkflow('deploy')
  const reconcile = readWorkflow('reconcile')
  const operations = [
    ...deploy.jobs.build.steps,
    ...deploy.jobs.deploy.steps,
    ...reconcile.jobs.reconcile.steps,
  ].filter(step => step.uses?.startsWith(actionPrefix))
  assert.deepEqual(operations.map(step => step.with.operation), ['check', 'build', 'check', 'deploy', 'reconcile'])
  const refs = new Set(operations.map(step => step.uses.slice(actionPrefix.length)))
  assert.equal(refs.size, 1)
  assert.match([...refs][0], /^[0-9a-f]{40}$/)
})

test('the pinned controller is an ancestor and its dispatcher handles retired selectors', async t => {
  // GitHub's default checkout is shallow. A local full clone can verify the
  // historical pin without requiring network access in unit tests.
  if (git('rev-parse', '--is-shallow-repository') === 'true') {
    t.skip('requires full Git history to verify the pinned controller')
    return
  }
  const pin = readWorkflow('reconcile').jobs.reconcile.steps.find(step => step.uses?.startsWith(actionPrefix)).uses.slice(actionPrefix.length)
  assert.doesNotThrow(() => git('merge-base', '--is-ancestor', pin, 'refs/remotes/origin/main'), 'controller pin must be an ancestor of origin/main')
  const source = git('show', `${pin}:.github/actions/branch-previews/runtime/dispatcher.ts`)
  const result = await build({
    stdin: { contents: source, sourcefile: 'dispatcher.ts', resolveDir: actionDir, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', write: false,
  })
  const { createDispatcher } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
  const selector = `branch-${'a'.repeat(24)}`
  const env = {
    PREVIEW_HEADER: 'X-Test-Preview', FLAG_PREFIX: 'test-',
    FLAGS: {
      getBooleanDetails: async () => ({ value: true }),
      getObjectDetails: async () => ({ errorCode: 'FLAG_NOT_FOUND' }),
    },
  }
  const response = await createDispatcher().fetch(new Request('https://status.example/', { headers: { 'X-Test-Preview': selector } }), env)
  assert.equal(response.status, 404)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
})
