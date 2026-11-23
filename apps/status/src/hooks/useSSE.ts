import { useEffect } from 'react'
import type { MonitorStatus } from '@bsp/shared'
import { SNAPSHOT_URL } from '../dataSource'

interface StatusMap {
  [monitorId: number]: { status: MonitorStatus; responseMs: number | null; checkedAt: number }
}

const emptyStatusMap: StatusMap = {}

export function useSSE(onIncidentChange?: () => void): StatusMap {
  useEffect(() => {
    if (SNAPSHOT_URL) return
    const timer = setInterval(() => onIncidentChange?.(), 30_000)
    return () => clearInterval(timer)
  }, [onIncidentChange])

  return emptyStatusMap
}
