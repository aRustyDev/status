import { createHmac } from 'node:crypto'

// Send this header with a service-token-authenticated GET to /__preview/verify.
export function candidateVerificationHeader({ selector, sha, secret, mode = 'candidate', now = Date.now() }) {
  if (!/^branch-[0-9a-f]{24}$/.test(selector) || !/^[0-9a-f]{40}$/.test(sha) || !['candidate', 'active'].includes(mode) || typeof secret !== 'string' || secret.length < 32 || !Number.isSafeInteger(now) || String(now).length !== 13) {
    throw new Error('Invalid candidate verification parameters')
  }
  const signature = createHmac('sha256', secret).update(`${selector}\n${sha}\n${now}\n${mode}\nGET\n/__preview/verify`).digest('hex')
  return `${sha}.${now}.${mode}.${signature}`
}
