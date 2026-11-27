import { createBranchSubscriberAuthorization } from './branch-subscriber-scheduler.mjs'

// The feature code receives only this per-request verifier, which it must
// recheck immediately before calling the email provider. Missing, expired,
// revoked and unavailable authorization always disables subscriber readiness.
export function wrapSchemaSubscriberApi(app) {
  return {
    async fetch(request, env, ctx) {
      if (env.PREVIEW_BRANCH_MODE !== 'schema') return app.fetch(request, env, ctx)
      const authorize = createBranchSubscriberAuthorization(env)
      const active = await authorize()
      const selected = { ...env, PREVIEW_SUBSCRIBER_AUTHORIZE: authorize }
      if (!active) Object.assign(selected, {SUBSCRIBERS_READY:'false', SUBSCRIBER_EMAIL_READY:'false', SUBSCRIBER_EMAIL:undefined})
      return app.fetch(request, selected, ctx)
    },
    async scheduled(controller, env, ctx) { if (app.scheduled) return app.scheduled(controller, env, ctx) },
  }
}
