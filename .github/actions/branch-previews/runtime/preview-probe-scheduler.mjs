import { withActiveBranchExecution } from './branch-preview-fence.mjs'

const encoder = new TextEncoder()

// Runs only on the controller-built Worker. The feature probe has no cron.
export default {
  async scheduled(event, env) {
    await withActiveBranchExecution(env, async isCurrent => {
      if (!env.PROBE || typeof env.PREVIEW_SCHEDULE_SECRET !== 'string' || env.PREVIEW_SCHEDULE_SECRET.length < 32) throw new Error('Missing preview probe configuration')
      if (!Number.isSafeInteger(event.scheduledTime)) throw new Error('Invalid scheduled time')
      const message = String(event.scheduledTime)
      const key = await crypto.subtle.importKey('raw', encoder.encode(env.PREVIEW_SCHEDULE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      const signature = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
      if (!await isCurrent()) return
      const response = await env.PROBE.fetch('https://preview-probe.internal/__preview/scheduled', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-preview-schedule-signature': signature }, body: JSON.stringify({ scheduledTime: event.scheduledTime }),
      })
      if (!response.ok) throw new Error('Preview probe did not complete')
    })
  },
}
