import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import AuditLog from './AuditLog'

vi.mock('../api/client', () => ({ api: { get: vi.fn() } }))

function showPage() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AuditLog /></QueryClientProvider>)
}

describe('Cloudflare audit log', () => {
  beforeEach(() => { vi.mocked(api.get).mockReset() })

  it('shows upstream filters, safe details and pages using the Cloudflare client', async () => {
    vi.mocked(api.get).mockImplementation(async (path) => {
      const query = new URLSearchParams(path.split('?')[1])
      return { entries: [{ id: 'event-1', userEmail: 'admin@example.com', action: 'publish', entityType: 'incident', entityName: 'incident-1', timestamp: 1730000000000, diff: { status: 'monitoring' } }], total: 51, page: Number(query.get('page')), limit: 50, pages: 2 } as never
    })
    const user = userEvent.setup()
    showPage()
    expect(await screen.findByText('admin@example.com')).toBeInTheDocument()
    expect(screen.getByText('incident-1')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /1 detail/i }))
    expect(screen.getByText('monitoring')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /hide details/i }))
    expect(screen.queryByText('monitoring')).not.toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Entity'), 'incident')
    await user.selectOptions(screen.getByLabelText('Action'), 'publish')
    await user.type(screen.getByLabelText('User'), 'alice@example.com{enter}')
    await user.type(screen.getByLabelText('From'), '2024-10-01')
    await user.type(screen.getByLabelText('To'), '2024-10-31')
    await waitFor(() => expect(vi.mocked(api.get).mock.calls.at(-1)?.[0]).toContain('userEmail=alice%40example.com'))
    const path = vi.mocked(api.get).mock.calls.at(-1)?.[0] ?? ''
    expect(path).toContain('/admin/audit-log?')
    expect(path).toContain('entityType=incident')
    expect(path).toContain('action=publish')
    expect(path).toContain('from=')
    expect(path).toContain('to=')
    await user.click(screen.getByRole('button', { name: 'Clear' }))
    await waitFor(() => expect(vi.mocked(api.get).mock.calls.at(-1)?.[0]).toBe('/admin/audit-log?page=1&limit=50'))
    await user.click(screen.getByRole('button', { name: /next/i }))
    await waitFor(() => expect(vi.mocked(api.get).mock.calls.at(-1)?.[0]).toContain('page=2'))
  })

  it('offers retry after an error and shows the empty state', async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ entries: [], total: 0, pages: 1 })
    const user = userEvent.setup()
    showPage()
    expect(await screen.findByText('Could not load the audit log.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /try again/i }))
    expect(await screen.findByText('No audit entries found.')).toBeInTheDocument()
  })
})
