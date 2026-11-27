import { withActiveBranchExecution } from './branch-preview-fence.mjs'

// Private per-release service: deliberately exposes no lease tokens or
// inventory mutation operations to a feature Worker.
export default {
  async fetch(request, env) {
    const {PREVIEW_SELECTOR:selector,PREVIEW_RELEASE:release,PREVIEW_SUBSCRIBER_SCOPE:scope,DB,PREVIEW_FENCE}=env
    if (request.method !== 'GET' || new URL(request.url).pathname !== '/check') return new Response(null,{status:404})
    if (!/^branch-[a-f0-9]{24}$/.test(selector||'') || !/^[a-f0-9]{40}$/.test(release||'') || !/^[a-f0-9]{64}$/.test(scope||'') || env.PREVIEW_DATABASE_ISOLATED!=='true' || !DB || !PREVIEW_FENCE) return new Response(null,{status:503})
    try {
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(selector))
      if ([...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('')!==scope) return new Response(null,{status:503})
      let allowed=false
      await withActiveBranchExecution(env,async isCurrent=>{
        if (!await isCurrent()) return
        const lease=await DB.prepare(`INSERT INTO preview_subscriber_leases (scope,slot,target,release,expires_at)
          VALUES (?,1,'a',?,?) ON CONFLICT(slot) DO UPDATE SET expires_at=excluded.expires_at
          WHERE preview_subscriber_leases.scope=excluded.scope AND preview_subscriber_leases.release=excluded.release
          AND preview_subscriber_leases.target=excluded.target`).bind(scope,release,Date.now()+90_000).run()
        allowed=lease?.meta?.changes===1 && await isCurrent()
      })
      return new Response(null,{status:allowed ? 204 : 403})
    } catch { return new Response(null,{status:503}) }
  },
}
