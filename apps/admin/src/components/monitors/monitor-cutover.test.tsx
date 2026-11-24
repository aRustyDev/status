import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Monitor } from '@bsp/shared'
import { beforeEach, expect, it, vi } from 'vitest'
import { api } from '../../api/client'
import MonitorFormModal from './MonitorFormModal'

vi.mock('../../api/client', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn() } }))
vi.mock('@better-forge/ui', async () => {
  const actual = await vi.importActual<typeof import('@better-forge/ui')>('@better-forge/ui')
  return { ...actual, getCurrentUser: () => ({ role: 'admin' }) }
})

const monitor = { id: 7, uuid: 'component-uuid', name: 'API', manualStatus: 'operational', position: 1, version: 4 } as unknown as Monitor
const check = { id: 'check-uuid', componentId: 'component-uuid', endpointId: 'api', enabled: true, intervalMinutes: 1, expectedStatus: 200, version: 3 }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/admin/checks') return [check]
    if (path === '/admin/endpoints') return [{ id: 'api', name: 'Approved API' }]
    if (path === '/admin/monitors/7/history') return { results: [], retentionDays: 14 }
    throw new Error(`Unexpected request ${path}`)
  })
  vi.mocked(api.patch).mockResolvedValue({})
  vi.mocked(api.put).mockResolvedValue({})
})

function renderModal() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><MonitorFormModal monitor={monitor} onClose={() => {}} onSaved={() => {}} /></QueryClientProvider>)
}

it('saves component settings with the displayed version and no follow-up writes', async () => {
  const user = userEvent.setup()
  renderModal()
  const input = screen.getByDisplayValue('API')
  await user.clear(input)
  await user.type(input, 'API renamed')
  await user.click(screen.getByRole('button', { name: 'Save service' }))
  await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/components/component-uuid', { name: 'API renamed', manualStatus: 'operational', position: 1, version: 4 }))
  expect(api.patch).toHaveBeenCalledTimes(1)
  expect(api.post).not.toHaveBeenCalled()
  expect(await screen.findByText('No samples for this check configuration.')).toBeInTheDocument()
})

it('saves the approved check in a separate versioned request', async () => {
  const user = userEvent.setup()
  renderModal()
  await user.click(await screen.findByRole('button', { name: 'Save check' }))
  await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/checks/check-uuid', { componentId: 'component-uuid', endpointId: 'api', enabled: true, intervalMinutes: 1, expectedStatus: 200, version: 3 }))
  expect(api.patch).toHaveBeenCalledTimes(1)
})

it('saves non-secret additional HTTP checks as one versioned operation', async () => {
  const user = userEvent.setup()
  renderModal()
  await user.click(await screen.findByLabelText('Use additional HTTP settings'))
  await user.click(screen.getByRole('button', { name: 'Add status range' }))
  await user.type(screen.getByLabelText('Required response keyword'), 'healthy')
  await user.click(screen.getByRole('button', { name: 'Add response assertion' }))
  await user.type(screen.getByLabelText('Header name'), 'x-health')
  await user.click(screen.getByRole('button', { name: 'Save additional HTTP settings' }))
  await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/checks/check-uuid/advanced', {
    version: 3,
    advancedConfig: { method: 'GET', timeoutMs: 10000, attempts: 1, acceptedStatusRanges: [{ min: 200, max: 299 }], keyword: 'healthy', assertions: [{ type: 'header', name: 'x-health', op: 'exists' }] },
  }))
  expect(api.put).toHaveBeenCalledTimes(1)
  expect(api.patch).not.toHaveBeenCalled()
  expect(api.post).not.toHaveBeenCalled()
  expect(screen.getByText(/Comparison values must not contain secrets/)).toBeInTheDocument()
})

it('rejects a scheduled timeout budget over ten seconds without a write', async () => {
  const user = userEvent.setup()
  renderModal()
  await user.click(await screen.findByLabelText('Use additional HTTP settings'))
  await user.clear(screen.getByLabelText('Attempts'))
  await user.type(screen.getByLabelText('Attempts'), '2')
  await user.click(screen.getByRole('button', { name: 'Save additional HTTP settings' }))
  expect(screen.getByText('Timeout multiplied by attempts must not exceed 10,000 ms for scheduled checks.')).toBeInTheDocument()
  expect(api.put).not.toHaveBeenCalled()
})
