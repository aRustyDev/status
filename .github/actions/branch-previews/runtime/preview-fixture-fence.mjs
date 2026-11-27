import { withActiveBranchExecution } from './branch-preview-fence.mjs'

// The controller-owned fixture is the only route to synthetic monitor,
// Actions, and CAS targets. Hold a private execution lease for every request;
// an expired, inactive or draining release must not perform fixture work.
export function wrapPreviewFixture(app) {
  return {
    async fetch(request, env, ctx) {
      let response
      try {
        await withActiveBranchExecution(env, async isCurrent => {
          if (!await isCurrent()) return
          const { PREVIEW_FENCE, INVENTORY, FLAGS, ...safe } = env
          response = await app.fetch(request, safe, ctx)
        })
      } catch { return new Response(null, {status:503}) }
      return response || new Response(null, {status:503})
    },
  }
}
