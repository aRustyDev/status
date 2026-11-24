import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
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

it('shows the retained range and disables longer history ranges', async () => {
  renderModal()

  const range = await screen.findByRole('combobox', { name: 'History range' })
  expect(range).toHaveAccessibleDescription('History beyond 14 days is unavailable. Showing the most recent 20 samples.')
  expect(screen.getByRole('option', { name: '14 days' })).toBeEnabled()
  expect(screen.getByRole('option', { name: '30 days' })).toBeDisabled()
  expect(screen.getByRole('option', { name: '90 days' })).toBeDisabled()
})

it('saves the approved check in a separate versioned request', async () => {
  const user = userEvent.setup()
  renderModal()
  await user.click(await screen.findByRole('button', { name: 'Save check' }))
  await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/checks/check-uuid', { componentId: 'component-uuid', endpointId: 'api', enabled: true, intervalMinutes: 1, expectedStatus: 200, version: 3 }))
  expect(api.patch).toHaveBeenCalledTimes(1)
})

it('explains that status ranges override the single expected status and lets them be removed', async () => {
  const user = userEvent.setup()
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/admin/checks') return [{ ...check, advancedConfig: { acceptedStatusRanges: [{ min: 200, max: 299 }] } }]
    if (path === '/admin/endpoints') return [{ id: 'api', name: 'Approved API' }]
    return { results: [], retentionDays: 14 }
  })
  renderModal()
  const expected = await screen.findByLabelText('Expected HTTP status')
  expect(expected).toBeDisabled()
  expect(expected).toHaveAccessibleDescription('Status ranges in additional HTTP settings determine the accepted status. Remove the ranges and save those settings to use a single expected status.')
  await user.click(screen.getByRole('button', { name: 'Remove status range 1' }))
  await user.click(screen.getByRole('button', { name: 'Save additional HTTP settings' }))
  await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/checks/check-uuid/advanced', { version: 3, advancedConfig: { method: 'GET', timeoutMs: 10000, attempts: 1 } }))
})

it('loads the saved check before opening a form when the cached list is stale', async () => {
  const user = userEvent.setup()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['checks'], [])
  client.setQueryData(['endpoints'], [{ id: 'api', name: 'Approved API' }])
  let resolveChecks: (value: unknown) => void = () => {}
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/admin/checks') return new Promise(resolve => { resolveChecks = resolve })
    if (path === '/admin/endpoints') return [{ id: 'api', name: 'Approved API' }]
    if (path === '/admin/monitors/7/history') return { results: [], retentionDays: 14 }
    throw new Error(`Unexpected request ${path}`)
  })
  render(<QueryClientProvider client={client}><MonitorFormModal monitor={monitor} onClose={() => {}} onSaved={() => {}} /></QueryClientProvider>)
  expect(screen.queryByRole('button', { name: 'Save check' })).not.toBeInTheDocument()
  expect(screen.getByText('Loading check settings…')).toBeInTheDocument()
  await act(async () => resolveChecks([{ ...check, expectedStatus: 201 }]))
  expect(await screen.findByDisplayValue('201')).toBeInTheDocument()
  expect(screen.getByRole('checkbox', { name: 'Enabled' })).toBeChecked()
  expect(screen.getByDisplayValue('Approved API')).toHaveValue('api')
  await user.click(screen.getByRole('button', { name: 'Save check' }))
  await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/checks/check-uuid', { componentId: 'component-uuid', endpointId: 'api', enabled: true, intervalMinutes: 1, expectedStatus: 201, version: 3 }))
  expect(api.post).not.toHaveBeenCalled()
})

it('does not offer a cached check for editing when refreshing it fails', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['checks'], [check])
  client.setQueryData(['endpoints'], [{ id: 'api', name: 'Approved API' }])
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/admin/checks') throw new Error('offline')
    if (path === '/admin/endpoints') return [{ id: 'api', name: 'Approved API' }]
    return { results: [], retentionDays: 14 }
  })
  render(<QueryClientProvider client={client}><MonitorFormModal monitor={monitor} onClose={() => {}} onSaved={() => {}} /></QueryClientProvider>)
  expect(await screen.findByText('Could not load check settings.')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Save check' })).not.toBeInTheDocument()
})

it('sends the component version from when the draft was opened after a monitor refresh', async () => {
  const user = userEvent.setup()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.mocked(api.patch).mockRejectedValue(new Error('Conflict: the service was changed'))
  const view = render(<QueryClientProvider client={client}><MonitorFormModal monitor={monitor} onClose={() => {}} onSaved={() => {}} /></QueryClientProvider>)
  const name = screen.getByDisplayValue('API')
  await user.clear(name)
  await user.type(name, 'My draft')
  view.rerender(<QueryClientProvider client={client}><MonitorFormModal monitor={{ ...monitor, name: 'Other edit', version: 5 } as Monitor} onClose={() => {}} onSaved={() => {}} /></QueryClientProvider>)
  await user.click(screen.getByRole('button', { name: 'Save service' }))
  expect(await screen.findByText('Conflict: the service was changed')).toBeInTheDocument()
  expect(api.patch).toHaveBeenCalledWith('/admin/components/component-uuid', { name: 'My draft', manualStatus: 'operational', position: 1, version: 4 })
  expect(screen.getByDisplayValue('My draft')).toBeInTheDocument()
})

it.each(['/admin/checks', '/admin/endpoints'])('preserves check and advanced drafts across a failed %s refresh and a concurrent edit', async failedPath => {
  const user = userEvent.setup()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let failRefresh = false
  let concurrentEdit = false
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === failedPath && failRefresh) throw new Error('offline')
    if (path === '/admin/checks') return concurrentEdit ? [{ ...check, version: 4, expectedStatus: 202, advancedConfigInvalid: true }] : [check]
    if (path === '/admin/endpoints') return [{ id: 'api', name: 'Approved API' }]
    return { results: [], retentionDays: 14 }
  })
  vi.mocked(api.put).mockRejectedValue(new Error('Conflict: the check was changed'))
  vi.mocked(api.patch).mockRejectedValue(new Error('Conflict: check settings were changed'))
  render(<QueryClientProvider client={client}><MonitorFormModal monitor={monitor} onClose={() => {}} onSaved={() => {}} /></QueryClientProvider>)
  const expectedStatus = await screen.findByDisplayValue('200')
  await user.clear(expectedStatus)
  await user.type(expectedStatus, '201')
  await user.click(screen.getByRole('checkbox', { name: 'Use additional HTTP settings' }))
  await user.type(screen.getByLabelText('Required response keyword'), 'draft keyword')

  failRefresh = true
  await act(async () => { await client.refetchQueries({ queryKey: [failedPath === '/admin/checks' ? 'checks' : 'endpoints'] }) })
  expect(await screen.findByText('Could not load check settings.')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Save check' })).not.toBeInTheDocument()

  failRefresh = false
  concurrentEdit = true
  await act(async () => { await client.refetchQueries({ queryKey: ['checks'] }); await client.refetchQueries({ queryKey: ['endpoints'] }) })
  expect(await screen.findByDisplayValue('201')).toBeInTheDocument()
  expect(screen.getByLabelText('Required response keyword')).toHaveValue('draft keyword')
  await user.click(screen.getByRole('button', { name: 'Save additional HTTP settings' }))
  expect(await screen.findByText('Conflict: the check was changed')).toBeInTheDocument()
  expect(api.put).toHaveBeenCalledWith('/admin/checks/check-uuid/advanced', { version: 3, advancedConfig: { method: 'GET', timeoutMs: 10000, attempts: 1, keyword: 'draft keyword' } })
  expect(screen.getByLabelText('Required response keyword')).toHaveValue('draft keyword')
  await user.click(screen.getByRole('button', { name: 'Save check' }))
  expect(await screen.findByText('Conflict: check settings were changed')).toBeInTheDocument()
  expect(api.patch).toHaveBeenCalledWith('/admin/checks/check-uuid', { componentId: 'component-uuid', endpointId: 'api', enabled: true, intervalMinutes: 1, expectedStatus: 201, version: 3 })
  expect(screen.getByDisplayValue('201')).toBeInTheDocument()
})
