import { useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react'
import { BrowserRouter, Link, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { ErrorBoundary, LoadingState, ModalShell, ToastProvider, clearSession, setSession } from '@better-forge/ui'
import { api } from './api/client'
import { ALL_SECTIONS } from './components/Layout'
import { CapabilitiesContext, type Capabilities } from './capabilities'
import { setMutationActor } from '@bsp/shared'

const Dashboard = lazy(() => import('./pages/Dashboard'))
const Monitors = lazy(() => import('./pages/Monitors'))
const MonitorDetails = lazy(() => import('./pages/MonitorDetails'))
const Incidents = lazy(() => import('./pages/Incidents'))
const Maintenance = lazy(() => import('./pages/Maintenance'))
const Users = lazy(() => import('./pages/Users'))
const Audit = lazy(() => import('./pages/AuditLog'))
const Vault = lazy(() => import('./pages/Vault'))
const Notifications = lazy(() => import('./pages/CloudflareNotifications'))
const Actions = lazy(() => import('./pages/CloudflareActions'))
const DeliveryHistory = lazy(() => import('./pages/CloudflareDeliveryHistory'))
const Backups = lazy(() => import('./pages/Backups'))
const SystemHealth = lazy(() => import('./pages/SystemHealth'))
const StaticFallback = lazy(() => import('./pages/CloudflareStaticFallback'))

type Identity = { id: string; email: string; role: 'viewer' | 'operator' | 'admin'; serverTime?: number; previewActionsEditor?: boolean }

function Shell({ identity, capabilities }: { identity: Identity; capabilities: Capabilities }) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  const supported = new Set(capabilities.supportedRoutes)
  useEffect(() => {
    if (!drawerOpen) return
    const closeOnDesktop = () => { if (window.innerWidth >= 768) setDrawerOpen(false) }
    window.addEventListener('resize', closeOnDesktop)
    return () => window.removeEventListener('resize', closeOnDesktop)
  }, [drawerOpen])
  function signOut() {
    clearSession()
    window.location.assign('/cdn-cgi/access/logout')
  }
  function toggleDark() {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle('dark', next)
    try { localStorage.setItem('bsp-dark-mode', String(next)) } catch { /* storage may be disabled */ }
  }
  const brand = <a href="/" className="flex items-center gap-3 px-4 py-4">
    <img src="/admin/icon.png" alt="" className="w-10 h-10" />
    <span><strong className="block">BetterStatusPage</strong><small>Admin Console</small></span>
  </a>
  const navigation = <div className="flex flex-col flex-1 min-h-0">
    <nav aria-label="Administration" className="flex-1 px-3 overflow-y-auto pb-2">
      {ALL_SECTIONS.map(section => <section key={section.label} className="mt-4">
        <h2 className="px-4 pb-1 font-mono uppercase tracking-widest text-xs">{section.label}</h2>
        {section.items.map(item => (item.to === '/admin/delivery-history'
          ? identity.role === 'admin' && supported.has('/admin/actions')
          : supported.has(item.to) && (item.minRole !== 'admin' || identity.role === 'admin' || (item.to === '/admin/actions' && identity.previewActionsEditor === true)))
          ? <Link key={item.to} className="admin-nav-item" to={item.to} onClick={() => setDrawerOpen(false)}>
              <span className="material-symbols-outlined" aria-hidden="true">{item.icon}</span>{item.label}
            </Link>
          : <span key={item.to} className="admin-nav-item opacity-50" aria-disabled="true">
              <span className="material-symbols-outlined" aria-hidden="true">{item.icon}</span>
              {item.label}<span className="sr-only"> unavailable</span>
            </span>)}
      </section>)}
    </nav>
    <div className="px-3 pb-4 pt-4" style={{ borderTop: '1px solid var(--m3-outline-variant)' }}>
      <a href="/" className="admin-nav-item"><span className="material-symbols-outlined" aria-hidden="true">open_in_new</span>Status page</a>
      <button type="button" className="admin-nav-item" onClick={toggleDark}><span className="material-symbols-outlined" aria-hidden="true">{dark ? 'light_mode' : 'dark_mode'}</span>{dark ? 'Light mode' : 'Dark mode'}</button>
      <button type="button" className="admin-nav-item admin-nav-danger" onClick={signOut}><span className="material-symbols-outlined" aria-hidden="true">logout</span>Sign out</button>
      <p className="px-4 text-sm">{identity.email}</p>
    </div>
  </div>
  return <div className="flex flex-col md:flex-row h-screen" style={{ background: 'var(--m3-surface-container-low)' }}>
    <header className="md:hidden flex items-center justify-between">
      {brand}<button type="button" className="btn-icon" aria-label="Open navigation" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(true)}>☰</button>
    </header>
    {drawerOpen && <ModalShell onClose={() => setDrawerOpen(false)}>
      <div className="fixed inset-0" onClick={() => setDrawerOpen(false)} />
      <div role="dialog" aria-modal="true" aria-label="Navigation" className="fixed inset-y-0 left-0 flex flex-col w-72 max-w-[85vw]" style={{ background: 'var(--m3-surface-container-low)' }}>
        <div className="flex items-center justify-between">{brand}<button type="button" autoFocus className="btn-icon" aria-label="Close navigation" onClick={() => setDrawerOpen(false)}>×</button></div>
        {navigation}
      </div>
    </ModalShell>}
    <aside className="hidden md:flex flex-col h-screen w-64 sticky top-0 flex-shrink-0">{brand}{navigation}</aside>
    <main className="flex-1 min-h-0 min-w-0 overflow-auto"><Outlet /></main>
  </div>
}

function Unavailable() {
  return <p className="p-8">This feature is unavailable.</p>
}

export default function App() {
  const [identity, setIdentity] = useState<Identity | null>(null)
  const previousIdentity = useRef<Identity | null>(null)
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null)
  const [expired, setExpired] = useState(false)
  const [error, setError] = useState('')
  const [generation, setGeneration] = useState(0)
  const reconnectSequence = useRef(0)

  const reconnect = useCallback(async () => {
    const sequence = ++reconnectSequence.current
    try {
      const next = await api.get<Identity>('/auth/me')
      if (sequence !== reconnectSequence.current) return
      if (next.role === 'viewer' && !next.previewActionsEditor) {
        window.location.assign('/')
        return
      }
      const available = await api.get<Capabilities>('/capabilities')
      if (sequence !== reconnectSequence.current) return
      if (previousIdentity.current && next.id !== previousIdentity.current.id) setGeneration(value => value + 1)
      setMutationActor(next.id, next.serverTime)
      setSession({ userId: 0, email: next.email, role: next.role, mustChangePassword: false, twoFactorEnabled: false })
      previousIdentity.current = next
      setIdentity(next)
      setCapabilities(available)
      setExpired(false)
      setError('')
    } catch (err) {
      if (sequence !== reconnectSequence.current) return
      setError(err instanceof Error ? err.message : 'Unable to verify your session')
    }
  }, [])

  useEffect(() => { void reconnect() }, [reconnect])
  useEffect(() => {
    const expire = () => setExpired(true)
    window.addEventListener('access-expired', expire)
    return () => window.removeEventListener('access-expired', expire)
  }, [])

  return <BrowserRouter><ErrorBoundary>
    {identity && capabilities && <CapabilitiesContext.Provider value={capabilities}><ToastProvider key={generation}><div style={{ display: expired ? 'none' : undefined }}>
      <Suspense fallback={<LoadingState />}>
        <Routes>
          <Route path="/admin/*" element={<Shell identity={identity} capabilities={capabilities} />}>
            <Route index element={<Dashboard />} />
            <Route path="monitors" element={capabilities.supportedRoutes.includes("/admin/monitors") ? <Monitors /> : <Unavailable />} />
            <Route path="monitors/:id" element={capabilities.supportedRoutes.includes("/admin/monitors") ? <MonitorDetails /> : <Unavailable />} />
            <Route path="incidents" element={capabilities.supportedRoutes.includes("/admin/incidents") ? <Incidents /> : <Unavailable />} />
            <Route path="maintenance" element={capabilities.supportedRoutes.includes("/admin/maintenance") ? <Maintenance /> : <Unavailable />} />
            <Route path="delivery-history" element={identity.role === 'admin' && capabilities.supportedRoutes.includes('/admin/delivery-history') ? <DeliveryHistory /> : <Unavailable />} />
            <Route path="actions" element={(identity.role === 'admin' || identity.previewActionsEditor === true) && capabilities.supportedRoutes.includes('/admin/actions') ? <Actions readOnly={identity.previewActionsEditor === true} /> : <Unavailable />} />
            <Route path="delivery-history" element={identity.role === 'admin' && capabilities.supportedRoutes.includes('/admin/actions') ? <DeliveryHistory /> : <Unavailable />} />
            <Route path="notifications" element={identity.role === 'admin' && capabilities.supportedRoutes.includes('/admin/notifications') ? <Notifications /> : <Unavailable />} />
            <Route path="vault" element={identity.role === 'admin' && capabilities.supportedRoutes.includes("/admin/vault") ? <Vault /> : <Unavailable />} />
            <Route path="users" element={identity.role === 'admin' && capabilities.supportedRoutes.includes('/admin/users') ? <Users key={identity.id} identityId={identity.id} /> : <Unavailable />} />
            <Route path="audit-log" element={identity.role === 'admin' ? <Audit /> : <Unavailable />} />
            <Route path="backups" element={identity.role === 'admin' && capabilities.supportedRoutes.includes('/admin/backups') ? <Backups /> : <Unavailable />} />
            <Route path="static-fallback" element={identity.role === 'admin' && capabilities.supportedRoutes.includes('/admin/static-fallback') ? <StaticFallback /> : <Unavailable />} />
            <Route path="system-health" element={identity.role === 'admin' && capabilities.supportedRoutes.includes('/admin/system-health') ? <SystemHealth /> : <Unavailable />} />
            <Route path="*" element={<Unavailable />} />
          </Route>
          <Route path="*" element={<Navigate to="/admin/" replace />} />
        </Routes>
      </Suspense>
    </div></ToastProvider></CapabilitiesContext.Provider>}
    {expired && <>
      {/* Shared dialogs are portalled to body, outside the hidden console. Keep their
          forms mounted but hide them while the recovery dialog owns focus. */}
      <style>{'body > [data-testid="modal-backdrop"]:not(:has([data-access-recovery])), body > [role="region"][aria-label="Notifications"] { display: none !important; }'}</style>
      <ModalShell label="Access session expired">
        <div data-access-recovery role="alert" className="p-8" style={{ position: 'fixed', inset: 0, background: 'var(--m3-surface)' }}>
          <p>Your Access session has expired.</p>
          {error && <p>{error}</p>}
          <div className="flex gap-3 mt-4">
            <a href="/" target="_blank" rel="noreferrer" className="btn btn-primary">Sign in</a>
            <button type="button" className="btn btn-secondary" onClick={() => void reconnect()}>Continue</button>
          </div>
        </div>
      </ModalShell>
    </>}
    {!identity && !expired && <div role="alert" className="p-8">
      <p>{error || 'Checking your Access session…'}</p>
      {error && <div className="flex gap-3 mt-4">
        <a href="/" target="_blank" rel="noreferrer" className="btn btn-primary">Sign in</a>
        <button type="button" className="btn btn-secondary" onClick={() => void reconnect()}>Continue</button>
      </div>}
    </div>}
  </ErrorBoundary></BrowserRouter>
}
