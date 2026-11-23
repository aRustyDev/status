import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useSSE } from './useSSE'

describe('status polling', () => {
  it('refreshes every 30 seconds and stops when unmounted', () => {
    vi.useFakeTimers()
    const refresh = vi.fn()
    const { result, unmount } = renderHook(() => useSSE(refresh))
    expect(result.current).toEqual({})
    act(() => vi.advanceTimersByTime(30_000))
    expect(refresh).toHaveBeenCalledTimes(1)
    unmount()
    act(() => vi.advanceTimersByTime(30_000))
    expect(refresh).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})
