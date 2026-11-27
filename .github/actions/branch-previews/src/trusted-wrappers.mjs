import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { build } from 'esbuild'

// Feature artifacts are hostile data in this privileged job. In particular,
// esbuild must never resolve their imports against controller files or secrets.
function denyFeatureImports(featurePaths) {
  const canonical = p => { try { return realpathSync(p) } catch { return path.resolve(p) } }
  const paths = new Set(featurePaths.map(canonical))
  return { name: 'deny-feature-imports', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => {
      if (paths.has(canonical(args.importer || '.')) && !/^(?:cloudflare:|node:)/.test(args.path)) {
        return { errors: [{ text: 'Feature artifact has an unresolved import' }] }
      }
    })
    builder.onLoad({ filter: /\.mjs$/ }, args => {
      if (!paths.has(canonical(args.path))) return
      // Do not let a feature-supplied source map cause a local filesystem read.
      const contents = readFileSync(args.path, 'utf8').replace(/^\s*\/\/[#@]\s*sourceMappingURL=.*$/gm, '')
        .replace(/\/\*[#@]\s*sourceMappingURL=[\s\S]*?\*\//g, '')
      return { contents, loader: 'js', resolveDir: path.dirname(args.path) }
    })
  } }
}

export async function buildTrustedPreviewWrappers({ control, branchDir, dir, probe = false, subscriber = false }) {
  if (!path.isAbsolute(control) || !path.isAbsolute(branchDir) || !path.isAbsolute(dir)) throw new Error('Trusted wrapper paths must be absolute')
  // Runtime code comes from the pinned controller action, never from a feature
  // artifact or the consumer checkout.
  const runtime = fileURLToPath(new URL('../runtime/', import.meta.url))
  const mailer = path.join(runtime, 'preview-mailer.mjs')
  const subscriberDispatch = path.join(runtime, 'preview-subscriber-dispatch.mjs')
  const fence = path.join(runtime, 'branch-preview-fence.mjs')
  const featureApi = path.join(branchDir, 'workers/api.mjs')
  const featureProbe = path.join(branchDir, 'workers/probe.mjs')
  const featureSubscriber = path.join(branchDir, 'workers/subscriber-feature.mjs')
  const output = {}
  const plugin = denyFeatureImports([featureApi, featureProbe, featureSubscriber])
  const options = { bundle:true, format:'esm', platform:'browser', target:'es2022', conditions:['workerd','worker','browser'], external:['cloudflare:*','node:*'], plugins:[plugin], logLevel:'silent' }
  const compile = async (name, contents) => {
    const outfile = path.join(dir, `trusted-${name}.mjs`)
    await build({ ...options, stdin:{ contents, resolveDir:control, sourcefile:`trusted-${name}.mjs` }, outfile })
    output[name] = outfile
  }
  if (subscriber) {
    await compile('api', [
      `import app from ${JSON.stringify(featureApi)}`,
      `import { branchPreviewEmailProxy } from ${JSON.stringify(mailer)}`,
      `export default { fetch(request, env, ctx) {`,
      `const { PREVIEW_MAILER, PREVIEW_FENCE, EMAIL, ...safe } = env`,
      `safe.SUBSCRIBER_EMAIL = branchPreviewEmailProxy(PREVIEW_MAILER)`,
      `return app.fetch(request, safe, ctx) } }`,
    ].join('\n'))
    await compile('subscriberFeature', [
      `import { PREVIEW_SUBSCRIBER_SCHEDULER_CONTRACT, flushPreviewSubscriberDeliveries } from ${JSON.stringify(featureSubscriber)}`,
      `import { dispatchBranchSubscribers } from ${JSON.stringify(subscriberDispatch)}`,
      `export default { fetch(request, env) {`,
      `return dispatchBranchSubscribers(request, env, flushPreviewSubscriberDeliveries, PREVIEW_SUBSCRIBER_SCHEDULER_CONTRACT) } }`,
    ].join('\n'))
    await compile('subscriberScheduler', `export { default } from ${JSON.stringify(path.join(runtime,'preview-subscriber-scheduler.mjs'))}`)
    await compile('mailer', [
      `import { handleBranchPreviewMail } from ${JSON.stringify(mailer)}`,
      `import { withActiveBranchExecution } from ${JSON.stringify(fence)}`,
      `export default { fetch(request, env) { return handleBranchPreviewMail(request, env, withActiveBranchExecution) } }`,
    ].join('\n'))
  }
  if (probe) {
    await compile('probe', [
      `import probe from ${JSON.stringify(featureProbe)}`,
      `const encoder = new TextEncoder()`,
      `export default { async fetch(request, env, ctx) {`,
      `const { PREVIEW_SCHEDULE_SECRET: secret, PREVIEW_FENCE, ...safe } = env`,
      `if (new URL(request.url).pathname !== '/__preview/scheduled') return probe.fetch(request, safe, ctx)`,
      `if (request.method !== 'POST' || typeof secret !== 'string' || secret.length < 32) return new Response(null,{status:403})`,
      `try { const signature = request.headers.get('x-preview-schedule-signature') || ''`,
      `if (!/^[a-f0-9]{64}$/.test(signature)) return new Response(null,{status:403})`,
      `if (!request.body || (request.headers.has('content-length') && (!/^\\d+$/.test(request.headers.get('content-length')) || Number(request.headers.get('content-length'))>512))) return new Response(null,{status:400})`,
      `const reader=request.body.getReader(), chunks=[]; let size=0`,
      `for (;;) { const {value,done}=await reader.read(); if(done) break; size+=value.byteLength; if(size>512){void reader.cancel().catch(()=>{});return new Response(null,{status:400})} chunks.push(value) }`,
      `const bytesBody=new Uint8Array(size); let offset=0; for(const chunk of chunks){bytesBody.set(chunk,offset);offset+=chunk.byteLength}`,
      `const input = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytesBody))`,
      `if (!Number.isSafeInteger(input.scheduledTime) || Math.abs(Date.now()-input.scheduledTime)>120000) return new Response(null,{status:403})`,
      `const key = await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify'])`,
      `const bytes = Uint8Array.from(signature.match(/../g),byte=>parseInt(byte,16))`,
      `if (!await crypto.subtle.verify('HMAC',key,bytes,encoder.encode(String(input.scheduledTime)))) return new Response(null,{status:403})`,
      `await probe.scheduled({scheduledTime:input.scheduledTime},safe,ctx); return new Response(null,{status:204})`,
      `} catch { return new Response(null,{status:503}) } } }`,
    ].join('\n'))
    await compile('probeScheduler', `export { default } from ${JSON.stringify(path.join(runtime,'preview-probe-scheduler.mjs'))}`)
  }
  return output
}
