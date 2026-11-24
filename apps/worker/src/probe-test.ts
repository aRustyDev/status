/** Bound the private probe service call even if a binding never settles. */
export class ProbeTestTimeout extends Error {}

export async function requestProbeTest(
  service: { fetch(request: Request): Promise<Response> }, payload: unknown,
  callerSignal: AbortSignal, timeoutMs = 12_000,
): Promise<Response> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timeout = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new ProbeTestTimeout()), { once: true })
  })
  callerSignal.addEventListener('abort', abort, { once: true })
  if (callerSignal.aborted) abort()
  const timer = setTimeout(abort, timeoutMs)
  try {
    const request = new Request('https://probe.internal/test', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal,
    })
    const call = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new ProbeTestTimeout()
      return service.fetch(request)
    })
    return await Promise.race([call, timeout])
  } finally {
    clearTimeout(timer)
    callerSignal.removeEventListener('abort', abort)
  }
}
