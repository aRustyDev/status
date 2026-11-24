import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Monitor } from '@bsp/shared'
import { beforeEach, expect, it, vi } from 'vitest'
import { api } from '../../api/client'
import { CapabilitiesContext } from '../../capabilities'
import MonitorFormModal from './MonitorFormModal'

vi.mock('../../api/client', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }))
vi.mock('@better-forge/ui', async () => {
  const actual = await vi.importActual<typeof import('@better-forge/ui')>('@better-forge/ui')
  return { ...actual, getCurrentUser: () => ({ role: 'admin', email: 'operator@example.com' }) }
})

const monitor = { id: 7, uuid: 'component-uuid', name: 'API', manualStatus: 'operational', position: 1, version: 4 } as unknown as Monitor
const check = { id: 'check-uuid', componentId: 'component-uuid', endpointId: 'api', enabled: true, intervalMinutes: 1, expectedStatus: 200, version: 3, advancedConfig: null }

beforeEach(() => {
  sessionStorage.clear()
  vi.clearAllMocks()
  vi.mocked(api.get).mockImplementation(async path => {
    if (path === '/admin/checks') return [check]
    if (path === '/admin/endpoints') return [{ id: 'api', name: 'Approved API' }, { id: 'other', name: 'Other API' }]
    if (path === '/admin/monitors/7/history') return { results: [], retentionDays: 14 }
    if (path === '/auth/me') return { id: 'actor', email: 'operator@example.com' }
    throw new Error(`Unexpected request ${path}`)
  })
  vi.mocked(api.patch).mockResolvedValue({})
  vi.mocked(api.post).mockResolvedValue({})
})

function renderModal(value: Monitor | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><CapabilitiesContext.Provider value={{ supportedRoutes: [], monitorModal: true }}><MonitorFormModal monitor={value} onClose={() => {}} onSaved={() => {}} /></CapabilitiesContext.Provider></QueryClientProvider>)
}

it('shows unavailable upstream sidebar sections while keeping Checks usable', async () => {
  const user = userEvent.setup()
  renderModal(monitor)
  const checks = await screen.findByRole('button', { name: 'Checks' })
  for (const label of ['Auth', 'Request', 'Tags', 'Alerts', 'Actions', 'Depends on', 'Incident', 'Latency']) {
    const button = screen.getByRole('button', { name: label })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', `${label} (unavailable)`)
  }
  expect(checks).toBeEnabled()
  await user.click(checks)
  expect(screen.getByLabelText('Keyword (optional)')).toBeInTheDocument()
})

it('preserves an unchanged legacy check when saving service settings', async () => {
  const user = userEvent.setup()
  renderModal(monitor)
  await user.click(await screen.findByRole('button', { name: 'Save Changes' }))
  await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/monitors/7', { name: 'API', manualStatus: 'operational', position: 1, version: 4 }))
})

it('shows and preserves configured status ranges while editing other check settings', async () => {
  const user = userEvent.setup()
  const ranges = [{ min: 200, max: 299 }, { min: 401, max: 401 }]
  vi.mocked(api.post).mockResolvedValue({ overall: 'ok', steps: [], totalMs: 5 })
  vi.mocked(api.get).mockImplementation(async path => {
    if (path === '/admin/checks') return [{ ...check, advancedConfig: { acceptedStatusRanges: ranges } }]
    if (path === '/admin/endpoints') return [{ id: 'api', name: 'Approved API' }]
    if (path === '/admin/monitors/7/history') return { results: [], retentionDays: 14 }
    throw new Error(`Unexpected request ${path}`)
  })
  renderModal(monitor)
  expect(await screen.findByText(/200–299, 401–401/)).toBeInTheDocument()
  expect(screen.getByLabelText('Expected status')).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Checks' }))
  await user.type(screen.getByLabelText('Keyword (optional)'), 'ready')
  await user.click(screen.getByRole('button', { name: 'Test' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/monitors/test', expect.objectContaining({ advancedConfig: expect.objectContaining({ acceptedStatusRanges: ranges, keyword: 'ready' }) }), expect.anything()))
  await user.click(screen.getByRole('button', { name: 'Save Changes' }))
  await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/monitors/7', expect.objectContaining({ check: expect.objectContaining({ advancedConfig: expect.objectContaining({ acceptedStatusRanges: ranges, keyword: 'ready' }) }) })))
})

it('replaces status ranges only when the operator chooses a single expected status', async () => {
  const user = userEvent.setup()
  vi.mocked(api.post).mockResolvedValue({ overall: 'ok', steps: [], totalMs: 5 })
  vi.mocked(api.get).mockImplementation(async path => {
    if (path === '/admin/checks') return [{ ...check, advancedConfig: { acceptedStatusRanges: [{ min: 200, max: 299 }] } }]
    if (path === '/admin/endpoints') return [{ id: 'api', name: 'Approved API' }]
    if (path === '/admin/monitors/7/history') return { results: [], retentionDays: 14 }
    throw new Error(`Unexpected request ${path}`)
  })
  renderModal(monitor)
  await user.click(await screen.findByRole('button', { name: 'Use a single expected status' }))
  const expected = screen.getByLabelText('Expected status')
  expect(expected).toBeEnabled()
  await user.clear(expected)
  await user.type(expected, '201')
  await user.click(screen.getByRole('button', { name: 'Test' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/monitors/test', expect.objectContaining({ expectedStatus: 201, advancedConfig: expect.not.objectContaining({ acceptedStatusRanges: expect.anything() }) }), expect.anything()))
  await user.click(screen.getByRole('button', { name: 'Save Changes' }))
  await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/monitors/7', expect.objectContaining({ check: expect.objectContaining({ expectedStatus: 201, advancedConfig: expect.not.objectContaining({ acceptedStatusRanges: expect.anything() }) }) })))
})

it('creates ranges in the Checks panel and sends the same settings to Test and Save', async () => {
  const user = userEvent.setup()
  vi.mocked(api.post).mockResolvedValue({ overall: 'ok', steps: [], totalMs: 5 })
  renderModal(null)
  await user.type(await screen.findByLabelText('Name'), 'Range check')
  await user.selectOptions(screen.getByLabelText('Approved destination'), 'api')
  await user.click(screen.getByRole('button', { name: 'Checks' }))
  await user.click(screen.getByRole('button', { name: 'Add status range' }))
  await user.clear(screen.getByLabelText('Status range 1 to'))
  await user.type(screen.getByLabelText('Status range 1 to'), '204')
  await user.type(screen.getByLabelText('Keyword (optional)'), 'ready')
  expect(screen.getByLabelText('Expected status')).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Test' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/monitors/test', expect.objectContaining({ advancedConfig: expect.objectContaining({ acceptedStatusRanges: [{ min: 200, max: 204 }], keyword: 'ready' }) }), expect.anything()))
  await user.click(screen.getByRole('button', { name: 'Create Monitor' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/monitors', expect.objectContaining({ check: expect.objectContaining({ advancedConfig: expect.objectContaining({ acceptedStatusRanges: [{ min: 200, max: 204 }], keyword: 'ready' }) }) })))
})

it('edits persisted ranges, preserves other settings, and uses the expected status after removing the last range', async () => {
  const user = userEvent.setup()
  vi.mocked(api.get).mockImplementation(async path => {
    if (path === '/admin/checks') return [{ ...check, advancedConfig: { acceptedStatusRanges: [{ min: 200, max: 299 }], keyword: 'ready' } }]
    if (path === '/admin/endpoints') return [{ id: 'api', name: 'Approved API' }]
    if (path === '/admin/monitors/7/history') return { results: [], retentionDays: 14 }
    throw new Error(`Unexpected request ${path}`)
  })
  renderModal(monitor)
  await user.click(await screen.findByRole('button', { name: 'Checks' }))
  expect(screen.getByLabelText('Status range 1 from')).toHaveValue(200)
  await user.clear(screen.getByLabelText('Status range 1 to'))
  await user.type(screen.getByLabelText('Status range 1 to'), '204')
  await user.click(screen.getByRole('button', { name: 'Save Changes' }))
  await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/monitors/7', expect.objectContaining({ check: expect.objectContaining({ advancedConfig: expect.objectContaining({ acceptedStatusRanges: [{ min: 200, max: 204 }], keyword: 'ready' }) }) })))
  await user.click(screen.getByRole('button', { name: 'Remove status range 1' }))
  expect(screen.getByLabelText('Expected status')).toBeEnabled()
  await user.click(screen.getByRole('button', { name: 'Save Changes' }))
  await waitFor(() => expect(api.patch).toHaveBeenLastCalledWith('/admin/monitors/7', expect.objectContaining({ check: expect.objectContaining({ advancedConfig: expect.not.objectContaining({ acceptedStatusRanges: expect.anything() }) }) })))
})

it('rejects invalid ranges before Test or Save without losing the draft', async () => {
  const user = userEvent.setup()
  renderModal(monitor)
  await user.click(await screen.findByRole('button', { name: 'Checks' }))
  await user.click(screen.getByRole('button', { name: 'Add status range' }))
  await user.clear(screen.getByLabelText('Status range 1 from'))
  await user.type(screen.getByLabelText('Status range 1 from'), '400')
  await user.click(screen.getByRole('button', { name: 'Test' }))
  expect(screen.getByText(/Each status range must have/)).toBeInTheDocument()
  expect(api.post).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Save Changes' }))
  expect(screen.getByText(/Each status range must have/)).toBeInTheDocument()
  expect(screen.getByLabelText('Status range 1 from')).toHaveValue(400)
  expect(api.patch).not.toHaveBeenCalled()
})

it('creates a service and disabled check using the upstream Checks panel', async () => {
  const user = userEvent.setup()
  renderModal(null)
  await user.type(await screen.findByLabelText('Name'), 'Example')
  await user.selectOptions(screen.getByLabelText('Approved destination'), 'api')
  await user.click(screen.getByRole('button', { name: 'Checks' }))
  await user.type(screen.getByLabelText('Keyword (optional)'), 'ready')
  await user.click(screen.getByRole('button', { name: 'Create Monitor' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/monitors', expect.objectContaining({ name: 'Example', check: expect.objectContaining({ endpointId: 'api', enabled: false, advancedConfig: expect.objectContaining({ keyword: 'ready' }) }) })))
})

it('keeps Gatus monitors read only when the upstream editor is enabled', async () => {
  renderModal({ ...monitor, source: 'gatus' } as Monitor)
  expect(await screen.findByText('Managed in Gatus. Change this monitor in Gatus.')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Save Changes' })).not.toBeInTheDocument()
  expect(api.get).not.toHaveBeenCalled()
})

it('preserves a draft while monitor status is unavailable', async () => {
  const user = userEvent.setup()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = (statusUnavailable: boolean) => <QueryClientProvider client={client}><CapabilitiesContext.Provider value={{ supportedRoutes: [], monitorModal: true }}><MonitorFormModal monitor={monitor} statusUnavailable={statusUnavailable} onClose={() => {}} onSaved={() => {}} /></CapabilitiesContext.Provider></QueryClientProvider>
  const rendered = render(view(false))
  const name = await screen.findByLabelText('Name')
  await user.clear(name)
  await user.type(name, 'Draft name')
  rendered.rerender(view(true))
  expect(screen.getByText(/Monitor status is unavailable/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Save Changes' })).not.toBeInTheDocument()
  rendered.rerender(view(false))
  expect(screen.getByLabelText('Name')).toHaveValue('Draft name')
})

it('preserves a draft when check settings fail to refresh, and restores it after recovery', async () => {
  const user = userEvent.setup()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><CapabilitiesContext.Provider value={{ supportedRoutes: [], monitorModal: true }}><MonitorFormModal monitor={monitor} onClose={() => {}} onSaved={() => {}} /></CapabilitiesContext.Provider></QueryClientProvider>)
  const name = await screen.findByLabelText('Name')
  await user.clear(name)
  await user.type(name, 'Retained draft')
  let fail = true
  vi.mocked(api.get).mockImplementation(async path => {
    if (path === '/admin/checks') {
      if (fail) throw new Error('Unavailable')
      return [check]
    }
    if (path === '/admin/endpoints') return [{ id: 'api', name: 'Approved API' }]
    if (path === '/admin/monitors/7/history') return { results: [], retentionDays: 14 }
    throw new Error(`Unexpected request ${path}`)
  })
  await act(async () => { await client.invalidateQueries({ queryKey: ['checks'] }) })
  expect(await screen.findByText(/Check settings are unavailable/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Save Changes' })).not.toBeInTheDocument()
  fail = false
  await user.click(screen.getByRole('button', { name: 'Retry check settings' }))
  expect(await screen.findByLabelText('Name')).toHaveValue('Retained draft')
})

it('offers retry and close when the initial check settings load fails', async () => {
  const user = userEvent.setup()
  let fail = true
  vi.mocked(api.get).mockImplementation(async path => {
    if (path === '/admin/checks') {
      if (fail) throw new Error('Unavailable')
      return [check]
    }
    if (path === '/admin/endpoints') return [{ id: 'api', name: 'Approved API' }]
    if (path === '/admin/monitors/7/history') return { results: [], retentionDays: 14 }
    throw new Error(`Unexpected request ${path}`)
  })
  renderModal(monitor)
  expect(await screen.findByText('Could not load check settings.')).toBeInTheDocument()
  expect(screen.getAllByRole('button', { name: 'Close' }).length).toBeGreaterThan(0)
  fail = false
  await user.click(screen.getByRole('button', { name: 'Retry check settings' }))
  expect(await screen.findByLabelText('Name')).toHaveValue('API')
})

it('uses the original check and component revisions after a background refresh', async () => {
  const user = userEvent.setup()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = (value: Monitor) => <QueryClientProvider client={client}><CapabilitiesContext.Provider value={{ supportedRoutes: [], monitorModal: true }}><MonitorFormModal monitor={value} onClose={() => {}} onSaved={() => {}} /></CapabilitiesContext.Provider></QueryClientProvider>
  const rendered = render(view(monitor))
  await screen.findByRole('button', { name: 'Save Changes' })
  const expectedStatus = screen.getByLabelText('Expected status')
  await user.clear(expectedStatus)
  await user.type(expectedStatus, '201')
  await act(async () => { client.setQueryData(['checks'], [{ ...check, version: 4, expectedStatus: 202 }]) })
  rendered.rerender(view({ ...monitor, version: 5 } as Monitor))
  await user.click(screen.getByRole('button', { name: 'Save Changes' }))
  await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/monitors/7', expect.objectContaining({ version: 4, check: expect.objectContaining({ id: 'check-uuid', version: 3, expectedStatus: 201 }) })))
})

it('clears the test result when the check settings change', async () => {
  const user = userEvent.setup()
  vi.mocked(api.post).mockResolvedValue({ overall: 'ok', steps: [], totalMs: 5 })
  renderModal(null)
  await user.selectOptions(await screen.findByLabelText('Approved destination'), 'api')
  await user.click(screen.getByRole('button', { name: 'Test' }))
  expect(await screen.findByText('All checks passed')).toBeInTheDocument()
  await user.clear(screen.getByLabelText('Expected status'))
  await user.type(screen.getByLabelText('Expected status'), '201')
  expect(screen.queryByText('All checks passed')).not.toBeInTheDocument()
})

it('ignores an in-flight test result after the destination changes', async () => {
  const user = userEvent.setup()
  let finish!: (value: unknown) => void
  vi.mocked(api.post).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  renderModal(null)
  await user.selectOptions(await screen.findByLabelText('Approved destination'), 'api')
  await user.click(screen.getByRole('button', { name: 'Test' }))
  await user.selectOptions(screen.getByLabelText('Approved destination'), 'other')
  await act(async () => { finish({ overall: 'ok', steps: [], totalMs: 5 }) })
  expect(screen.queryByText('All checks passed')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Test' })).toBeEnabled()
})

it('waits for fresh checks before initializing an editor with cached data', async () => {
  let finish!: (value: unknown) => void
  vi.mocked(api.get).mockImplementation(async path => {
    if (path === '/admin/checks') return new Promise(resolve => { finish = resolve })
    if (path === '/admin/endpoints') return [{ id: 'api', name: 'Approved API' }]
    if (path === '/admin/monitors/7/history') return { results: [], retentionDays: 14 }
    throw new Error(`Unexpected request ${path}`)
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['checks'], [])
  client.setQueryData(['endpoints'], [{ id: 'api', name: 'Approved API' }])
  render(<QueryClientProvider client={client}><CapabilitiesContext.Provider value={{ supportedRoutes: [], monitorModal: true }}><MonitorFormModal monitor={monitor} onClose={() => {}} onSaved={() => {}} /></CapabilitiesContext.Provider></QueryClientProvider>)
  expect(screen.getByRole('status')).toHaveTextContent('Loading check settings')
  expect(screen.queryByLabelText('Approved destination')).not.toBeInTheDocument()
  await act(async () => { finish([check]) })
  expect(await screen.findByLabelText('Approved destination')).toHaveValue('api')
})
