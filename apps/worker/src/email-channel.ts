/** Deployment-managed email destinations; channel records store only an approved ID. */
export type EmailDestination = { id: string; name: string; address: string }
export type EmailChannelEnv = { EMAIL_READY?: string; EMAIL_FROM?: string; EMAIL_DESTINATIONS?: string; EMAIL?: SendEmail }

export function validEmailAddress(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value) && !value.includes('..')
}

/** Invalid configuration fails closed, including duplicate IDs or destinations. */
export function emailDestinations(value: string | undefined): Map<string, EmailDestination> {
  try {
    const parsed: unknown = JSON.parse(value ?? '[]')
    if (!Array.isArray(parsed) || parsed.length > 20) return new Map()
    const result = new Map<string, EmailDestination>()
    const addresses = new Set<string>()
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return new Map()
      const { id, name, address } = entry as Record<string, unknown>
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id) || typeof name !== 'string' || !name.trim() || name.length > 100 || !validEmailAddress(address) || result.has(id) || addresses.has(address.toLowerCase())) return new Map()
      result.set(id, { id, name: name.trim(), address })
      addresses.add(address.toLowerCase())
    }
    return result
  } catch { return new Map() }
}

/** A changed sender or recipient invalidates previously approved channel configuration. */
export async function emailChannelFingerprint(from: string, address: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([from, address]))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export function emailReady(env: EmailChannelEnv): boolean {
  return env.EMAIL_READY === 'true' && validEmailAddress(env.EMAIL_FROM) && emailDestinations(env.EMAIL_DESTINATIONS).size > 0 && !!env.EMAIL && typeof env.EMAIL.send === 'function'
}

function htmlText(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}

/** A resolved send means the service accepted the message, not that the inbox received it. */
export async function sendApprovedEmail(
  env: EmailChannelEnv,
  recipientId: string,
  fingerprint: string,
  event: { monitorName: string; status: 'up' | 'degraded' | 'down'; scheduledAt: number } | null,
  preflight?: () => Promise<boolean>,
): Promise<'sent' | 'unavailable' | 'delivery_failed' | 'deferred'> {
  if (!emailReady(env) || !env.EMAIL_FROM || !env.EMAIL) return 'unavailable'
  const recipient = emailDestinations(env.EMAIL_DESTINATIONS).get(recipientId)
  if (!recipient || await emailChannelFingerprint(env.EMAIL_FROM, recipient.address) !== fingerprint) return 'unavailable'
  const monitorName = event && Array.from(event.monitorName, char => { const code = char.charCodeAt(0); return code < 32 || code === 127 ? ' ' : char }).join('').slice(0, 200)
  const subject = event ? `Monitor ${event.status}: ${monitorName}` : 'Status page notification test'
  const text = event ? `Monitor ${monitorName} changed to ${event.status} at ${new Date(event.scheduledAt).toISOString()}.` : 'This is a test notification from the status page.'
  try {
    if (preflight && !await preflight()) return 'deferred'
    await env.EMAIL.send({ from: env.EMAIL_FROM, to: recipient.address, subject, text, html: `<p>${htmlText(text)}</p>` })
    return 'sent'
  } catch { return 'delivery_failed' }
}
