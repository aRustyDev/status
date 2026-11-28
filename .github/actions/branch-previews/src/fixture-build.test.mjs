import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

test('feature builds retain legacy API and generate a stable, unwrapped approved API', async t => {
  const root=mkdtempSync(path.join(tmpdir(),'fixture-build-'))
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const buildUrl=pathToFileURL(fileURLToPath(new URL('./build.mjs',import.meta.url))).href
  const installUrl=pathToFileURL(fileURLToPath(new URL('./installation.mjs',import.meta.url))).href
  const outputs=[]
  for (const label of ['first','second']) {
    const feature=path.join(root,label,'feature'), output=path.join(root,label,'artifact')
    mkdirSync(path.join(feature,'apps/worker/src'),{recursive:true}); mkdirSync(path.join(feature,'migrations'),{recursive:true})
    writeFileSync(path.join(feature,'app.mjs'),`export default {fetch(_request,env){return Response.json({ready:env.SUBSCRIBERS_READY})}}`)
    writeFileSync(path.join(feature,'gateway.mjs'),`export default {fetch(){return new Response('gateway')}}`)
    writeFileSync(path.join(feature,'cas.mjs'),`export default {fetch(){return new Response('cas')}}`)
    for (const file of ['subscriber-delivery.ts','subscribers.ts','email-channel.ts','idempotency.ts','index.ts']) writeFileSync(path.join(feature,'apps/worker/src',file),'export {}\n')
    writeFileSync(path.join(feature,'apps/worker/src/preview-subscriber-scheduler.ts'),`export const PREVIEW_SUBSCRIBER_SCHEDULER_CONTRACT=2; export function flushPreviewSubscriberDeliveries(){}`)
    writeFileSync(path.join(feature,'migrations/0001.sql'),'SELECT 1;')
    const manifest={build:[],database:{migrations:'migrations'},schemaSubscriber:{entry:'apps/worker/src/preview-subscriber-scheduler.ts'},fixtures:{casEntry:'cas.mjs',subscriberEntry:'apps/worker/src/preview-subscriber-scheduler.ts'},components:{api:{entry:'app.mjs'},gateway:{entry:'gateway.mjs'}}}
    const script=`import {configure} from ${JSON.stringify(installUrl)}; import {buildArtifact} from ${JSON.stringify(buildUrl)}; configure('1468279539',JSON.parse(process.argv[1])); await buildArtifact(process.argv[2],process.argv[3])`
    execFileSync(process.execPath,['--input-type=module','-e',script,JSON.stringify(manifest),feature,output],{stdio:'pipe'})
    const modules=['api','api-feature','gateway','cas','subscriber','subscriber-feature']
    outputs.push(Object.fromEntries(modules.map(id=>[id,readFileSync(path.join(output,'workers',`${id}.mjs`))])))
    const legacy=(await import(pathToFileURL(path.join(output,'workers/api.mjs')).href)).default
    const raw=(await import(pathToFileURL(path.join(output,'workers/api-feature.mjs')).href)).default
    const env={PREVIEW_BRANCH_MODE:'schema',SUBSCRIBERS_READY:'true'}
    assert.equal((await (await legacy.fetch(new Request('https://example.test/'),env)).json()).ready,'false')
    assert.equal((await (await raw.fetch(new Request('https://example.test/'),env)).json()).ready,'true')
  }
  for (const id of Object.keys(outputs[0])) assert.deepEqual(outputs[0][id],outputs[1][id],`${id} artifact differs across paths`)
})
