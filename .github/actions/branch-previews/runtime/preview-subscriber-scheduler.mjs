import { withActiveBranchExecution } from './branch-preview-fence.mjs'

const encoder = new TextEncoder()

// The scheduler is controller-owned and has no application DB or mail binding.
// A separate feature Worker handles its private, signed dispatch request.
export default {
  async scheduled(event, env) {
    await withActiveBranchExecution(env, async isCurrent => {
      if (!env.SUBSCRIBER_FEATURE || typeof env.PREVIEW_SCHEDULE_SECRET !== 'string' || env.PREVIEW_SCHEDULE_SECRET.length < 32) throw new Error('Missing subscriber scheduler configuration')
      if (!Number.isSafeInteger(event.scheduledTime)) throw new Error('Invalid scheduled time')
      const key = await crypto.subtle.importKey('raw', encoder.encode(env.PREVIEW_SCHEDULE_SECRET), {name:'HMAC',hash:'SHA-256'}, false, ['sign'])
      const bytes = await crypto.subtle.sign('HMAC', key, encoder.encode(String(event.scheduledTime)))
      const signature = [...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join('')
      if (!await isCurrent()) return
      const response = await env.SUBSCRIBER_FEATURE.fetch('https://preview-subscriber.internal/__preview/scheduled', {
        method:'POST', headers:{'content-type':'application/json','x-preview-schedule-signature':signature}, body:JSON.stringify({scheduledTime:event.scheduledTime}),
      })
      if (!response.ok) throw new Error('Preview subscriber dispatch failed')
    })
  },
}
