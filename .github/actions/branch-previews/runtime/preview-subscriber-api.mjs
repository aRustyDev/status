import { branchPreviewEmailProxy } from './preview-mailer.mjs'

// This is controller-authored. Feature code receives only a read-only
// authorization callback, an isolated application database, and the narrow
// mailer proxy; it never receives the fence service or an execution token.
export function wrapBranchSubscriberApi(app) {
  return {
    async fetch(request, env, ctx) {
      const { PREVIEW_SELECTOR:selector, PREVIEW_RELEASE:release, PREVIEW_SUBSCRIBER_SCOPE:scope, DB } = env
      if (!/^branch-[a-f0-9]{24}$/.test(selector || '') || !/^[a-f0-9]{40}$/.test(release || '') || !/^[a-f0-9]{64}$/.test(scope || '') || env.PREVIEW_DATABASE_ISOLATED !== 'true' || !DB) return new Response(null,{status:503})
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(selector))
      if ([...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('') !== scope) return new Response(null,{status:503})
      const { PREVIEW_MAILER:mailer, PREVIEW_AUTHORIZATION:authorization, PREVIEW_FENCE, INVENTORY, FLAGS, EMAIL, ...safe } = env
      void [PREVIEW_FENCE, INVENTORY, FLAGS, EMAIL] // Omit privileged bindings from feature code.
      if (!authorization || typeof authorization.fetch !== 'function') return new Response(null,{status:503})
      const isCurrent = async () => {
        try { return (await authorization.fetch('https://preview-authorization.internal/check')).status === 204 } catch { return false }
      }
      try {
        if (!await isCurrent()) return new Response(null,{status:503})
        if (!await isCurrent()) return new Response(null,{status:503})
        return await app.fetch(request,{...safe,PREVIEW_BRANCH_MODE:'schema',PREVIEW_SLOT:'1',PREVIEW_TARGET:'a',PREVIEW_SUBSCRIBER_AUTHORIZE:isCurrent,SUBSCRIBER_EMAIL:branchPreviewEmailProxy(mailer)},ctx)
      } catch { return new Response(null,{status:503}) }
    },
  }
}
