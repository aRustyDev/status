import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parse } from 'yaml'

test('deploy retries download the artifact produced by the successful build attempt', () => {
  const workflow = parse(readFileSync(new URL('../../../workflows/deploy.yml', import.meta.url), 'utf8'))
  const { build, deploy } = workflow.jobs
  const upload = build.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'))
  const download = deploy.steps.find(step => step.uses?.startsWith('actions/download-artifact@') && step.if === '!inputs.fixture')
  const validate = deploy.steps.find(step => step.name === 'Validate the build artifact identity')
  assert.equal(build.outputs.artifact_name, upload.with.name)
  assert.equal(download.with.name, '${{ needs.build.outputs.artifact_name }}')
  assert.equal(validate.env.BUILD_ARTIFACT_NAME, download.with.name)
  assert.ok(deploy.steps.indexOf(validate) < deploy.steps.indexOf(download))
  assert.equal(validate.if, '!inputs.fixture')
  assert.equal(deploy.needs, 'build')

  // A build from attempt 1 remains valid during a failed-deploy retry; an
  // absent, cross-run, or malformed output must not fall back to downloading
  // every artifact. A full retry can instead use its newly built artifact.
  const run = name => execFileSync('bash', ['-c', validate.run], { env: { GITHUB_RUN_ID:'12345', BUILD_ARTIFACT_NAME:name }, stdio:'ignore' })
  for (const name of ['preview-12345-1', 'preview-12345-2']) assert.doesNotThrow(() => run(name))
  for (const name of ['', 'preview-12346-1', 'preview-12345-0', 'preview-12345-1-other']) assert.throws(() => run(name))

  const fixtureDownload = deploy.steps.find(step => step.name === 'Download artifact from the verified fixture CI run')
  assert.equal(fixtureDownload.if, 'inputs.fixture')
  assert.equal(fixtureDownload.with['run-id'], '${{ steps.verify.outputs.ci_run_id }}')
  assert.equal(fixtureDownload.with.name, "${{ format('preview-{0}', inputs.sha) }}")
})
