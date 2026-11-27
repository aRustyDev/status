import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import CloudflareDeliveryHistory from './CloudflareDeliveryHistory'

vi.mock('../api/client', () => ({ api: { get: vi.fn(), post: vi.fn() } }))
const delivery = { id: 'job:channel', createdAt: 1700000000000, updatedAt: 1700000001000, monitorName: 'API', monitorStatus: 'down', state: 'failed', channelId: 'channel', channelName: 'On call', channelType: 'webhook', event: 'alert', attemptCount: 3, errorCode: 'delivery_failed', canRetry: true }
function setup(client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })) {
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/admin/delivery-history']}><CloudflareDeliveryHistory /></MemoryRouter></QueryClientProvider>)
  return userEvent.setup()
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.get).mockImplementation(async path => {
    if (path.includes('/notifications?')) return { items: [delivery], total: 1, page: 1, pages: 1, filters: [{ id: 'channel', name: 'On call' }] }
    if (path.includes('/notifications/')) return { ...delivery, attempts: [{ attemptNumber: 1, completedAt: 1700000001000, result: 'delivery_failed' }] }
    return { items: [], total: 0, page: 1, pages: 1, filters: [] }
  })
})
describe('Cloudflare delivery history', () => {
  it('filters notifications, displays details and queues an eligible retry', async () => {
    const user = setup()
    expect(await screen.findByText('API')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Subscribers/ })).toBeDisabled()
    await user.selectOptions(screen.getByLabelText('Status'), 'failed')
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('status=failed')))
    await user.selectOptions(screen.getByLabelText('Channel'), 'channel')
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('channelId=channel')))
    await user.selectOptions(screen.getByLabelText('Event'), 'alert')
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('event=alert')))
    await user.click(screen.getByRole('button', { name: 'Show details for API via On call' }))
    expect(await screen.findByText(/#1 · Delivery failed/)).toBeInTheDocument()
    vi.mocked(api.post).mockResolvedValueOnce({ ok: true })
    await user.click(screen.getByRole('button', { name: 'Retry now' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/delivery-history/notifications/job%3Achannel/retry', {}))
  })
  it('shows action runs without offering retry', async () => {
    vi.mocked(api.get).mockImplementation(async path => {
      if (path.includes('/actions?')) return { items: [{ id: 'run', createdAt: 1700000000000, updatedAt: 1700000001000, monitorName: 'API', monitorStatus: 'down', state: 'uncertain', actionName: 'Recover' }], total: 1, page: 1, pages: 1, filters: [] }
      if (path.includes('/actions/')) return { id: 'run', updatedAt: 1700000001000, state: 'uncertain' }
      return { items: [], total: 0, page: 1, pages: 1, filters: [] }
    })
    const user = setup()
    await user.click(screen.getByRole('tab', { name: 'Actions' }))
    await user.click(await screen.findByRole('button', { name: 'Show details for API via Recover' }))
    expect(await screen.findByText(/external system may have acted/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry now' })).not.toBeInTheDocument()
  })
  it('returns to an available page when old deliveries expire', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    let expired = false
    vi.mocked(api.get).mockImplementation(async path => {
      const page = Number(new URL(path, 'https://example.test').searchParams.get('page'))
      if (path.includes('/notifications?')) return {
        items: page === 1 ? [{ ...delivery, monitorName: 'First page' }] : expired ? [] : [{ ...delivery, monitorName: 'Second page' }],
        total: expired ? 1 : 21, page, pages: expired ? 1 : 2, filters: [],
      }
      return { items: [], total: 0, page: 1, pages: 1, filters: [] }
    })
    const user = setup(client)
    await user.click(await screen.findByRole('button', { name: 'Next page' }))
    expect(await screen.findByText('Second page')).toBeInTheDocument()
    expired = true
    await act(async () => { await client.invalidateQueries({ queryKey: ['delivery-history', 'notifications'] }) })
    expect(await screen.findByText('First page')).toBeInTheDocument()
    expect(screen.queryByText('No deliveries found')).not.toBeInTheDocument()
  })
  it('refreshes eligibility when a retry is rejected', async () => {
    let eligible = true
    vi.mocked(api.get).mockImplementation(async path => {
      if (path.includes('/notifications?')) return { items: [delivery], total: 1, page: 1, pages: 1, filters: [] }
      if (path.includes('/notifications/')) return { ...delivery, canRetry: eligible, attempts: [] }
      return { items: [], total: 0, page: 1, pages: 1, filters: [] }
    })
    const user = setup()
    await user.click(await screen.findByRole('button', { name: 'Show details for API via On call' }))
    const retry = await screen.findByRole('button', { name: 'Retry now' })
    eligible = false
    vi.mocked(api.post).mockRejectedValueOnce(new Error('Delivery is no longer eligible'))
    await user.click(retry)
    expect(await screen.findByText(/Could not queue the retry/)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry now' })).not.toBeInTheDocument())
  })
})
