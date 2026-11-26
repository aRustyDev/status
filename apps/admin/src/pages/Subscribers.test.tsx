import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SUBSCRIBER_EVENT_TYPES, subscriptionMethodStatuses, type AdminSubscriptionSettings } from '@bsp/shared'
import { api } from '../api/client'
import { ToastProvider } from '@better-forge/ui'
import SubscribersPage from './Subscribers'

vi.mock('../api/client', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), downloadPost: vi.fn() } }))

const base = {
  enabled: true,
  allowEmail: true,
  allowWebhook: true,
  allowSlack: true,
  allowedEvents: [...SUBSCRIBER_EVENT_TYPES],
  allowComponentScope: false,
  rssEnabled: false,
  apiEnabled: false,
}

function settings(overrides: Partial<AdminSubscriptionSettings> = {}): AdminSubscriptionSettings {
  const merged = { ...base, ...overrides }
  return {
    ...merged,
    updatedAt: 1,
    smtpConfigured: false,
    publicUrl: '',
    statusPagePrivate: false,
    methods: subscriptionMethodStatuses(merged, { smtpConfigured: false, publicUrl: '' }),
    ...overrides,
  }
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><ToastProvider><SubscribersPage /></ToastProvider></MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('SubscribersPage methods', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.get).mockImplementation(async (path: string) => (path === '/admin/subscribers/settings' ? settings() : []) as never)
    vi.mocked(api.post).mockResolvedValue({ subscribers: [], stats: { total: 0, active: 0, pending: 0, unsubscribed: 0, disabled: 0 }, total: 0, page: 1, limit: 25, pages: 1 } as never)
  })

  it('keeps the table headers when empty and resets a filter from the empty row', async () => {
    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByText('No subscribers yet')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Destination' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delivery history' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: /^Pending/ }))
    expect(await screen.findByText('No subscribers match this filter')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'show all subscribers' }))
    expect(screen.getByRole('button', { name: /^All/ })).toHaveAttribute('aria-pressed', 'true')
    expect(await screen.findByText('No subscribers yet')).toBeInTheDocument()
  })

  it('disables unsupported methods and keeps email available when configured', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('tab', { name: /^Settings/ }))
    expect(within(screen.getByTestId('method-email')).getByText('Not available')).toBeInTheDocument()
    expect(within(screen.getByTestId('method-email')).getByText('Email delivery is unavailable.')).toBeInTheDocument()
    for (const method of ['webhook', 'slack', 'rss', 'api']) {
      expect(within(screen.getByTestId(`method-${method}`)).getByRole('switch')).toBeDisabled()
    }
  })

})

describe('SubscribersPage table', () => {
  const subscriber = {
    id: 7, type: 'email', email: 'reader@example.test', webhookUrl: null, webhookMethod: null, webhookHeaderNames: [],
    notifyOnFailure: false, status: 'active', events: [...SUBSCRIBER_EVENT_TYPES], monitorIds: [], tags: [],
    lastNotifiedAt: null, lastError: null, consecutiveFailures: 0, createdAt: 1,
  }
  const list = (pages = 2) => ({ subscribers: [subscriber], stats: { total: 1, active: 1, pending: 0, unsubscribed: 0, disabled: 0 }, total: 1, page: 1, limit: 25, pages })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.get).mockImplementation(async (path: string) => (
      path === '/admin/subscribers/settings' ? settings() : path === '/admin/monitors' ? [] : list()
    ) as never)
    vi.mocked(api.delete).mockResolvedValue(undefined as never)
    vi.mocked(api.downloadPost).mockResolvedValue(undefined as never)
    vi.mocked(api.post).mockResolvedValue(list() as never)
  })

  const subscriberCalls = () => vi.mocked(api.post).mock.calls.filter(([path]) => path === '/admin/subscribers/search').map(([, body]) => body as { search?: string; page?: number; status?: string })

  it('debounces search, pages with the shared pagination and confirms deletes', async () => {
    const user = userEvent.setup()
    renderPage()
    expect(await screen.findByText('reader@example.test')).toBeInTheDocument()

    await user.type(screen.getByRole('searchbox', { name: 'Search subscribers' }), 'rea')
    await waitFor(() => expect(subscriberCalls().some((body) => body.search === 'rea')).toBe(true))
    expect(subscriberCalls().filter((body) => body.search === 'r' || body.search === 're')).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Next page' }))
    await waitFor(() => expect(subscriberCalls().at(-1)).toMatchObject({ page: 2 }))

    await user.click(screen.getByRole('button', { name: 'Delete reader@example.test' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/admin/subscribers/7'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('uses a pressed segmented control for the status filter', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('reader@example.test')
    expect(screen.getByRole('button', { name: /^All/ })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: /^Paused/ }))
    expect(screen.getByRole('button', { name: /^Paused/ })).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(subscriberCalls().at(-1)).toMatchObject({ status: 'disabled' }))
  })

  it('links each row to the delivery history of its subscriber', async () => {
    renderPage()
    expect(await screen.findByRole('button', { name: 'Delivery history for reader@example.test is unavailable' })).toBeDisabled()
  })

  it('exports the filtered list, or only the selected rows, and deletes a selection in bulk', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('reader@example.test')

    await user.click(screen.getByRole('button', { name: /^Active/ }))
    await user.click(screen.getByRole('button', { name: 'Export CSV' }))
    expect(api.downloadPost).toHaveBeenLastCalledWith('/admin/subscribers/export', expect.objectContaining({ status: 'active' }), 'subscribers.csv')

    await user.click(screen.getByRole('checkbox', { name: 'Select all' }))
    expect(screen.getByText('1 selected')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Export selected' }))
    expect(api.downloadPost).toHaveBeenLastCalledWith('/admin/subscribers/export', expect.objectContaining({ ids: [7] }), 'subscribers-selected.csv')

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/admin/subscribers/7'))
    await waitFor(() => expect(screen.queryByText('1 selected')).not.toBeInTheDocument())
  })

  it('shows a retryable error instead of a stuck loading message', async () => {
    const user = userEvent.setup()
    let fail = true
    vi.mocked(api.post).mockImplementation(async () => {
      if (fail) throw new Error('down')
      return list(1) as never
    })
    renderPage()
    expect(await screen.findByText('Could not load subscribers.')).toBeInTheDocument()
    fail = false
    await user.click(screen.getByRole('button', { name: /Try again/ }))
    expect(await screen.findByText('reader@example.test')).toBeInTheDocument()
  })
})
