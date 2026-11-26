import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiError } from '@better-forge/ui'
import { beforeEach, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import Users from './Users'

vi.mock('../api/client', () => ({ api: { get: vi.fn(), patch: vi.fn() } }))

const admin = { id: 'admin-id', email: 'admin@example.test', role: 'admin', version: 2 }
const viewer = { id: 'viewer-id', email: 'viewer@example.test', role: 'viewer', version: 5 }

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><Users identityId={admin.id} /></QueryClientProvider>)
  return userEvent.setup()
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.get).mockResolvedValue([admin, viewer])
})

it('shows Access-managed identities and keeps the current administrator role read-only', async () => {
  renderPage()
  expect(await screen.findByText(viewer.email)).toBeInTheDocument()
  expect(screen.getByText(/Cloudflare Access/i)).toBeInTheDocument()
  expect(screen.queryByRole('group', { name: `Role for ${admin.email}` })).not.toBeInTheDocument()
  const roles = screen.getByRole('group', { name: `Role for ${viewer.email}` })
  expect(within(roles).getByRole('button', { name: 'Viewer' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.queryByRole('button', { name: /new user|reset password/i })).not.toBeInTheDocument()
})

it('requires confirmation and keeps the old role while a versioned save is pending', async () => {
  const user = renderPage()
  const roles = await screen.findByRole('group', { name: `Role for ${viewer.email}` })
  await user.click(within(roles).getByRole('button', { name: 'Operator' }))
  let dialog = screen.getByRole('dialog')
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(api.patch).not.toHaveBeenCalled()
  await user.click(within(roles).getByRole('button', { name: 'Operator' }))
  dialog = screen.getByRole('dialog')
  let resolveSave!: (value: unknown) => void
  const pending = new Promise(resolve => { resolveSave = resolve })
  vi.mocked(api.patch).mockReturnValueOnce(pending)
  await user.click(within(dialog).getByRole('button', { name: 'Change role' }))
  expect(api.patch).toHaveBeenCalledWith(`/admin/users/${viewer.id}`, { role: 'operator', version: 5 })
  expect(within(roles).getByRole('button', { name: 'Viewer' })).toHaveAttribute('aria-pressed', 'true')
  expect(within(dialog).getByRole('button', { name: /saving/i })).toBeDisabled()
  vi.mocked(api.get).mockResolvedValue([admin, { ...viewer, role: 'operator', version: 6 }])
  await act(async () => { resolveSave({ id: viewer.id, role: 'operator', version: 6 }); await pending })
  await waitFor(() => expect(within(roles).getByRole('button', { name: 'Operator' })).toHaveAttribute('aria-pressed', 'true'))
})

it('reloads a stale role and requires a fresh confirmation before retrying', async () => {
  const user = renderPage()
  const roles = await screen.findByRole('group', { name: `Role for ${viewer.email}` })
  vi.mocked(api.patch).mockRejectedValueOnce(new ApiError('This record changed. Reload and try again.', 409))
  vi.mocked(api.get).mockResolvedValue([admin, { ...viewer, role: 'operator', version: 6 }])
  await user.click(within(roles).getByRole('button', { name: 'Admin' }))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Change role' }))
  await waitFor(() => expect(within(roles).getByRole('button', { name: 'Operator' })).toHaveAttribute('aria-pressed', 'true'))
  expect(api.patch).toHaveBeenCalledTimes(1)
  await user.click(within(roles).getByRole('button', { name: 'Admin' }))
  vi.mocked(api.patch).mockResolvedValueOnce({ id: viewer.id, role: 'admin', version: 7 })
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Change role' }))
  expect(api.patch).toHaveBeenLastCalledWith(`/admin/users/${viewer.id}`, { role: 'admin', version: 6 })
})

it('offers a retry when users cannot be loaded', async () => {
  vi.mocked(api.get).mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValue([admin, viewer])
  const user = renderPage()
  await user.click(await screen.findByRole('button', { name: 'Try again' }))
  expect(await screen.findByText(viewer.email)).toBeInTheDocument()
})

it('keeps the same role and version available after an ambiguous save failure', async () => {
  const user = renderPage()
  const roles = await screen.findByRole('group', { name: `Role for ${viewer.email}` })
  vi.mocked(api.patch).mockRejectedValueOnce(new Error('The save may have completed. Retry without changing the form.'))
  await user.click(within(roles).getByRole('button', { name: 'Operator' }))
  const dialog = screen.getByRole('dialog')
  await user.click(within(dialog).getByRole('button', { name: 'Change role' }))
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('The save may have completed')
  vi.mocked(api.patch).mockResolvedValueOnce({ id: viewer.id, role: 'operator', version: 6 })
  await user.click(within(dialog).getByRole('button', { name: 'Change role' }))
  expect(api.patch).toHaveBeenCalledTimes(2)
  expect(api.patch).toHaveBeenLastCalledWith(`/admin/users/${viewer.id}`, { role: 'operator', version: 5 })
})
