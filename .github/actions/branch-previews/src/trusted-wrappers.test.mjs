import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { buildTrustedPreviewWrappers } from './trusted-wrappers.mjs'

const control = fileURLToPath(new URL('../../../../', import.meta.url))
function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(),'trusted-preview-test-'))
  const branchDir = path.join(dir,'artifact'), workers = path.join(branchDir,'workers'), output = path.join(dir,'out')
  mkdirSync(workers, {recursive:true}); mkdirSync(output)
  t.after(() => rmSync(dir, {recursive:true,force:true}))
  return { dir, workers, output, branchDir }
}

test('builds trusted wrappers without executing feature code and hides privileged bindings', async t => {
  const h = fixture(t)
  writeFileSync(path.join(h.workers,'api.mjs'), `throw new Error('legacy wrapped API must not execute')`)
  writeFileSync(path.join(h.workers,'api-feature.mjs'), `globalThis.__fixtureExecuted = true; export default { fetch(_request, env) { return new Response(JSON.stringify({keys:Object.keys(env),send:typeof env.SUBSCRIBER_EMAIL?.send})) } }`)
  writeFileSync(path.join(h.workers,'probe.mjs'), `export default { fetch(_r,env) { return new Response(JSON.stringify(Object.keys(env))) }, async scheduled(_e,env) { globalThis.__scheduledBindings=Object.keys(env) } }`)
  writeFileSync(path.join(h.workers,'subscriber-feature.mjs'), `export const PREVIEW_SUBSCRIBER_SCHEDULER_CONTRACT=2; export const PREVIEW_BRANCH_DELIVERY_CONTEXT_CONTRACT=1; export async function flushPreviewSubscriberDeliveries() {}`)
  const fixtureSource=fileURLToPath(new URL('../runtime/fixture/index.mjs', import.meta.url))
  // The consumer checkout need not contain any of the trusted fixture code.
  const files = await buildTrustedPreviewWrappers({ control:h.dir, branchDir:h.branchDir, dir:h.output, fixtureSource, probe:true, subscriber:true })
  assert.equal(globalThis.__fixtureExecuted, undefined)
  assert.deepEqual(Object.keys(files).sort(), ['api','authorization','fixture','mailer','probe','probeScheduler','subscriberFeature','subscriberScheduler'])
  const app = (await import(pathToFileURL(files.api).href)).default
  const selector='branch-'+'a'.repeat(24), scope=createHash('sha256').update(selector).digest('hex')
  const result = await app.fetch(new Request('https://example.test/'), { PREVIEW_SELECTOR:selector, PREVIEW_RELEASE:'b'.repeat(40), PREVIEW_SUBSCRIBER_SCOPE:scope, PREVIEW_DATABASE_ISOLATED:'true', PREVIEW_AUTHORIZATION:{async fetch(){return new Response(null,{status:204})}}, PREVIEW_MAILER:{fetch(){}}, PREVIEW_FENCE:{}, EMAIL:{}, DB:{} })
  const data = await result.json()
  assert.equal(data.send, 'function')
  assert.ok(data.keys.includes('DB'))
  for (const key of ['PREVIEW_MAILER','PREVIEW_AUTHORIZATION','PREVIEW_FENCE','EMAIL']) assert.equal(data.keys.includes(key), false)
  const probe = (await import(pathToFileURL(files.probe).href)).default
  const probeResponse = await probe.fetch(new Request('https://example.test/'), {PREVIEW_SCHEDULE_SECRET:'secret', PREVIEW_FENCE:{}, DB:{}})
  assert.deepEqual(await probeResponse.json(), ['DB'])
  assert.doesNotMatch(readFileSync(files.api,'utf8'), /sourceMappingURL=/)
  delete globalThis.__fixtureExecuted
})

test('refuses imports from a feature artifact into privileged controller files', async t => {
  const h = fixture(t)
  const secret = path.join(h.dir, 'controller-secret.mjs')
  writeFileSync(secret, 'export default "PRIVATE-CONTROLLER-SECRET"')
  writeFileSync(path.join(h.workers,'api-feature.mjs'), `import secret from ${JSON.stringify(secret)}; export default secret`)
  writeFileSync(path.join(h.workers,'subscriber-feature.mjs'), 'export const PREVIEW_SUBSCRIBER_SCHEDULER_CONTRACT=2; export const PREVIEW_BRANCH_DELIVERY_CONTEXT_CONTRACT=1; export function flushPreviewSubscriberDeliveries() {}')
  await assert.rejects(buildTrustedPreviewWrappers({control,branchDir:h.branchDir,dir:h.output,subscriber:true}), /unresolved import/)
})

test('refuses a feature scheduler without the delivery context contract', async t => {
  const h=fixture(t)
  writeFileSync(path.join(h.workers,'api-feature.mjs'),'export default {fetch() {return new Response()}}')
  writeFileSync(path.join(h.workers,'subscriber-feature.mjs'),'export const PREVIEW_SUBSCRIBER_SCHEDULER_CONTRACT=2; export function flushPreviewSubscriberDeliveries() {}')
  await assert.rejects(buildTrustedPreviewWrappers({control,branchDir:h.branchDir,dir:h.output,subscriber:true}),/PREVIEW_BRANCH_DELIVERY_CONTEXT_CONTRACT/)
})
