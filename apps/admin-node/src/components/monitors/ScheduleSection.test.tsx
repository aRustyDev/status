import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ScheduleSection, type ScheduleValues } from './ScheduleSection'

const defaults: ScheduleValues = {
  intervalSecs: 60,
  timeoutMs: 10000,
  retries: 1,
  failureThreshold: 1,
  recoveryThreshold: 1,
}

function ScheduleForm({ cloudflare = false }: { cloudflare?: boolean }) {
  const [values, setValues] = useState(defaults)
  return <ScheduleSection cloudflare={cloudflare} values={values} onChange={patch => setValues(previous => ({ ...previous, ...patch }))} />
}

describe('ScheduleSection', () => {
  it('edits Node schedules and retains values when the section is collapsed', async () => {
    const user = userEvent.setup()
    render(<ScheduleForm />)

    const toggle = screen.getByRole('button', { name: /Schedule & alerting/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveTextContent('Every 60 s')
    expect(toggle).toHaveTextContent('1 attempt')
    await user.click(toggle)

    fireEvent.change(screen.getByLabelText('Interval (s)'), { target: { value: '120' } })
    fireEvent.change(screen.getByLabelText('Timeout (ms)'), { target: { value: '5000' } })
    fireEvent.change(screen.getByLabelText('Attempts'), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText('Alert after (checks)'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Recover after (checks)'), { target: { value: '4' } })

    expect(toggle).toHaveTextContent('Every 120 s')
    expect(toggle).toHaveTextContent('Timeout 5 s')
    expect(toggle).toHaveTextContent('3 attempts')
    expect(toggle).toHaveTextContent('Alert after 2')
    expect(toggle).toHaveTextContent('Recover after 4')
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)
    expect(screen.getByLabelText('Interval (s)')).toHaveValue(120)
    expect(screen.getByLabelText('Recover after (checks)')).toHaveValue(4)
  })

  it('offers supported Cloudflare intervals and bounds attempt count', async () => {
    const user = userEvent.setup()
    render(<ScheduleForm cloudflare />)

    const toggle = screen.getByRole('button', { name: /Schedule & alerting/ })
    await user.click(toggle)
    await user.selectOptions(screen.getByLabelText('Interval (s)'), '300')
    fireEvent.change(screen.getByLabelText('Timeout (ms)'), { target: { value: '2000' } })
    fireEvent.change(screen.getByLabelText('Attempts'), { target: { value: '0' } })

    expect(toggle).toHaveTextContent('Every 300 s')
    expect(toggle).toHaveTextContent('Timeout 2 s')
    expect(screen.getByLabelText('Attempts')).toHaveValue(1)
    expect(screen.queryByLabelText('Alert after (checks)')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Recover after (checks)')).not.toBeInTheDocument()
  })
})
