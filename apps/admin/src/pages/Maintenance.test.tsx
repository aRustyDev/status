import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import MaintenancePage, { DateTimeInput } from './Maintenance'
import { ToastProvider } from '@better-forge/ui'

vi.mock('../api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

describe('maintenance date and time input', () => {
  it('updates the date, hour, and minute without changing the local datetime format', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <DateTimeInput label="Starts At" value="2026-07-15T09:05" onChange={onChange} />,
    )

    fireEvent.change(screen.getByLabelText('Starts At — YYYY-MM-DD'), {
      target: { value: '2026-07-20' },
    })
    expect(onChange).toHaveBeenLastCalledWith('2026-07-20T09:05')

    rerender(<DateTimeInput label="Starts At" value="2026-07-20T09:05" onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('Starts At — HH'), { target: { value: '17' } })
    expect(onChange).toHaveBeenLastCalledWith('2026-07-20T17:05')

    rerender(<DateTimeInput label="Starts At" value="2026-07-20T17:05" onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('Starts At — MM'), { target: { value: '42' } })
    expect(onChange).toHaveBeenLastCalledWith('2026-07-20T17:42')
  })
})

const HOUR = 60 * 60 * 1000

function windows() {
  const now = Date.now()
  return [
    { id: 1, name: 'DB upgrade', description: 'Primary failover', startsAt: now - HOUR, endsAt: now + 90 * 60 * 1000, monitorIds: [10, 99] },
    { id: 2, name: 'Network work', description: null, startsAt: now + 2 * HOUR, endsAt: now + 4 * HOUR, monitorIds: [] },
    { id: 3, name: 'Old patching', description: null, startsAt: now - 5 * HOUR, endsAt: now - 5 * HOUR + 45 * 60 * 1000, monitorIds: [] },
  ]
}

/** A stored window as the API returns it: one-off unless the test says otherwise. */
function stored(win: Record<string, unknown> & { startsAt: number; endsAt: number }) {
  return {
    version: 1, recurrence: 'none', recurrenceDays: [], timezone: 'UTC', recurrenceUntil: null,
    occurrence: { startsAt: win.startsAt, endsAt: win.endsAt },
    ...win,
  }
}

function mockGets(list: Array<Parameters<typeof stored>[0]> = windows()) {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/admin/maintenance') return list.map(stored)
    if (path === '/admin/monitors') return [{ id: 10, name: 'Checkout API', type: 'https' }, { id: 11, name: 'Search', type: 'https' }]
    if (path === '/admin/subscribers/settings') return { enabled: true }
    throw new Error(`Unexpected GET ${path}`)
  })
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><ToastProvider><MaintenancePage /></ToastProvider></QueryClientProvider>)
}

describe('MaintenancePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGets()
    vi.mocked(api.post).mockResolvedValue({})
    vi.mocked(api.patch).mockResolvedValue({})
    vi.mocked(api.delete).mockResolvedValue(undefined)
  })

  it('splits windows into active, upcoming and past tabs', async () => {
    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByText('DB upgrade')).toBeInTheDocument()
    expect(screen.getByText('1 active · 1 upcoming · 1 past')).toBeInTheDocument()
    expect(screen.getByText('ACTIVE · 1h 30m remaining')).toBeInTheDocument()
    expect(screen.getByText('Primary failover')).toBeInTheDocument()
    expect(await screen.findByText('Checkout API')).toBeInTheDocument()
    expect(screen.getByText('#99')).toBeInTheDocument()
    expect(screen.getByText('(2h 30m)')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^upcoming/ }))
    expect(screen.getByText('Network work')).toBeInTheDocument()
    expect(screen.getByText('All monitors')).toBeInTheDocument()
    expect(screen.getByText('(2h)')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^past/ }))
    expect(screen.getByText('Old patching')).toBeInTheDocument()
    expect(screen.getByText('(45m)')).toBeInTheDocument()
  })

  it('shows empty states per tab', async () => {
    const user = userEvent.setup()
    mockGets([])
    renderPage()

    expect(await screen.findByText('No active maintenance windows')).toBeInTheDocument()
    expect(screen.queryByText(/All systems running normally/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'upcoming' }))
    expect(screen.getByText('No upcoming maintenance scheduled')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'past' }))
    expect(screen.getByText('No past maintenance windows')).toBeInTheDocument()
  })

  it('shows loading and error states instead of empty copy', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('boom'))
    renderPage()

    expect(screen.getByText('Loading maintenance windows…')).toBeInTheDocument()
    expect(await screen.findByText("Couldn't load maintenance windows.")).toBeInTheDocument()
    expect(screen.queryByText('No active maintenance windows')).not.toBeInTheDocument()
  })

  it('moves a window from upcoming to active as time passes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const now = Date.now()
      mockGets([{ id: 5, name: 'Soon', description: null, startsAt: now + 20_000, endsAt: now + HOUR, monitorIds: [] }])
      renderPage()

      expect(await screen.findByText('0 active · 1 upcoming · 0 past')).toBeInTheDocument()
      await act(async () => { await vi.advanceTimersByTimeAsync(31_000) })
      expect(screen.getByText('1 active · 0 upcoming · 0 past')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('offers to end only the running occurrence of a recurring window', async () => {
    const now = Date.now()
    mockGets([{
      id: 7, name: 'Nightly build', description: null, startsAt: now - 30 * 24 * HOUR, endsAt: now - 30 * 24 * HOUR + HOUR,
      recurrence: 'weekly', recurrenceDays: [2, 4], timezone: 'Europe/Warsaw', recurrenceUntil: null,
      occurrence: { startsAt: now - HOUR / 2, endsAt: now + HOUR / 2 }, monitorIds: [],
    }])
    renderPage()

    expect(await screen.findByText('Nightly build')).toBeInTheDocument()
    expect(screen.getByText('ACTIVE · 30m remaining')).toBeInTheDocument()
    expect(screen.getByText('Every Tue, Thu · Europe/Warsaw')).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'End now' }))
    expect(screen.getByText(/Only this occurrence ends/)).toBeInTheDocument()
  })


  it('disables recurring maintenance when the capability is absent', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: /Schedule Maintenance/ }))
    expect(screen.getByLabelText('Repeat')).toBeDisabled()
    expect(screen.getByText('Recurring maintenance is unavailable.')).toBeInTheDocument()
  })

  it('schedules a window for selected monitors without notifying subscribers', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: /Schedule Maintenance/ }))
    await user.type(screen.getByPlaceholderText('Scheduled database maintenance'), 'Kernel patch')
    await user.click(screen.getByRole('button', { name: 'Schedule' }))
    expect(screen.getByText('Select at least one monitor or choose all monitors.')).toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalled()
    await user.type(screen.getByPlaceholderText('Brief description visible on the status page…'), '  ')
    await user.click(await screen.findByRole('checkbox', { name: /^Search/ }))
    await user.click(screen.getByRole('button', { name: 'Schedule' }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/maintenance', expect.objectContaining({
      name: 'Kernel patch', description: null, monitorIds: [11],
    })))
    const payload = vi.mocked(api.post).mock.calls[0]![1] as { startsAt: number; endsAt: number }
    expect(payload.endsAt - payload.startsAt).toBe(2 * HOUR)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Schedule' })).not.toBeInTheDocument())
  })

  it('rejects an end time before the start and reports save failures', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockRejectedValueOnce(new Error('boom'))
    renderPage()

    await user.click(screen.getByRole('button', { name: /Schedule Maintenance/ }))
    await user.type(screen.getByPlaceholderText('Scheduled database maintenance'), 'Oops')
    const endDate = screen.getByLabelText('Ends At — YYYY-MM-DD') as HTMLInputElement
    fireEvent.change(endDate, { target: { value: '2020-01-01' } })
    await user.click(screen.getByRole('button', { name: 'Schedule' }))
    expect(screen.getByText('End time must be after start time.')).toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalled()

    fireEvent.change(endDate, { target: { value: '2999-01-01' } })
    await user.click(screen.getByRole('checkbox', { name: 'All monitors' }))
    await user.click(screen.getByRole('button', { name: 'Schedule' }))
    expect(await screen.findByText('Failed to save. Please try again.')).toBeInTheDocument()
    expect(api.post).toHaveBeenCalledWith('/admin/maintenance', expect.objectContaining({ monitorIds: [] }))

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('button', { name: 'Schedule' })).not.toBeInTheDocument()
  })

  it('edits an existing window', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Edit DB upgrade' }))
    expect(screen.getByRole('heading', { name: 'Edit Maintenance Window' })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'Notify subscribers' })).not.toBeInTheDocument()
    const name = screen.getByDisplayValue('DB upgrade')
    await user.clear(name)
    await user.type(name, 'DB upgrade v2')
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/maintenance/1', expect.objectContaining({
      name: 'DB upgrade v2', description: 'Primary failover', monitorIds: [10, 99],
    })))
  })


  it('ends an active window and prevents cancellation of an active window', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'End now' }))
    const dialog = screen.getByRole('dialog', { name: 'End maintenance early' })
    await user.click(within(dialog).getByRole('button', { name: 'End now' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/maintenance/1/end', { version: 1 }))
    expect(screen.getByRole('button', { name: 'Delete DB upgrade' })).toBeDisabled()
    expect(api.delete).not.toHaveBeenCalled()
  })

  it('keeps the end-early dialog open and reports a failure', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockRejectedValueOnce(new Error('Window already ended'))
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'End now' }))
    const endDialog = screen.getByRole('dialog', { name: 'End maintenance early' })
    await user.click(within(endDialog).getByRole('button', { name: 'End now' }))

    expect(await screen.findByText("Couldn't end maintenance: Window already ended")).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'End maintenance early' })).toBeInTheDocument()
  })
})
