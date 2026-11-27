import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { build } from 'esbuild'
import { installation } from './installation.mjs'
import { ownedPath } from './manifest.mjs'

// Approval applies to final module bytes. Remove path-bearing source comments
// so identical reviewed source produces the same artifact in different runners.
export const schemaBuildOptions = options => ({ ...options, minify:true, legalComments:'none' })

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
    } else if (id === 'api' && manifest.schemaSubscriber) {
      const wrapper = fileURLToPath(new URL('../runtime/schema-subscriber-api.mjs', import.meta.url))
      const contents = `import app from ${JSON.stringify(entry)}\nimport { wrapSchemaSubscriberApi } from ${JSON.stringify(wrapper)}\nexport default wrapSchemaSubscriberApi(app)\n`
      await build({...schemaBuildOptions(options),stdin:{contents,resolveDir:feature,sourcefile:'schema-preview-api.mjs'}})
    } else await build({...options,entryPoints:[entry]})
    if (c.assets) cpSync(ownedPath(feature,c.assets),path.join(output,'assets',id),{recursive:true})
  }
  // Build this optional module without credentials; the protected deploy step
  // only installs it for an exact, independently approved schema release.
  const subscriberEntry = manifest.schemaSubscriber && path.join(feature, manifest.schemaSubscriber.entry)
  if (subscriberEntry && existsSync(subscriberEntry)) {
    const source = ownedPath(feature, manifest.schemaSubscriber.entry)
    const wrapper = fileURLToPath(new URL('../runtime/branch-subscriber-scheduler.mjs', import.meta.url))
    const contents = `import { runBranchSubscriberScheduler } from ${JSON.stringify(wrapper)}\nimport { PREVIEW_SUBSCRIBER_SCHEDULER_CONTRACT, flushPreviewSubscriberDeliveries } from ${JSON.stringify(source)}\nexport default { async scheduled(_event, env) { if (PREVIEW_SUBSCRIBER_SCHEDULER_CONTRACT === 2) await runBranchSubscriberScheduler(env, flushPreviewSubscriberDeliveries) } }\n`
    await build(schemaBuildOptions({bundle:true, format:'esm', platform:'browser', target:'es2022', conditions:['workerd','worker','browser'], external:['cloudflare:*','node:*'], outfile:path.join(output,'workers','subscriber.mjs'), stdin:{contents,resolveDir:feature,sourcefile:'schema-subscriber.mjs'}}))
    const files = ['preview-subscriber-scheduler.ts', 'subscriber-delivery.ts', 'subscribers.ts', 'email-channel.ts', 'idempotency.ts', 'index.ts']
    const hashes = Object.fromEntries(files.map(name => [name, createHash('sha256').update(readFileSync(ownedPath(feature, `apps/worker/src/${name}`))).digest('hex')]))
    writeFileSync(path.join(output,'workers','subscriber-source.json'), JSON.stringify(hashes))
  }
  cpSync(ownedPath(feature,manifest.database.migrations),path.join(output,'migrations'),{recursive:true})
}
