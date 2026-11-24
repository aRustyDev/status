import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MonitorDetails from './MonitorDetails'

const { query, navigate, success } = vi.hoisted(() => ({ query: vi.fn(), navigate: vi.fn(), success: vi.fn() }))
vi.mock('@tanstack/react-query', () => ({ useQuery: query }))
vi.mock('react-router-dom', () => ({ useParams: () => ({ id: '7' }), useNavigate: () => navigate }))
vi.mock('@better-forge/ui', () => ({ useToast: () => ({ success }) }))
vi.mock('../components/monitors/MonitorFormModal', () => ({
  default: ({ monitor, onClose, onSaved }: { monitor: { name: string }; onClose: () => void; onSaved: () => void }) => <div>
    <p>{monitor.name}</p><button onClick={onClose}>Close form</button><button onClick={onSaved}>Save form</button>
  </div>,
}))

describe('MonitorDetails', () => {
  beforeEach(() => { query.mockReset(); navigate.mockReset(); success.mockReset() })

  it('shows loading and an unavailable state before rendering a matching monitor', () => {
    query.mockReturnValue({ isPending: true })
    const { rerender } = render(<MonitorDetails />)
    expect(screen.getByText('Loading monitor…')).toBeVisible()
    query.mockReturnValue({ isPending: false, data: [] })
    rerender(<MonitorDetails />)
    expect(screen.getByText('Monitor unavailable.')).toBeVisible()
    query.mockReturnValue({ isPending: false, data: [{ id: 7, name: 'Service seven' }] })
    rerender(<MonitorDetails />)
    expect(screen.getByText('Service seven')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Close form' }))
    expect(navigate).toHaveBeenCalledWith('/admin/monitors')
    fireEvent.click(screen.getByRole('button', { name: 'Save form' }))
    expect(success).toHaveBeenCalledWith('Changes saved')
    expect(navigate).toHaveBeenCalledTimes(2)
  })
})
