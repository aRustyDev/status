import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { api } from '../api/client'
import CloudflareDeliveryHistory from './CloudflareDeliveryHistory'

vi.mock('../api/client', () => ({ api: { get: vi.fn() } }))

it('filters the recent outcomes and paginates without exposing retry', async () => {
  vi.mocked(api.get).mockImplementation(async path => {
    if (path === '/admin/actions') return [{ id: 'a', name: 'Failover' }, { id: 'b', name: 'Recovery' }]
    if (path === '/admin/actions/checks') return [{ id: 'check', name: 'Service' }]
    if (path === '/admin/actions/runs') return Array.from({ length: 22 }, (_, index) => ({
      actionId: index === 0 ? 'b' : 'a', checkId: 'check', scheduledAt: 1700000000000 + index,
      status: 'down', state: index === 0 ? 'uncertain' : 'completed', updatedAt: 1700000000000 + index,
    }))
    throw new Error(`Unexpected request ${path}`)
  })
  const user = userEvent.setup()
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><CloudflareDeliveryHistory /></QueryClientProvider>)
  expect(await screen.findByText('Page 1 of 2 · 22 runs')).toBeInTheDocument()
  expect(within(screen.getByRole('tabpanel')).getAllByText('Service')).toHaveLength(20)
  await user.click(screen.getByRole('button', { name: 'Next page' }))
  expect(screen.getByText('Page 2 of 2 · 22 runs')).toBeInTheDocument()
  expect(within(screen.getByRole('tabpanel')).getAllByText('Service')).toHaveLength(2)
  await user.selectOptions(screen.getByLabelText('Outcome'), 'uncertain')
  expect(screen.getByText('Page 1 of 1 · 1 runs')).toBeInTheDocument()
  expect(screen.getByText('Uncertain', { selector: 'td' })).toBeInTheDocument()
  await user.selectOptions(screen.getByLabelText('Action'), 'a')
  expect(screen.getByText('No runs match these filters.')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /retry|approve/i })).not.toBeInTheDocument()
})
