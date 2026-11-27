import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { schemaBuildOptions } from './build.mjs'

test('schema approval artifacts are byte-stable across checkout paths', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'schema-artifact-'))
  t.after(() => rmSync(dir,{recursive:true,force:true}))
  const results = []
  for (const name of ['first','second']) {
    const root = path.join(dir,name)
    mkdirSync(root)
    writeFileSync(path.join(root,'source.js'),'export const example = 42\n')
    const {outputFiles} = await build(schemaBuildOptions({bundle:true,write:false,format:'esm',platform:'browser',stdin:{contents:`import {example} from ${JSON.stringify(path.join(root,'source.js'))}; export default example`,resolveDir:root,sourcefile:'schema-api.mjs'}}))
    results.push(outputFiles[0].contents)
  }
  assert.deepEqual(results[0],results[1])
})

test('approved raw worker bundles are byte-stable across checkout paths', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fixture-artifact-'))
  t.after(() => rmSync(dir,{recursive:true,force:true}))
  const results = []
  for (const name of ['first','second']) {
    const root = path.join(dir,name)
    mkdirSync(root)
    writeFileSync(path.join(root,'dependency.js'),'export function value() { return 42 }\n')
    writeFileSync(path.join(root,'worker.js'),`import {value} from './dependency.js'; export default { fetch() {return new Response(String(value()))} }`)
    const {outputFiles} = await build(schemaBuildOptions({bundle:true,write:false,format:'esm',platform:'browser',entryPoints:[path.join(root,'worker.js')]}))
    results.push(outputFiles[0].contents)
  }
  assert.deepEqual(results[0],results[1])
})
