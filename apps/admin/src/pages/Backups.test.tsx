import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import Backups from './Backups'

vi.mock('../api/client', () => ({ api: { get: vi.fn(), post: vi.fn() } }))
const backup = { id: 'a'.repeat(64), state: 'complete', createdAt: 1730000000000, size: 1024 }
function show() { render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Backups /></QueryClientProvider>) }
describe('Cloudflare backups', () => {
  beforeEach(() => { vi.mocked(api.get).mockReset(); vi.mocked(api.post).mockReset() })
  it('creates and verifies stored exports and keeps unsupported scheduling disabled', async () => {
    vi.mocked(api.get).mockImplementation(async path => path.endsWith('/verify') ? { valid: true } as never : { backups: [backup], nextCursor: null } as never)
    vi.mocked(api.post).mockResolvedValue({ id: backup.id })
    const user = userEvent.setup()
    show()
    expect(await screen.findByText(backup.id)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Configure schedule' })).toBeDisabled()
    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute('href', `/api/v1/bsp/admin/backups/${backup.id}/download`)
    await user.click(screen.getByRole('button', { name: 'Verify' }))
    expect(await screen.findByText(/passed its integrity check/)).toBeInTheDocument()
    expect(vi.mocked(api.get)).toHaveBeenCalledWith(`/admin/backups/${backup.id}/verify`, { timeoutMs: 120_000 })
    await user.click(screen.getByRole('button', { name: 'Create backup' }))
    await waitFor(() => expect(vi.mocked(api.post)).toHaveBeenCalledWith('/admin/backups', {}))
    expect(await screen.findByText(/Backup started/)).toBeInTheDocument()
  })
  it('shows unavailable state and retries loading', async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ backups: [], nextCursor: null })
    const user = userEvent.setup()
    show()
    expect(await screen.findByText('Could not load backups.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /try again/i }))
    expect(await screen.findByText('No backups yet')).toBeInTheDocument()
  })
  it('reports failed creation and verification without claiming success', async () => {
    vi.mocked(api.get).mockImplementation(async path => {
      if (path.endsWith('/verify')) throw new Error('Backup integrity check failed')
      return { backups: [backup], nextCursor: null } as never
    })
    vi.mocked(api.post).mockRejectedValue(new Error('Export unavailable'))
    const user = userEvent.setup()
    show()
    await screen.findByText(backup.id)
    await user.click(screen.getByRole('button', { name: 'Create backup' }))
    expect(await screen.findByText('Export unavailable')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Verify' }))
    expect(await screen.findByText('Backup integrity check failed')).toBeInTheDocument()
    expect(screen.queryByText(/passed its integrity check/)).not.toBeInTheDocument()
  })
  it('does not treat an invalid verification response as success', async () => {
    vi.mocked(api.get).mockImplementation(async path => path.endsWith('/verify') ? { valid: false } as never : { backups: [backup], nextCursor: null } as never)
    const user = userEvent.setup()
    show()
    await screen.findByText(backup.id)
    await user.click(screen.getByRole('button', { name: 'Verify' }))
    expect(await screen.findByText('Backup verification failed.')).toBeInTheDocument()
    expect(screen.queryByText(/passed its integrity check/)).not.toBeInTheDocument()
  })
  it('loads subsequent pages and can return to the first page', async () => {
    vi.mocked(api.get).mockImplementation(async path => path.includes('cursor=')
      ? { backups: [{ ...backup, id: 'b'.repeat(64) }], nextCursor: null } as never
      : { backups: [backup], nextCursor: 'next page' } as never)
    const user = userEvent.setup()
    show()
    expect(await screen.findByText(backup.id)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByText('b'.repeat(64))).toBeInTheDocument()
    expect(vi.mocked(api.get)).toHaveBeenCalledWith('/admin/backups?cursor=next%20page')
    await user.click(screen.getByRole('button', { name: 'Previous' }))
    expect(await screen.findByText(backup.id)).toBeInTheDocument()
  })
})
