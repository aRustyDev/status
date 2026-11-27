import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { runBranchSubscriberScheduler } from '../runtime/branch-subscriber-scheduler.mjs'
import { wrapSchemaSubscriberApi } from '../runtime/schema-subscriber-api.mjs'

test('schema scheduler requires active branch route, unexpired matching fence, and reauthorizes every send', async () => {
  const selector = 'branch-'+'a'.repeat(24), release = 'b'.repeat(40), scope = createHash('sha256').update(selector).digest('hex')
  let enabled = true, route = {selector,release}, lease = {expires_at:Date.now()+60_000}, sends = 0
  const env = {PREVIEW_BRANCH_MODE:'schema',PREVIEW_SELECTOR:selector,PREVIEW_RELEASE:release,PREVIEW_SUBSCRIBER_SCOPE:scope,
    FLAGS:{getBooleanDetails:async () => ({value:enabled}),getObjectDetails:async () => ({value:route})},
    DB:{prepare:() => ({bind:() => ({first:async () => lease})})}}
  await runBranchSubscriberScheduler(env,async (_env, authorize) => {
    if (await authorize()) sends++
    route = {...route,release:'c'.repeat(40)}
    if (await authorize()) sends++
  })
  assert.equal(sends,1)
  route = {selector,release}; lease = null
  await runBranchSubscriberScheduler(env,async () => sends++)
  assert.equal(sends,1)
  lease = {expires_at:Date.now()-1}
  await runBranchSubscriberScheduler(env,async () => sends++)
  enabled = false
  await runBranchSubscriberScheduler(env,async () => sends++)
  assert.equal(sends,1)
})

test('schema API refuses subscriber readiness when lease is missing or expired and supplies a fresh verifier', async () => {
  const selector='branch-'+'a'.repeat(24), release='b'.repeat(40), scope=createHash('sha256').update(selector).digest('hex')
  let live = true, observed
  const env = {PREVIEW_BRANCH_MODE:'schema',PREVIEW_SELECTOR:selector,PREVIEW_RELEASE:release,PREVIEW_SUBSCRIBER_SCOPE:scope,SUBSCRIBERS_READY:'true',SUBSCRIBER_EMAIL_READY:'true',SUBSCRIBER_EMAIL:{send:async()=>{}},
    FLAGS:{getBooleanDetails:async()=>({value:true}),getObjectDetails:async()=>({value:{selector,release}})},
    DB:{prepare:()=>({bind:()=>({first:async()=>live ? {expires_at:Date.now()+10000} : null})})}}
  const wrapped = wrapSchemaSubscriberApi({fetch:async (_request,received) => { observed=received; return new Response(null,{status:204}) }})
  await wrapped.fetch(new Request('https://example.test/'),env)
  assert.equal(observed.SUBSCRIBERS_READY,'true')
  assert.equal(await observed.PREVIEW_SUBSCRIBER_AUTHORIZE(),true)
  live = false
  assert.equal(await observed.PREVIEW_SUBSCRIBER_AUTHORIZE(),false)
  await wrapped.fetch(new Request('https://example.test/'),env)
  assert.equal(observed.SUBSCRIBERS_READY,'false')
  assert.equal(observed.SUBSCRIBER_EMAIL_READY,'false')
  assert.equal(observed.SUBSCRIBER_EMAIL,undefined)
})
