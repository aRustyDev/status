import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { api } from './api/client'
import App from './App'

vi.mock('./api/client', () => ({ api: { get: vi.fn() } }))
vi.mock('./pages/Dashboard', () => ({ default: () => <p>Dashboard content</p> }))

it('keeps keyboard focus in mobile navigation and restores it after Escape', async () => {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/auth/me') return { id: 'operator', email: 'operator@example.test', role: 'operator' }
    if (path === '/capabilities') return { supportedRoutes: ['/admin/', '/admin/monitors'] }
    throw new Error(`Unexpected request ${path}`)
  })
  window.history.replaceState({}, '', '/admin/')
  const user = userEvent.setup()
  render(<App />)
  const opener = await screen.findByRole('button', { name: 'Open navigation' })
  await user.click(opener)
  const dialog = screen.getByRole('dialog', { name: 'Navigation' })
  expect(within(dialog).getByRole('button', { name: 'Close navigation' })).toHaveFocus()
  const first = within(dialog).getByRole('link', { name: /BetterStatusPage/ })
  const last = within(dialog).getByRole('button', { name: 'Sign out' })
  last.focus()
  await user.tab()
  expect(first).toHaveFocus()
  await user.tab({ shift: true })
  expect(last).toHaveFocus()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog', { name: 'Navigation' })).not.toBeInTheDocument()
  expect(opener).toHaveFocus()
  expect(opener).toHaveAttribute('aria-expanded', 'false')
})
