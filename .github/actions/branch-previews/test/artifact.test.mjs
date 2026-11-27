import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

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
