import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import SystemHealthPage from './SystemHealth'

vi.mock('../api/client', () => ({ api: { get: vi.fn() } }))

const report = {
  status: 'healthy' as const,
  generatedAt: 1_750_000_000_000,
  application: { status: 'ok' as const },
  database: { status: 'ok' as const, responseMs: 4 },
  monitoring: { status: 'ok' as const, configuredMonitors: 12, overdueMonitors: 0, lastMonitorCheckAt: 1_750_000_000_000 },
  gatus: { status: 'disabled' as const, configuredMonitors: null },
  notifications: { status: 'disabled' as const },
  backups: { status: 'ok' as const },
  staticMirror: { status: 'disabled' as const },
}

describe('SystemHealthPage', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.get).mockResolvedValue(report) })

  it('shows the Cloudflare health report and refreshes it manually', async () => {
    const user = userEvent.setup()
    const view = render(<SystemHealthPage />)
    expect(await screen.findByText('BetterStatusPage is healthy')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByText('Responding')).toBeInTheDocument()
    expect(screen.getByText('Not checked')).toBeInTheDocument()
    expect(api.get).toHaveBeenCalledWith('/admin/system-health')
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2))
    view.unmount()
  })

  it('shows degraded and unavailable dependencies without claiming they are healthy', async () => {
    vi.mocked(api.get).mockResolvedValue({ ...report, status: 'degraded', database: { status: 'error', responseMs: null }, monitoring: { status: 'attention', configuredMonitors: 12, overdueMonitors: 2, lastMonitorCheckAt: null }, backups: { status: 'error' } })
    render(<SystemHealthPage />)
    expect(await screen.findByText('BetterStatusPage needs attention')).toBeInTheDocument()
    expect(within(screen.getByRole('heading', { name: 'Database' }).closest('section')!).getAllByText('Unavailable')).toHaveLength(2)
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(within(screen.getByRole('heading', { name: 'Backups' }).closest('section')!).getByText('Unavailable')).toBeInTheDocument()
  })

  it('reports a failed request and supports retry', async () => {
    const user = userEvent.setup()
    vi.mocked(api.get).mockRejectedValueOnce(new Error('Health unavailable')).mockResolvedValue(report)
    render(<SystemHealthPage />)
    expect(await screen.findByText('Health unavailable')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /try again/i }))
    expect(await screen.findByText('BetterStatusPage is healthy')).toBeInTheDocument()
  })
})
