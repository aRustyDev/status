import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'
import { installation } from './installation.mjs'
import { ownedPath } from './manifest.mjs'

// This runs only in the credential-free feature build job.
export async function buildArtifact(feature, output) {
  const {manifest, header} = installation()
  for (const [program,...args] of manifest.build) execFileSync(program,args,{cwd:feature,stdio:'inherit'})
  mkdirSync(path.join(output,'workers'),{recursive:true})
  for (const [id,c] of Object.entries(manifest.components)) {
    const entry = ownedPath(feature,c.entry)
    const options = {bundle:true, format:'esm', platform:'browser', target:'es2022', conditions:['workerd','worker','browser'], external:['cloudflare:*','node:*'], outfile:path.join(output,'workers',id+'.mjs')}
    if (id === 'gateway') {
      // The wrapper verifies the binding selected by the dispatcher before calling the app.
      const contents = [
        'import app from ' + JSON.stringify(entry),
        'export default { async fetch(request, env, ctx) {',
        'const selectorHeader = ' + JSON.stringify(header),
        'if (request.headers.get(selectorHeader) !== env.PREVIEW_SELECTOR || request.headers.get("X-Status-Preview-Release") !== env.PREVIEW_RELEASE) return new Response(null,{status:503})',
        'if (request.method === "GET" && new URL(request.url).pathname === "/__preview/verify" && request.headers.get("X-Status-Preview-Probe") === "1") return new Response(null,{status:204})',
        'const headers = new Headers(request.headers)',
        'for (const key of [selectorHeader,"X-Status-Preview-Release","X-Status-Preview-Probe","CF-Access-Client-Secret","CF-Access-Client-Id"]) headers.delete(key)',
        'const bindings = {...env,PREVIEW_SELECTOR:undefined,PREVIEW_RELEASE:' + (c.releaseVar ? 'env.PREVIEW_RELEASE' : 'undefined') + '}',
        'return app.fetch(new Request(request,{headers}),bindings,ctx) }}',
      ].join('\n')
      await build({...options, stdin:{contents,resolveDir:feature,sourcefile:'generated-preview-gateway.mjs'}})
    } else await build({...options,entryPoints:[entry]})
    if (c.assets) cpSync(ownedPath(feature,c.assets),path.join(output,'assets',id),{recursive:true})
  }
  cpSync(ownedPath(feature,manifest.database.migrations),path.join(output,'migrations'),{recursive:true})
}
