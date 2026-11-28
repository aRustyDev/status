import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

test('an independent application builds a routable single-Worker artifact', async t => {
  const root = mkdtempSync(join(tmpdir(),'fixture-preview-test-'))
  t.after(() => rmSync(root,{recursive:true,force:true}))
  mkdirSync(join(root,'schema'))
  writeFileSync(join(root,'schema/0001.sql'),'CREATE TABLE checkup(id INTEGER);')
  writeFileSync(join(root,'app.mjs'),"export default {fetch(r,e){return Response.json({release:e.PREVIEW_RELEASE,method:r.method})}}")
  const config = {version:1, compatibilityDate:'2026-11-23', branches:{feat:'dev'}, workflows:{ci:'independent.yml',preview:'deploy-preview.yml'}, database:{migrations:'schema',seed:'seed.sql'},build:[],smokePath:'/',components:{gateway:{suffix:'gateway',entry:'app.mjs',releaseVar:true}}}
  writeFileSync(join(root,'manifest.yml'),JSON.stringify(config))
  const artifact=join(root,'prepared')
  execFileSync(process.execPath,[new URL('../src/cli.mjs',import.meta.url).pathname],{env:{...process.env,PREVIEW_CONTROL_DIR:root,PREVIEW_MANIFEST:'manifest.yml',PREVIEW_REPOSITORY_ID:'12345',PREVIEW_ACTION:'build',PREVIEW_FEATURE_DIR:root,PREVIEW_ARTIFACT_DIR:artifact}})
  assert.match(readFileSync(join(artifact,'migrations/0001.sql'),'utf8'),/CREATE TABLE/)
  const app=(await import(pathToFileURL(join(artifact,'workers/gateway.mjs')))).default
  const bindings={PREVIEW_SELECTOR:'branch-test',PREVIEW_RELEASE:'abc'}
  const url='https://fixture.example/'
  assert.equal((await app.fetch(new Request(url),bindings)).status,503)
  const request=new Request(url,{headers:{'X-Branch-Preview':'branch-test','X-Status-Preview-Release':'abc'}})
  assert.deepEqual(await (await app.fetch(request,bindings)).json(),{release:'abc',method:'GET'})
})

test('all compatibility fixture artifact hashes are independent of checkout path', async t => {
  const root=mkdtempSync(join(tmpdir(),'preview-repro-test-'))
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const entry='apps/worker/src/preview-subscriber-scheduler.ts'
  const config={version:1,compatibilityDate:'2026-11-23',branches:{schema:'schema'},workflows:{ci:'ci.yml',preview:'preview.yml'},database:{migrations:'schema',seed:'seed.sql'},schemaSubscriber:{entry},fixtures:{casEntry:'cas.mjs',subscriberEntry:entry},build:[],smokePath:'/',components:{api:{suffix:'api',entry:'apps/worker/src/index.ts',assets:'assets'},gateway:{suffix:'gateway',entry:'apps/worker/src/index.ts',releaseVar:true}}}
  writeFileSync(join(root,'manifest.yml'),JSON.stringify(config))
  function prepare(name) {
    const source=join(root,name), output=join(root,name+'-output')
    mkdirSync(join(source,'schema'),{recursive:true});mkdirSync(join(source,'assets'));mkdirSync(join(source,'apps/worker/src'),{recursive:true})
    writeFileSync(join(source,'schema','0001.sql'),'CREATE TABLE item(id INTEGER);')
    writeFileSync(join(source,'assets','index.html'),'<html>hello</html>')
    writeFileSync(join(source,'shared.mjs'),"export const message = 'hello'\n")
    writeFileSync(join(source,'apps/worker/src/index.ts'),"import { message } from '../../../shared.mjs'; export default {fetch(){return new Response(message)}}\n")
    writeFileSync(join(source,entry),"import { message } from '../../../shared.mjs'; export const PREVIEW_SUBSCRIBER_SCHEDULER_CONTRACT=2; export async function flushPreviewSubscriberDeliveries(){return message}\n")
    for (const name of ['subscriber-delivery.ts','subscribers.ts','email-channel.ts','idempotency.ts']) writeFileSync(join(source,'apps/worker/src',name),'export {}\n')
    writeFileSync(join(source,'cas.mjs'),"import { message } from './shared.mjs'; export default {fetch(){return new Response(message)}}\n")
    execFileSync(process.execPath,[new URL('../src/cli.mjs',import.meta.url).pathname],{env:{...process.env,PREVIEW_CONTROL_DIR:root,PREVIEW_MANIFEST:'manifest.yml',PREVIEW_REPOSITORY_ID:'12345',PREVIEW_ACTION:'build',PREVIEW_FEATURE_DIR:source,PREVIEW_ARTIFACT_DIR:output}})
    return output
  }
  function hashes(dir,prefix='') {
    return readdirSync(join(dir,prefix),{withFileTypes:true}).flatMap(entry=>{
      const relative=join(prefix,entry.name)
      return entry.isDirectory() ? hashes(dir,relative) : [[relative,createHash('sha256').update(readFileSync(join(dir,relative))).digest('hex')]]
    }).sort(([a],[b])=>a.localeCompare(b))
  }
  const a=hashes(prepare('first-checkout')), b=hashes(prepare('second-checkout'))
  for (const name of ['workers/api.mjs','workers/api-feature.mjs','workers/gateway.mjs','workers/cas.mjs','workers/subscriber.mjs','workers/subscriber-feature.mjs','workers/subscriber-source.json']) assert.ok(a.some(([p])=>p===name),name)
  assert.notEqual(a.find(([p])=>p==='workers/api.mjs')[1],a.find(([p])=>p==='workers/api-feature.mjs')[1],'legacy wrapper and raw feature API must remain separate')
  assert.deepEqual(a,b)
})
