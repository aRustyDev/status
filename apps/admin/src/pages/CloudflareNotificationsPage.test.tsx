import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import CloudflareNotifications from './CloudflareNotifications'

vi.mock('../api/client', () => ({ api: { get: vi.fn(), delete: vi.fn() } }))
vi.mock('../components/notifications/CloudflareChannelForm', () => ({
  default: ({ initialType }: { initialType: string }) => <div role="dialog">Selected {initialType}</div>,
}))

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><CloudflareNotifications /></QueryClientProvider>)
}

describe('Notifications page', () => {
  it('offers only available quick-start providers and opens the selected type', async () => {
    vi.mocked(api.get).mockImplementation(async path => {
      if (path === '/admin/notifications/email-destinations') return [{ id: 'mail', name: 'Mail' }]
      if (path === '/admin/notifications/destinations') return [{ id: 'hook', name: 'Webhook' }]
      if (path === '/admin/vaults') throw new Error('Unavailable')
      return []
    })
    renderPage()
    const user = userEvent.setup()
    const email = await screen.findByRole('button', { name: /Email.*Approved email recipient/ })
    expect(screen.queryByRole('button', { name: /Webhook.*Approved HTTPS destination/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'SMTP Settings' })).toBeDisabled()
    await user.click(email)
    expect(screen.getByRole('dialog')).toHaveTextContent('Selected email')
  })

  it('renders redacted recent outcomes with the channel name', async () => {
    vi.mocked(api.get).mockImplementation(async path => {
      if (path === '/admin/notifications/channels') return [{ id: 'channel', name: 'On call', type: 'email', enabled: 1, version: 1, associationVersion: 0, checkIds: [] }]
      if (path === '/admin/notifications/deliveries') return [{ channelId: 'channel', checkId: 'check', status: 'down', state: 'failed', attempts: 1, errorCode: 'delivery_failed', updatedAt: 1 }]
      return []
    })
    renderPage()
    expect(await screen.findByText(/On call: down, failed \(delivery_failed\)/)).toBeInTheDocument()
  })

  it('defaults Add Channel to email when it is the only available provider', async () => {
    vi.mocked(api.get).mockImplementation(async path => path === '/admin/notifications/email-destinations' ? [{ id: 'mail', name: 'Mail' }] : [])
    renderPage()
    const user = userEvent.setup()
    await screen.findByRole('button', { name: /Email.*Approved email recipient/ })
    await user.click(screen.getByRole('button', { name: 'Add Channel' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Selected email')
  })

  it('allows a failed channel catalog to be retried', async () => {
    let failed = true
    vi.mocked(api.get).mockImplementation(async path => {
      if (path === '/admin/notifications/email-destinations') {
        if (failed) throw new Error('Unavailable')
        return [{ id: 'mail', name: 'Mail' }]
      }
      return []
    })
    renderPage()
    const user = userEvent.setup()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load available channel types')
    failed = false
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('button', { name: /Email.*Approved email recipient/ })).toBeInTheDocument()
  })
})
