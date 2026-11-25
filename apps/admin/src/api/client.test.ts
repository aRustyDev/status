import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './client'
import { setMutationActor } from '@bsp/shared'

describe('mutation request intent', () => {
  beforeEach(() => { sessionStorage.clear(); setMutationActor('test-user') })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('sends an actor-bound backup key and reuses it after an ambiguous response', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: 'Timeout' }, { status: 504 }))
      .mockResolvedValueOnce(Response.json({ id: 'backup' }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ id: 'next-backup' }, { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(api.post('/admin/backups', {})).rejects.toThrow(/may have completed/)
    await expect(api.post('/admin/backups', {})).resolves.toEqual({ id: 'backup' })
    await api.post('/admin/backups', {})
    const headers = fetchMock.mock.calls.map(call => call[1].headers as Record<string, string>)
    expect(headers[0]!['Idempotency-Actor']).toBe('test-user')
    expect(headers[0]!['Idempotency-Key']).toMatch(/^\d{13}\.[0-9a-f-]{36}$/)
    expect(headers[1]!['Idempotency-Key']).toBe(headers[0]!['Idempotency-Key'])
    expect(headers[2]!['Idempotency-Key']).not.toBe(headers[0]!['Idempotency-Key'])
  })

  it('keeps the same key after expiry and an ambiguous response, then clears it after a confirmed result', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: 'Expired' }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ error: 'Timeout' }, { status: 504 }))
      .mockImplementation(() => Promise.resolve(Response.json({ id: 'one' }, { status: 201 })))
    vi.stubGlobal('fetch', fetchMock)
    const payload = { name: 'Test service', manualStatus: 'operational', position: 0 }
    await expect(api.post('/admin/components', payload)).rejects.toThrow()
    await expect(api.post('/admin/components', payload)).rejects.toThrow(/may have completed/)
    await expect(api.post('/admin/components', payload)).resolves.toEqual({ id: 'one' })
    const key = (fetchMock.mock.calls[0]![1].headers as Record<string, string>)['Idempotency-Key']
    expect(key).toMatch(/^\d{13}\.[0-9a-f-]{36}$/)
    expect(fetchMock.mock.calls.slice(1, 3).map(call => (call[1].headers as Record<string, string>)['Idempotency-Key'])).toEqual([key, key])
    await api.post('/admin/components', payload)
    expect((fetchMock.mock.calls[3]![1].headers as Record<string, string>)['Idempotency-Key']).not.toBe(key)
  })

  it('requires an explicit checked-result confirmation before abandoning an expired key', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ error: 'Earlier save may have completed', code: 'IDEMPOTENCY_EXPIRED' }, { status: 409 })))
    vi.stubGlobal('fetch', fetchMock)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false).mockReturnValueOnce(false).mockReturnValueOnce(true)
    const body = { name: 'Expired intent', manualStatus: 'operational', position: 0 }
    await expect(api.post('/admin/components', body)).rejects.toThrow()
    await expect(api.post('/admin/components', body)).rejects.toThrow()
    const first = (fetchMock.mock.calls[0]![1].headers as Record<string, string>)['Idempotency-Key']
    expect((fetchMock.mock.calls[1]![1].headers as Record<string, string>)['Idempotency-Key']).toBe(first)
    await expect(api.post('/admin/components', body)).rejects.toThrow()
    expect((fetchMock.mock.calls[2]![1].headers as Record<string, string>)['Idempotency-Key']).not.toBe(first)
    expect(confirm).toHaveBeenCalledTimes(3)
    confirm.mockRestore()
  })

  it('keeps an unresolved key bound to its verified account across account switching', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ error: 'Timeout' }, { status: 504 })))
    vi.stubGlobal('fetch', fetchMock)
    const body = { name: 'Account-specific intent', manualStatus: 'operational', position: 0 }
    setMutationActor('account-a')
    await expect(api.post('/admin/components', body)).rejects.toThrow()
    setMutationActor('account-b')
    await expect(api.post('/admin/components', body)).rejects.toThrow()
    setMutationActor('account-a')
    await expect(api.post('/admin/components', body)).rejects.toThrow()
    const headers = fetchMock.mock.calls.map(call => call[1].headers as Record<string, string>)
    expect(headers.map(value => value['Idempotency-Actor'])).toEqual(['account-a', 'account-b', 'account-a'])
    expect(headers[0]!['Idempotency-Key']).toBe(headers[2]!['Idempotency-Key'])
    expect(headers[0]!['Idempotency-Key']).not.toBe(headers[1]!['Idempotency-Key'])
  })

  it('blocks an edited create after an ambiguous save until the earlier result is explicitly checked', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ error: 'Timeout' }, { status: 504 })))
    vi.stubGlobal('fetch', fetchMock)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    const first = { name: 'Original', manualStatus: 'operational', position: 0 }
    const changed = { ...first, name: 'Changed' }
    await expect(api.post('/admin/components', first)).rejects.toThrow()
    await expect(api.post('/admin/components', changed)).rejects.toThrow(/earlier save may have completed/i)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await expect(api.post('/admin/components', first)).rejects.toThrow()
    const originalKey = (fetchMock.mock.calls[0]![1].headers as Record<string, string>)['Idempotency-Key']
    expect((fetchMock.mock.calls[1]![1].headers as Record<string, string>)['Idempotency-Key']).toBe(originalKey)
    await expect(api.post('/admin/components', changed)).rejects.toThrow(/earlier save may have completed/i)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await expect(api.post('/admin/components', changed)).rejects.toThrow()
    expect((fetchMock.mock.calls[2]![1].headers as Record<string, string>)['Idempotency-Key']).not.toBe(originalKey)
    confirm.mockRestore()
  })

  it('allows a correction after a definitive validation failure with no earlier ambiguous attempt', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ error: 'Invalid name' }, { status: 400 }))
      .mockImplementation(() => Promise.resolve(Response.json({ id: 'one' }, { status: 201 })))
    vi.stubGlobal('fetch', fetchMock)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await expect(api.post('/admin/components', { name: '', manualStatus: 'operational', position: 0 })).rejects.toThrow()
    await expect(api.post('/admin/components', { name: 'Corrected', manualStatus: 'operational', position: 0 })).resolves.toEqual({ id: 'one' })
    expect(confirm).not.toHaveBeenCalled()
    confirm.mockRestore()
  })

  it('keeps an uncertain key when a successful response body cannot be read', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => { throw new Error('truncated') } })
      .mockResolvedValueOnce(Response.json({ error: 'Rejected' }, { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const first = { name: 'Original', manualStatus: 'operational', position: 0 }
    await expect(api.post('/admin/components', first)).rejects.toThrow(/may have completed/)
    await expect(api.post('/admin/components', first)).rejects.toThrow()
    await expect(api.post('/admin/components', { ...first, name: 'Changed' })).rejects.toThrow(/earlier save may have completed/i)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    confirm.mockRestore()
  })

  it('retains a shared key until concurrent attempts settle, including a late timeout', async () => {
    let release!: (response: Response) => void
    const delayed = new Promise<Response>(resolve => { release = resolve })
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ id: 'one' }, { status: 201 }))
      .mockReturnValueOnce(delayed).mockImplementation(() => Promise.resolve(Response.json({ id: 'one' }, { status: 201 })))
    vi.stubGlobal('fetch', fetchMock)
    const payload = { name: 'Concurrent service', manualStatus: 'operational', position: 0 }
    const first = api.post('/admin/components', payload), second = api.post('/admin/components', payload)
    await first
    release(Response.json({ error: 'Timeout' }, { status: 504 }))
    await expect(second).rejects.toThrow(/may have completed/)
    await api.post('/admin/components', payload)
    const keys = fetchMock.mock.calls.map(call => (call[1].headers as Record<string, string>)['Idempotency-Key'])
    expect(keys[1]).toBe(keys[0]); expect(keys[2]).toBe(keys[0])
  })

  it.each(['fetch', 'body'])('times out a stalled mutation %s and preserves its key', async phase => {
    vi.useFakeTimers()
    const stalled = new Promise<never>(() => {})
    const fetchMock = vi.fn().mockImplementation(() => phase === 'fetch' ? stalled : Promise.resolve({ ok: true, status: 201, json: () => stalled }))
    vi.stubGlobal('fetch', fetchMock)
    const payload = { name: `Stalled ${phase}`, manualStatus: 'operational', position: 0 }
    const first = api.post('/admin/components', payload)
    const rejected = expect(first).rejects.toThrow(/may have completed/)
    await vi.advanceTimersByTimeAsync(20_001)
    await rejected
    const options = fetchMock.mock.calls[0]![1] as { headers:Record<string,string>; signal:AbortSignal }
    expect(options.signal.aborted).toBe(true)
    fetchMock.mockImplementation(() => Promise.resolve(Response.json({ id: 'one' }, { status: 201 })))
    await api.post('/admin/components', payload)
    expect((fetchMock.mock.calls[1]![1].headers as Record<string,string>)['Idempotency-Key']).toBe(options.headers['Idempotency-Key'])
  })
})

describe('bounded monitor reads', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('aborts a stalled monitor request instead of leaving cached health indefinitely', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockImplementation(() => new Promise(() => {}))
    vi.stubGlobal('fetch', fetchMock)
    const request = api.get('/admin/monitors', { timeoutMs: 15_000 })
    const rejected = expect(request).rejects.toThrow('Request timed out')
    await vi.advanceTimersByTimeAsync(15_001)
    await rejected
    expect((fetchMock.mock.calls[0]![1] as { signal: AbortSignal }).signal.aborted).toBe(true)
  })

  it('also bounds a response whose body never finishes', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => new Promise(() => {}) })
    vi.stubGlobal('fetch', fetchMock)
    const request = api.get('/admin/monitors', { timeoutMs: 15_000 })
    const rejected = expect(request).rejects.toThrow('Request timed out')
    await vi.advanceTimersByTimeAsync(15_001)
    await rejected
    expect((fetchMock.mock.calls[0]![1] as { signal: AbortSignal }).signal.aborted).toBe(true)
  })

  it('bounds an unkeyed monitor test without creating a mutation intent', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockImplementation(() => new Promise(() => {}))
    vi.stubGlobal('fetch', fetchMock)
    const request = api.post('/admin/monitors/test', { endpointId: 'approved' }, { timeoutMs: 15_000 })
    const rejected = expect(request).rejects.toThrow('Request timed out')
    await vi.advanceTimersByTimeAsync(15_001)
    await rejected
    const options = fetchMock.mock.calls[0]![1] as { signal: AbortSignal; headers: Record<string, string> }
    expect(options.signal.aborted).toBe(true)
    expect(options.headers['Idempotency-Key']).toBeUndefined()
  })
})
