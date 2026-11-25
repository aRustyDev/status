import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import CloudflareStaticFallbackPage from './CloudflareStaticFallback'

vi.mock('../api/client', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }))
const off = { settings: { enabled: false, intervalSeconds: 60 }, status: { lastRunAt: null, lastSuccessAt: null, lastError: null }, health: 'disabled', runs: [] }
const on = { ...off, settings: { enabled: true, intervalSeconds: 300 }, status: { lastRunAt: 1000, lastSuccessAt: 1000, lastError: null }, health: 'ok', runs: [{ at: 1000, ok: true, error: null }] }
function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><CloudflareStaticFallbackPage /></QueryClientProvider>)
}
describe('Cloudflare static fallback', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.get).mockResolvedValue(off) })
  it('checks storage, saves settings and pushes on demand', async () => {
    const user = userEvent.setup()
    vi.mocked(api.put).mockResolvedValue(on)
    vi.mocked(api.post).mockImplementation(async path => path.endsWith('/check') ? { ok: true, error: null } : on)
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Check access' }))
    expect(await screen.findByText('Storage access check passed.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Push now' })).toBeDisabled()
    await user.click(screen.getByRole('switch', { name: 'Push the status page' }))
    await user.selectOptions(screen.getByLabelText('How often'), '300')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/static-mirror', { enabled: true, intervalSeconds: 300 }))
    expect(await screen.findByText('The copy is up to date')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Push now' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/static-mirror/test'))
  })
  it('rejects invalid custom intervals and displays check failures', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValue({ ok: false, error: 'Storage unavailable' })
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Check access' }))
    expect(await screen.findByText('Storage unavailable')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('How often'), 'custom')
    await user.clear(screen.getByLabelText('Interval in minutes'))
    expect(screen.getByText('Choose a whole number of minutes from 1 to 1440.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })
  it('shows a failed publication and the last successful copy', async () => {
    vi.mocked(api.get).mockResolvedValue({ ...on, health: 'error', status: { ...on.status, lastError: 'Publication failed' } })
    renderPage()
    expect(await screen.findByRole('heading', { name: 'The latest push failed' })).toBeInTheDocument()
    expect(screen.getByText('Publication failed')).toBeInTheDocument()
    expect(screen.getByLabelText('1 of the last 1 pushes succeeded')).toBeInTheDocument()
  })
})
