import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Monitor } from '@bsp/shared'
import { beforeEach, expect, it, vi } from 'vitest'
import { api } from '../../api/client'
import { CapabilitiesContext } from '../../capabilities'
import MonitorFormModal from './MonitorFormModal'

const identity = vi.hoisted(() => ({ role: 'admin' }))
vi.mock('../../api/client', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn() } }))
vi.mock('@better-forge/ui', async () => {
  const actual = await vi.importActual<typeof import('@better-forge/ui')>('@better-forge/ui')
  return { ...actual, getCurrentUser: () => identity }
})
const monitor = { id: 7, uuid: 'component-uuid', name: 'API', manualStatus: 'operational', position: 1, version: 4 } as unknown as Monitor
const link = { actionId: 'action-uuid', onStatus: 'down', delayMinutes: 5, cooldownMinutes: 60 }
beforeEach(() => {
  identity.role = 'admin'
  vi.clearAllMocks()
  vi.mocked(api.get).mockImplementation(async path => {
    if (path === '/admin/checks' || path === '/admin/endpoints') return []
    if (path === '/admin/monitors/7/history') return { results: [], retentionDays: 14 }
    if (path === '/admin/actions') return [{ id: 'action-uuid', name: 'Fail over', enabled: 1 }, { id: 'disabled', name: 'Old action', enabled: 0 }]
    if (path === '/admin/actions/monitor/component-uuid') return { links: [link], version: 3 }
    throw new Error(`Unexpected request ${path}`)
  })
  vi.mocked(api.put).mockImplementation(async (_path, body) => ({ ...(body as object), version: 4 }))
})
function renderModal(value: Monitor | null = monitor, actions = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><CapabilitiesContext.Provider value={{ supportedRoutes: [], monitorModal: true, actions }}><MonitorFormModal monitor={value} onClose={() => {}} onSaved={() => {}} /></CapabilitiesContext.Provider></QueryClientProvider>)
}
it('edits and saves action links using the upstream panel and version', async () => {
  const user = userEvent.setup(); renderModal()
  await user.click(await screen.findByRole('button', { name: 'Actions' }))
  expect(await screen.findByDisplayValue('Fail over')).toBeInTheDocument()
  expect(screen.getByRole('option', { name: 'Old action (disabled)' })).toBeInTheDocument()
  await user.selectOptions(screen.getByLabelText('When'), 'up')
  await user.clear(screen.getByLabelText('After (min)')); await user.type(screen.getByLabelText('After (min)'), '10')
  await user.click(screen.getByRole('button', { name: 'Save actions' }))
  await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/actions/monitor/component-uuid', { version: 3, links: [{ ...link, onStatus: 'up', delayMinutes: 10 }] }))
  expect(await screen.findByText('Monitor actions saved.')).toBeInTheDocument()
})
it('rejects duplicate links and retains the draft after a failed save', async () => {
  const user = userEvent.setup(); renderModal()
  await user.click(await screen.findByRole('button', { name: 'Actions' }))
  await user.click(await screen.findByRole('button', { name: '+ Add action' }))
  await user.click(screen.getByRole('button', { name: 'Save actions' }))
  expect(screen.getByText('An action can be linked only once per status.')).toBeInTheDocument()
  expect(api.put).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Remove action 2' }))
  vi.mocked(api.put).mockRejectedValueOnce(new Error('Version changed'))
  await user.click(screen.getByRole('button', { name: 'Save actions' }))
  expect(await screen.findByText('Version changed')).toBeInTheDocument()
  expect(screen.getByDisplayValue('Fail over')).toBeInTheDocument()
})
it('requires a saved monitor before adding actions', async () => {
  const user = userEvent.setup(); renderModal(null)
  await user.click(await screen.findByRole('button', { name: 'Actions' }))
  expect(screen.getByText(/Save the monitor first/)).toBeInTheDocument()
  expect(api.get).not.toHaveBeenCalledWith('/admin/actions')
})
it('hides the action editor when capability or permission is missing', async () => {
  identity.role = 'operator'; renderModal()
  expect(await screen.findByRole('button', { name: 'Actions' })).toBeDisabled()
  expect(api.get).not.toHaveBeenCalledWith('/admin/actions')
})
it('leaves Gatus monitors read-only', async () => {
  renderModal({ ...monitor, source: 'gatus' } as Monitor)
  expect(await screen.findByText(/Managed in Gatus/)).toBeInTheDocument()
  expect(api.get).not.toHaveBeenCalledWith('/admin/actions')
})
it('adds a recovery link and preserves the draft while changing tabs', async () => {
  const user = userEvent.setup(); renderModal()
  await user.click(await screen.findByRole('button', { name: 'Actions' }))
  await user.click(await screen.findByRole('button', { name: '+ Add action' }))
  await user.selectOptions(screen.getAllByLabelText('When')[1]!, 'up')
  await user.click(screen.getByRole('button', { name: 'Tags' }))
  await user.click(screen.getByRole('button', { name: 'Actions' }))
  await user.click(screen.getByRole('button', { name: 'Save actions' }))
  await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/actions/monitor/component-uuid', {
    version: 3, links: [link, { actionId: 'action-uuid', onStatus: 'up', delayMinutes: 0, cooldownMinutes: 0 }],
  }))
})
it('explains an empty action catalog and disables adding a link', async () => {
  const original = vi.mocked(api.get).getMockImplementation()!
  vi.mocked(api.get).mockImplementation(async (path, ...args) => path === '/admin/actions' ? [] : original(path, ...args))
  const user = userEvent.setup(); renderModal()
  await user.click(await screen.findByRole('button', { name: 'Actions' }))
  expect(await screen.findByText(/No actions configured/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '+ Add action' })).toBeDisabled()
})

it('waits for fresh links instead of initializing from cached values', async () => {
  let resolveLinks!: (value: unknown) => void
  const freshLinks = new Promise(resolve => { resolveLinks = resolve })
  const original = vi.mocked(api.get).getMockImplementation()!
  vi.mocked(api.get).mockImplementation(async (path, ...args) => path === '/admin/actions/monitor/component-uuid' ? freshLinks : original(path, ...args))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['monitor-action-links', 'component-uuid'], { links: [link], version: 1 })
  const user = userEvent.setup()
  render(<QueryClientProvider client={client}><CapabilitiesContext.Provider value={{ supportedRoutes: [], monitorModal: true, actions: true }}><MonitorFormModal monitor={monitor} onClose={() => {}} onSaved={() => {}} /></CapabilitiesContext.Provider></QueryClientProvider>)
  await user.click(await screen.findByRole('button', { name: 'Actions' }))
  expect(screen.getByText('Loading actions…')).toBeInTheDocument()
  resolveLinks({ links: [{ ...link, delayMinutes: 22 }], version: 9 })
  expect(await screen.findByLabelText('After (min)')).toHaveValue(22)
  await user.click(screen.getByRole('button', { name: 'Save actions' }))
  await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/actions/monitor/component-uuid', expect.objectContaining({ version: 9 })))
})
