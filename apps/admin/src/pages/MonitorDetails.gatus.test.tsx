import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { ToastProvider } from '@better-forge/ui'
import { api } from '../api/client'
import MonitorDetails from './MonitorDetails'

vi.mock('../api/client', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }))
vi.mock('@better-forge/ui', async () => {
  const actual = await vi.importActual<typeof import('@better-forge/ui')>('@better-forge/ui')
  return { ...actual, getCurrentUser: () => ({ role: 'admin' }) }
})

it('opens a direct link to a Gatus monitor as read-only without fetching or offering check controls', async () => {
  vi.mocked(api.get).mockReset()
  vi.mocked(api.get).mockResolvedValue([{ id: 7, uuid: 'gatus-component', name: 'Managed service', source: 'gatus', type: 'gatus' }])
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><ToastProvider><MemoryRouter initialEntries={['/admin/monitors/7']}>
    <Routes><Route path="/admin/monitors/:id" element={<MonitorDetails />} /></Routes>
  </MemoryRouter></ToastProvider></QueryClientProvider>)
  expect(await screen.findByText('Managed service')).toBeVisible()
  expect(screen.getByText('Managed in Gatus. Change this monitor in Gatus.')).toBeVisible()
  expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument()
  expect(screen.queryByText('HTTP check')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Manual health')).not.toBeInTheDocument()
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1))
  expect(api.get).toHaveBeenCalledWith('/admin/monitors', { timeoutMs: 15_000 })
  expect(api.post).not.toHaveBeenCalled()
  expect(api.patch).not.toHaveBeenCalled()
})

it('preserves an unsaved draft while stale monitor status is hidden', async () => {
  const monitor = { id: 7, uuid: 'native-component', name: 'Original', type: 'https', manualStatus: 'operational', position: 0, version: 1 }
  let resolve!: (value: unknown) => void
  let monitorReads = 0
  vi.mocked(api.get).mockReset().mockImplementation((path: string) => {
    if (path === '/admin/monitors') return ++monitorReads === 1 ? Promise.resolve([monitor]) : new Promise(r => { resolve = r })
    if (path.endsWith('/history')) return Promise.resolve({ results: [], retentionDays: 14 })
    return Promise.resolve([])
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><ToastProvider><MemoryRouter initialEntries={['/admin/monitors/7']}>
    <Routes><Route path="/admin/monitors/:id" element={<MonitorDetails />} /></Routes>
  </MemoryRouter></ToastProvider></QueryClientProvider>)
  const input = await screen.findByLabelText(/Name/)
  fireEvent.change(input, { target: { value: 'Unsaved draft' } })
  await act(async () => {
    client.setQueryData(['monitors'], [monitor], { updatedAt: Date.now() - 61_000 })
    void client.invalidateQueries({ queryKey: ['monitors'] })
  })
  expect(await screen.findByText(/Your draft is preserved/)).toBeVisible()
  expect(input).not.toBeVisible()
  await act(async () => resolve([monitor]))
  await waitFor(() => expect(input).toBeVisible())
  expect(input).toHaveValue('Unsaved draft')
})
