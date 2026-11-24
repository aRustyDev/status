import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Incident } from '@bsp/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import IncidentsPage from './Incidents'
import { CapabilitiesContext, type Capabilities } from '../capabilities'
import { ToastProvider } from '@better-forge/ui'

vi.mock('../api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

const incidents = [
  {
    id: 1,
    version: 4,
    title: 'Checkout errors',
    status: 'identified',
    impact: 'major',
    startedAt: Date.UTC(2026, 8, 1),
    monitorIds: [10],
    updates: [
      { id: 2, incidentId: 1, status: 'identified', body: 'Root cause found in the payment proxy.', postedAt: Date.UTC(2026, 8, 1, 12) },
      { id: 1, incidentId: 1, status: 'investigating', body: 'Looking into elevated errors.', postedAt: Date.UTC(2026, 8, 1, 11) },
    ],
  },
  { id: 2, title: 'DNS blip', status: 'resolved', impact: 'minor', startedAt: Date.UTC(2026, 7, 1), monitorIds: [], updates: [] },
] as unknown as Incident[]

let subscriptionsEnabled = true

function mockGets(list: Incident[] = incidents) {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/admin/incidents') return list
    if (path === '/admin/incident-templates') return []
    if (path === '/admin/monitors') return [{ id: 10, name: 'Checkout API' }, { id: 11, name: 'Search' }]
    if (path === '/admin/subscribers/settings') return { enabled: subscriptionsEnabled }
    throw new Error(`Unexpected GET ${path}`)
  })
}

function renderPage(capabilities: Capabilities = { supportedRoutes: [] }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><CapabilitiesContext.Provider value={capabilities}><ToastProvider><IncidentsPage /></ToastProvider></CapabilitiesContext.Provider></QueryClientProvider>)
}

describe('IncidentsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    subscriptionsEnabled = true
    mockGets()
    vi.mocked(api.post).mockResolvedValue({})
    vi.mocked(api.delete).mockResolvedValue(undefined)
  })

  it('lists incidents with their counts', async () => {
    renderPage()

    expect(await screen.findByText('Checkout errors')).toBeInTheDocument()
    expect(screen.getByText('DNS blip')).toBeInTheDocument()
    expect(screen.getByText('1 active · 2 total')).toBeInTheDocument()
  })

  it('explains unavailable templates and incident deletion to all users', async () => {
    renderPage()
    await screen.findByText('Checkout errors')
    expect(screen.getByText('Incident templates are unavailable.')).toBeVisible()
    expect(screen.getByText('Deleting incidents is unavailable.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Templates' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Templates' })).toHaveAccessibleDescription('Incident templates are unavailable.')
    expect(screen.getByRole('button', { name: 'Delete Checkout errors' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete Checkout errors' })).toHaveAccessibleDescription('Deleting incidents is unavailable.')
  })

  it('does not show unavailable explanations when the actions are supported', async () => {
    renderPage({ supportedRoutes: [], templates: true, incidentDelete: true })
    await screen.findByText('Checkout errors')
    expect(screen.getByRole('button', { name: 'Templates' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Delete Checkout errors' })).toBeEnabled()
    expect(screen.queryByText('Incident templates are unavailable.')).not.toBeInTheDocument()
    expect(screen.queryByText('Deleting incidents is unavailable.')).not.toBeInTheDocument()
  })

  it('shows an empty state', async () => {
    mockGets([])
    renderPage()

    expect(await screen.findByText('No incidents yet')).toBeInTheDocument()
    expect(screen.queryByText(/All systems operational/)).not.toBeInTheDocument()
  })

  it('shows loading and error states instead of the empty copy', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('boom'))
    renderPage()

    expect(screen.getByText('Loading incidents…')).toBeInTheDocument()
    expect(await screen.findByText("Couldn't load incidents.")).toBeInTheDocument()
    expect(screen.queryByText('No incidents yet')).not.toBeInTheDocument()
  })

  it('exposes the expand toggle as a button with aria-expanded', async () => {
    const user = userEvent.setup()
    renderPage()

    const toggle = await screen.findByRole('button', { name: /Checkout errors/, expanded: false })
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
  })

  it('expands an incident to show monitors and its update timeline', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByText('Checkout errors'))

    expect(await screen.findByText('Checkout API')).toBeInTheDocument()
    expect(screen.getByText('Root cause found in the payment proxy.')).toBeInTheDocument()
    expect(screen.getByText('Looking into elevated errors.')).toBeInTheDocument()

    await user.click(screen.getByText('Checkout errors'))
    expect(screen.queryByText('Root cause found in the payment proxy.')).not.toBeInTheDocument()
  })

  it('explains why timeline update actions are unavailable', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByText('Checkout errors'))

    expect(screen.getByText('Editing or deleting incident updates is unavailable.')).toBeVisible()
    for (const label of ['Edit the identified update', 'Delete the identified update']) {
      const action = screen.getByRole('button', { name: label })
      expect(action).toBeDisabled()
      expect(action).toHaveAccessibleDescription('Editing or deleting incident updates is unavailable.')
    }
  })

  it('offers no update form for a resolved incident', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByText('DNS blip'))

    expect(screen.getByText('None linked')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Describe the current situation…')).not.toBeInTheDocument()
  })


  it('posts a versioned update without unsupported notification writes', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByText('Checkout errors'))
    const input = screen.getByPlaceholderText('Describe the current situation…')
    expect(screen.getByRole('button', { name: 'Post Update' })).toBeDisabled()
    await user.type(input, 'Fix deployed.')
    await user.selectOptions(screen.getByDisplayValue('Monitoring'), 'resolved')
    await user.click(screen.getByRole('button', { name: 'Post Update' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/incidents/1/updates', { version: 4, body: 'Fix deployed.', status: 'resolved' }))
    expect(api.post).toHaveBeenCalledTimes(1)
  })

  it('shows an error and keeps the draft when posting an update fails', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockRejectedValueOnce(new Error('Incident is locked'))
    renderPage()

    await user.click(await screen.findByText('Checkout errors'))
    await user.type(screen.getByPlaceholderText('Describe the current situation…'), 'Still looking.')
    await user.click(screen.getByRole('button', { name: 'Post Update' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Incident is locked')
    expect(screen.getByPlaceholderText('Describe the current situation…')).toHaveValue('Still looking.')

    // The error belongs to that attempt: it must not follow the operator to another incident.
    await user.click(screen.getByText('Checkout errors'))
    await user.click(screen.getByText('Checkout errors'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('disables Post Update while a post is in flight so it cannot be sent twice', async () => {
    const user = userEvent.setup()
    let resolvePost: (value: unknown) => void = () => {}
    vi.mocked(api.post).mockImplementationOnce(() => new Promise((resolve) => { resolvePost = resolve }))
    renderPage()

    await user.click(await screen.findByText('Checkout errors'))
    await user.type(screen.getByPlaceholderText('Describe the current situation…'), 'Fix deployed.')
    const button = screen.getByRole('button', { name: 'Post Update' })
    await user.click(button)

    await waitFor(() => expect(button).toBeDisabled())
    await user.click(button)
    expect(api.post).toHaveBeenCalledTimes(1)

    resolvePost({})
    await waitFor(() => expect(screen.getByPlaceholderText('Describe the current situation…')).toHaveValue(''))
  })


  it('explains that subscriber notifications are unavailable', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByText('Checkout errors'))
    expect(screen.getByText('Subscriber notifications are unavailable')).toBeInTheDocument()
    expect(api.get).not.toHaveBeenCalledWith('/admin/subscribers/settings')
  })


  it('publishes an incident with a selected monitor and opening update', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: /New Incident/ }))
    await user.type(screen.getByPlaceholderText('Service degradation'), 'Search is slow')
    await user.selectOptions(screen.getByDisplayValue('Investigating'), 'monitoring')
    await user.selectOptions(screen.getByDisplayValue('Minor'), 'critical')
    await user.click(await screen.findByRole('checkbox', { name: 'Search' }))
    const opening = screen.getByText('Opening update').parentElement!.querySelector('textarea')!
    await user.type(opening, 'We are investigating.')
    await user.click(screen.getByRole('button', { name: 'Publish' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/incidents', {
      title: 'Search is slow', status: 'monitoring', impact: 'critical',
      body: 'We are investigating.', monitorIds: [11], draft: false,
    }))
  })

  it('shows a draft incident and publishes it', async () => {
    const user = userEvent.setup()
    mockGets([{ id: 7, version: 2, title: 'API outage', status: 'investigating', impact: 'major', startedAt: Date.UTC(2026, 8, 3), draft: true, autoMonitorId: 10, monitorIds: [10], updates: [] }] as unknown as Incident[])
    vi.mocked(api.patch).mockResolvedValue({})
    renderPage()

    expect(await screen.findByText('draft')).toBeInTheDocument()
    expect(screen.getByText('automatic')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Publish API outage' }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/incidents/7/publish', { version: 2 }))
  })

  it('saves a manual incident as a draft', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: /New Incident/ }))
    await user.type(screen.getByPlaceholderText('Service degradation'), 'Planned check')
    await user.click(screen.getByRole('checkbox', { name: /Save as draft/ }))
    expect(screen.queryByRole('checkbox', { name: 'Notify subscribers' })).not.toBeInTheDocument()
    await user.type(screen.getByText('Opening update').parentElement!.querySelector('textarea')!, 'Investigating')
    await user.click(screen.getByRole('button', { name: 'Save as draft' }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/incidents', expect.objectContaining({ title: 'Planned check', draft: true })))
  })


  it('requires a title and opening update before publishing', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: /New Incident/ }))
    await user.click(screen.getByRole('button', { name: 'Publish' }))
    expect(screen.getByPlaceholderText('Service degradation')).toBeInvalid()
    expect(api.post).not.toHaveBeenCalled()
  })

  it('shows an error when creating an incident fails', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockRejectedValueOnce(new Error('Title too long'))
    renderPage()

    await user.click(screen.getByRole('button', { name: /New Incident/ }))
    await user.type(screen.getByPlaceholderText('Service degradation'), 'x')
    await user.type(screen.getByText('Opening update').parentElement!.querySelector('textarea')!, 'Investigating')
    await user.click(screen.getByRole('button', { name: 'Publish' }))

    expect(await screen.findByText('Title too long')).toBeInTheDocument()
  })

  it('edits the title and the affected monitors of an incident', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Edit Checkout errors' }))
    const title = screen.getByRole('textbox', { name: /Title/ })
    await user.clear(title)
    await user.type(title, 'Checkout and search errors')
    await user.click(screen.getByRole('checkbox', { name: 'Search' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/incidents/1', { title: 'Checkout and search errors', impact: 'major', monitorIds: [10, 11], version: 4 }))
    expect(api.post).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('shows a retired association and lets an operator remove it', async () => {
    const user = userEvent.setup()
    mockGets([{ ...incidents[0]!, monitorIds: [10, 99], monitorNames: { 99: 'Retired service' } }])
    vi.mocked(api.patch).mockResolvedValue({})
    renderPage()
    await user.click(await screen.findByText('Checkout errors'))
    expect(screen.getByText('Retired service')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Edit Checkout errors' }))
    const retired = screen.getByRole('checkbox', { name: 'Retired service (retired)' })
    expect(retired).toBeChecked()
    await user.click(retired)
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/incidents/1', expect.objectContaining({ monitorIds: [10] })))
  })

  it('sends nothing when the edit changes nothing', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Edit Checkout errors' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.post).not.toHaveBeenCalled()
    expect(api.patch).not.toHaveBeenCalled()
  })


  it('disables editing and deleting published timeline updates', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByText('Checkout errors'))
    expect(screen.getByRole('button', { name: 'Edit the investigating update' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete the identified update' })).toBeDisabled()
    expect(api.patch).not.toHaveBeenCalled()
    expect(api.delete).not.toHaveBeenCalled()
  })


  it('disables incident deletion when the capability is absent', async () => {
    renderPage()
    expect(await screen.findByRole('button', { name: 'Delete DNS blip' })).toBeDisabled()
    expect(api.delete).not.toHaveBeenCalled()
  })


  it('disables templates and skips the template query', async () => {
    renderPage()
    expect(screen.getByRole('button', { name: 'Templates' })).toBeDisabled()
    expect(api.get).not.toHaveBeenCalledWith('/admin/incident-templates')
  })

})
