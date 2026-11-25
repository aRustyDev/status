import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { getJSON } from './api'
import App from './App'

vi.mock('./dataSource', () => ({ SNAPSHOT_URL: '/__fallback/snapshot.json' }))
vi.mock('./api', async (importOriginal) => ({ ...await importOriginal<typeof import('./api')>(), getJSON: vi.fn() }))
vi.mock('./hooks/useDarkMode', () => ({ useDarkMode: () => [false, vi.fn()] }))
vi.mock('./hooks/useSSE', () => ({ useSSE: () => ({}) }))
vi.mock('./components/SnapshotBanner', () => ({ SnapshotBanner: () => <div>Saved copy</div> }))
vi.mock('./components/PageRenderer', () => ({ PageRenderer: () => <div>Snapshot content</div> }))
vi.mock('./components/Subscriptions', () => ({
  FEED_URL: '/feed', useSubscriptionOptions: () => ({ data: undefined }), readSubscriptionLink: () => null,
  clearSubscriptionLink: vi.fn(), SubscribeDialog: () => null, SubscriptionLinkDialog: () => null,
}))

it('renders a snapshot without requesting live identity or capabilities', async () => {
  vi.mocked(getJSON).mockImplementation(async (path) => {
    if (path === '/api/v1/public/status') return { branding: null, monitors: [], activeIncidents: [], activeMaintenanceWindows: [], monitorDependencies: [] }
    if (path === '/api/v1/public/layout') return { branding: null, tree: { id: 'root', type: 'page', children: [] } }
    if (path.startsWith('/api/v1/public/')) return []
    throw new Error(`Unexpected request ${path}`)
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><App /></QueryClientProvider>)
  expect(await screen.findByText('Saved copy')).toBeInTheDocument()
  await waitFor(() => expect(vi.mocked(getJSON)).toHaveBeenCalledWith('/api/v1/public/status', expect.anything(), 15_000))
  expect(vi.mocked(getJSON).mock.calls.every(([path]) => path.startsWith('/api/v1/public/'))).toBe(true)
  expect(screen.getAllByRole('img').some(image => image.getAttribute('src') === '/__fallback/logo_light.png')).toBe(true)
  fireEvent(window, new Event('access-session-expired'))
  expect(screen.getByText('Your Access session has expired.')).toBeInTheDocument()
  expect(screen.queryByText('Saved copy')).not.toBeInTheDocument()
  expect(client.getQueryCache().getAll()).toHaveLength(0)
})
