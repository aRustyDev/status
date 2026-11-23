import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { ToastProvider } from '@better-forge/ui'
import { api } from '../api/client'
import IncidentsPage from './Incidents'

vi.mock('../api/client', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/admin/incidents') return []
    if (path === '/admin/monitors') return [{ id: 10, name: 'Checkout' }]
    throw new Error(`Unexpected request ${path}`)
  })
  vi.mocked(api.post).mockResolvedValue({})
})

it('publishes an incident with the opening update in one request', async () => {
  const user = userEvent.setup()
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ToastProvider><IncidentsPage /></ToastProvider></QueryClientProvider>)
  await user.click(await screen.findByRole('button', { name: /New Incident/ }))
  await user.type(screen.getByPlaceholderText('Service degradation'), 'Database outage')
  const opening = screen.getByText('Opening update').parentElement?.querySelector('textarea')
  expect(opening).not.toBeNull()
  await user.type(opening!, 'We are investigating.')
  await user.selectOptions(screen.getByDisplayValue('Investigating'), 'identified')
  await user.click(screen.getByRole('button', { name: 'Publish' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/incidents', {
    title: 'Database outage', status: 'identified', impact: 'minor', body: 'We are investigating.', monitorIds: [], draft: false,
  }))
  expect(api.post).toHaveBeenCalledTimes(1)
  expect(api.get).not.toHaveBeenCalledWith('/admin/incident-templates')
})
