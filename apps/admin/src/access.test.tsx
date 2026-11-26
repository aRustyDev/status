import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { api } from './api/client'
import App from './App'

vi.mock('./api/client', () => ({ api: { get: vi.fn() } }))
vi.mock('./pages/Dashboard', async () => {
  const { Modal, useToast } = await import('@better-forge/ui')
  function MockDashboard() {
    const toast = useToast()
    return <Modal title="Edit incident" icon="edit" onClose={() => {}}>
      <input aria-label="Draft incident" />
      <button type="button" onClick={() => toast.success('Published protected incident', { duration: 0 })}>Show notification</button>
    </Modal>
  }
  return { default: MockDashboard }
})

it('hides the console during expiry and retains a draft for the same identity', async () => {
  const identity = { id: 'operator-uuid', email: 'operator@example.com', role: 'operator' }
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/auth/me') return identity
    if (path === '/capabilities') return { supportedRoutes: ['/admin/'] }
    throw new Error(`Unexpected request ${path}`)
  })
  window.history.replaceState({}, '', '/admin/')
  const user = userEvent.setup()
  render(<App />)
  const draft = await screen.findByLabelText('Draft incident')
  await user.type(draft, 'Investigating')
  window.dispatchEvent(new Event('access-expired'))
  expect(await screen.findByText('Your Access session has expired.')).toBeInTheDocument()
  expect(screen.getByLabelText('Draft incident')).not.toBeVisible()
  expect(screen.getByRole('dialog', { name: 'Access session expired' })).toBeVisible()
  expect(screen.getByRole('link', { name: 'Sign in' })).toBeVisible()
  await user.tab()
  expect(screen.getByRole('link', { name: 'Sign in' })).toHaveFocus()
  await user.tab()
  expect(screen.getByRole('button', { name: 'Continue' })).toHaveFocus()
  await user.click(screen.getByRole('button', { name: 'Continue' }))
  await waitFor(() => expect(screen.getByLabelText('Draft incident')).toHaveValue('Investigating'))
})


it('hides notifications during expiry and restores them for the same identity', async () => {
  const identity = { id: 'operator-uuid', email: 'operator@example.com', role: 'operator' }
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/auth/me') return identity
    if (path === '/capabilities') return { supportedRoutes: ['/admin/'] }
    throw new Error(`Unexpected request ${path}`)
  })
  window.history.replaceState({}, '', '/admin/')
  const user = userEvent.setup()
  render(<App />)
  await user.click(await screen.findByRole('button', { name: 'Show notification' }))
  const notification = screen.getByText('Published protected incident')
  expect(notification).toBeVisible()
  window.dispatchEvent(new Event('access-expired'))
  expect(await screen.findByRole('dialog', { name: 'Access session expired' })).toBeVisible()
  expect(notification).not.toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Continue' }))
  await waitFor(() => expect(notification).toBeVisible())
})

it('drops previous identity notifications and drafts after a different identity signs in', async () => {
  let identity = { id: 'first-operator', email: 'first@example.com', role: 'operator' }
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/auth/me') return identity
    if (path === '/capabilities') return { supportedRoutes: ['/admin/'] }
    throw new Error(`Unexpected request ${path}`)
  })
  window.history.replaceState({}, '', '/admin/')
  const user = userEvent.setup()
  render(<App />)
  await user.type(await screen.findByLabelText('Draft incident'), 'Private draft')
  await user.click(screen.getByRole('button', { name: 'Show notification' }))
  window.dispatchEvent(new Event('access-expired'))
  expect(await screen.findByRole('dialog', { name: 'Access session expired' })).toBeVisible()
  identity = { id: 'second-operator', email: 'second@example.com', role: 'operator' }
  await user.click(screen.getByRole('button', { name: 'Continue' }))
  await waitFor(() => expect(screen.getByLabelText('Draft incident')).toHaveValue(''))
  expect(screen.queryByText('Published protected incident')).not.toBeInTheDocument()
})

it('ignores a stale reconnect response after a newer account has signed in', async () => {
  const first = { id: 'first-operator', email: 'first@example.com', role: 'operator' }
  const second = { id: 'second-operator', email: 'second@example.com', role: 'operator' }
  let resolveOld!: (value: typeof first) => void
  const old = new Promise<typeof first>(resolve => { resolveOld = resolve })
  let calls = 0
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/auth/me') { calls++; return calls === 1 ? first : calls === 2 ? old : second }
    if (path === '/capabilities') return { supportedRoutes: ['/admin/'] }
    throw new Error(`Unexpected request ${path}`)
  })
  window.history.replaceState({}, '', '/admin/')
  const user = userEvent.setup()
  render(<App />)
  await user.type(await screen.findByLabelText('Draft incident'), 'Private draft')
  window.dispatchEvent(new Event('access-expired'))
  const button = await screen.findByRole('button', { name: 'Continue' })
  await user.click(button)
  await user.click(button)
  await waitFor(() => expect(screen.getByText('second@example.com')).toBeVisible())
  await act(async () => { resolveOld(first); await old })
  expect(screen.getByText('second@example.com')).toBeVisible()
  expect(screen.getByLabelText('Draft incident')).toHaveValue('')
})

it.each([
  ['operator', ['/admin/', '/admin/system-health']],
  ['admin', ['/admin/']],
])('keeps System Health unavailable for %s without its role and capability', async (role, supportedRoutes) => {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/auth/me') return { id: 'identity', email: 'test@example.com', role }
    if (path === '/capabilities') return { supportedRoutes }
    throw new Error(`Unexpected request ${path}`)
  })
  window.history.replaceState({}, '', '/admin/system-health')
  render(<App />)
  expect(await screen.findByText('This feature is unavailable.')).toBeInTheDocument()
  expect(api.get).not.toHaveBeenCalledWith('/admin/system-health')
})

it.each([
  ['operator', ['/admin/', '/admin/static-fallback']],
  ['admin', ['/admin/']],
])('keeps Static fallback unavailable for %s without its role and capability', async (role, supportedRoutes) => {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/auth/me') return { id: 'identity', email: 'test@example.com', role }
    if (path === '/capabilities') return { supportedRoutes }
    throw new Error(`Unexpected request ${path}`)
  })
  window.history.replaceState({}, '', '/admin/static-fallback')
  render(<App />)
  expect(await screen.findByText('This feature is unavailable.')).toBeInTheDocument()
  expect(api.get).not.toHaveBeenCalledWith('/admin/static-mirror')
})

it.each([
  ['operator', ['/admin/', '/admin/actions']],
  ['admin', ['/admin/']],
])('keeps action delivery history unavailable for %s without its role and capability', async (role, supportedRoutes) => {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/auth/me') return { id: 'identity', email: 'test@example.com', role }
    if (path === '/capabilities') return { supportedRoutes }
    throw new Error(`Unexpected request ${path}`)
  })
  window.history.replaceState({}, '', '/admin/delivery-history?tab=actions')
  render(<App />)
  expect(await screen.findByText('This feature is unavailable.')).toBeInTheDocument()
  expect(api.get).not.toHaveBeenCalledWith('/admin/actions/runs')
})

it.each([
  ['operator', ['/admin/', '/admin/users']],
  ['admin', ['/admin/']],
])('keeps Users unavailable for %s without its role and capability', async (role, supportedRoutes) => {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/auth/me') return { id: 'identity', email: 'test@example.com', role }
    if (path === '/capabilities') return { supportedRoutes }
    throw new Error(`Unexpected request ${path}`)
  })
  window.history.replaceState({}, '', '/admin/users')
  render(<App />)
  expect(await screen.findByText('This feature is unavailable.')).toBeInTheDocument()
  expect(api.get).not.toHaveBeenCalledWith('/admin/users')
})

it('loads Users for an administrator when the route is supported', async () => {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/auth/me') return { id: 'identity', email: 'test@example.com', role: 'admin' }
    if (path === '/capabilities') return { supportedRoutes: ['/admin/', '/admin/users'] }
    if (path === '/admin/users') return [{ id: 'identity', email: 'test@example.com', role: 'admin', version: 1 }]
    throw new Error(`Unexpected request ${path}`)
  })
  window.history.replaceState({}, '', '/admin/users')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><App /></QueryClientProvider>)
  expect(await screen.findByText('(you)')).toBeInTheDocument()
  expect(api.get).toHaveBeenCalledWith('/admin/users')
})
