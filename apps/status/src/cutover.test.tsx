import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getJSON } from './api'
import App from './App'

vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(),
  getJSON: vi.fn(),
}))
vi.mock('./hooks/useDarkMode', () => ({ useDarkMode: () => [false, vi.fn()] }))
vi.mock('./hooks/useSSE', () => ({ useSSE: () => ({}) }))
vi.mock('./components/PageRenderer', () => ({
  PageRenderer: ({ monitors }: { monitors: Array<{ id: number; currentStatus: string }> }) => (
    <div>{monitors.map((monitor) => <span key={monitor.id}>{monitor.currentStatus}</span>)}</div>
  ),
}))
vi.mock('./components/Subscriptions', () => ({
  FEED_URL: '/feed',
  useSubscriptionOptions: () => ({ data: undefined }),
  readSubscriptionLink: () => null,
  clearSubscriptionLink: vi.fn(),
  SubscribeDialog: () => null,
  SubscriptionLinkDialog: () => null,
}))

describe('Cloudflare status page', () => {
  beforeEach(() => {
    vi.mocked(getJSON).mockImplementation(async (path) => {
      if (path === '/api/v1/capabilities') return { subscriptions: false, retentionDays: 14 }
      if (path === '/api/v1/auth/me') return { email: 'reader@example.com', role: 'viewer' }
      if (path === '/api/v1/public/status') return {
        branding: null,
        monitors: [{ id: 1, name: 'API', type: 'https', currentStatus: 'pending' }],
        activeIncidents: [], activeMaintenanceWindows: [], monitorDependencies: [],
      }
      if (path === '/api/v1/public/layout') return {
        branding: null,
        tree: { id: 'root', type: 'page', children: [{ id: 'm1', type: 'monitor', monitorId: 1 }] },
      }
      if (path.startsWith('/api/v1/public/incidents')) return []
      throw new Error(`Unexpected request ${path}`)
    })
  })

  it('shows unknown health and hides the page on Access expiry', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>)
    expect(await screen.findByRole('heading', { name: 'Service status unknown' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'All systems operational.' })).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'History range' })).toHaveAccessibleDescription('History beyond 14 days is unavailable.')
    expect(screen.getByRole('option', { name: '14 days' })).toBeEnabled()
    expect(screen.getByRole('option', { name: '30 days' })).toBeDisabled()
    expect(screen.getByRole('option', { name: '90 days' })).toBeDisabled()
    fireEvent(window, new Event('access-session-expired'))
    expect(screen.getByText('Your Access session has expired.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Service status unknown' })).not.toBeInTheDocument()
  })
})
