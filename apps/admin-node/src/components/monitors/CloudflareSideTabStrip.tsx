import clsx from 'clsx'
import type { SidePanelMeta } from '@better-forge/ui'
import type { SidePanelKey } from './MonitorSidePanel'

// Adapted from @better-forge/ui's SideTabStrip; see THIRD_PARTY_LICENSE_BetterStatusPage.
// The shared strip does not yet support disabled tabs.
export function CloudflareSideTabStrip({ meta, active, onToggle, canEditChecks, canEditAuth = false, canEditRequest = false, canEditAlerts = false, canEditActions = false, canEditDependencies = false, checkCount, tagCount, alertCount = 0, dependencyCount = 0, className }: {
  meta: Record<SidePanelKey, SidePanelMeta>
  active: SidePanelKey | null
  onToggle: (key: SidePanelKey | null) => void
  canEditChecks: boolean
  canEditAuth?: boolean
  canEditRequest?: boolean
  canEditAlerts?: boolean
  canEditActions?: boolean
  canEditDependencies?: boolean
  checkCount: number
  tagCount: number
  alertCount?: number
  dependencyCount?: number
  className?: string | undefined
}) {
  const tabs: SidePanelKey[] = ['auth', 'request', 'checks', 'tags', 'channels', 'actions', 'dependencies', 'incident', 'latency']

  return <div role="toolbar" className={clsx('flex items-stretch border-outline-variant flex-row w-full border-t overflow-x-auto rounded-b-2xl lg:w-11 lg:flex-none lg:flex-col lg:border-t-0 lg:border-l lg:rounded-b-none lg:rounded-r-2xl', className)}>
    {tabs.map(key => {
      const disabled = key === 'tags' ? false : key === 'checks' ? !canEditChecks : key === 'auth' ? !canEditAuth : key === 'request' ? !canEditRequest : key === 'channels' ? !canEditAlerts : key === 'actions' ? !canEditActions : key === 'dependencies' ? !canEditDependencies : true
      const isActive = active === key
      const current = meta[key]
      return <button key={key} type="button" disabled={disabled} aria-pressed={isActive}
        aria-label={current.label} title={disabled ? `${current.label} (unavailable)` : current.label}
        onClick={() => onToggle(isActive ? null : key)}
        className={clsx('relative flex flex-col items-center justify-center transition-all border-outline-variant focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-outline flex-1 min-w-[44px] py-3 border-r last:border-r-0 lg:flex-none lg:py-4 lg:border-r-0 lg:border-b', disabled ? 'opacity-40 cursor-not-allowed' : isActive ? 'side-tab-active' : 'hover:bg-surface-container')}
        style={{ color: isActive ? 'var(--m3-primary)' : 'var(--m3-secondary)', background: isActive ? 'var(--m3-primary-fixed)' : undefined }}>
        <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '18px' }}>{current.icon}</span>
        {((key === 'checks' && checkCount > 0) || (key === 'tags' && tagCount > 0) || (key === 'channels' && alertCount > 0) || (key === 'dependencies' && dependencyCount > 0)) && <span className={clsx('absolute top-1.5 right-1 flex items-center justify-center rounded-full font-bold leading-none', isActive && 'side-tab-badge-active')}
          style={{ background: isActive ? 'var(--m3-primary)' : 'var(--m3-on-surface-variant)', color: isActive ? 'var(--m3-on-primary)' : 'var(--m3-surface)', minWidth: '14px', height: '14px', fontSize: '9px', padding: '0 2px' }}>{key === 'tags' ? tagCount : key === 'channels' ? alertCount : key === 'dependencies' ? dependencyCount : checkCount}</span>}
      </button>
    })}
  </div>
}
