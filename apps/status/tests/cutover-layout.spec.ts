import { expect, test } from '@playwright/test'

test('unpositioned status blocks do not overlap after an incident expands', async ({ page }) => {
  const now = Date.now()
  const monitors = [1, 2].map(id => ({ id, name: `Fixture service ${id}`, type: 'https', currentStatus: 'up', lastCheckedAt: null }))
  const incident = {
    id: 3, title: 'Fixture resolved incident', status: 'resolved', impact: 'minor',
    startedAt: now - 7200000, resolvedAt: now - 3600000, monitorIds: [1],
    updates: [{ id: 4, incidentId: 3, status: 'investigating', body: 'Long synthetic timeline update. '.repeat(40), postedAt: now - 7200000 }],
  }
  const maintenance = { id: 5, name: 'Fixture maintenance', description: 'Synthetic window', startsAt: now + 3600000, endsAt: now + 7200000, monitorIds: [2], state: 'upcoming' }
  const layout = { branding: null, tree: { id: 'page', type: 'page', children: [
    ...monitors.map(monitor => ({ id: `monitor-${monitor.id}`, type: 'monitor', monitorId: monitor.id, showUptimeBar: false })),
    { id: 'incidents', type: 'incidents', filter: 'all', limit: 20 },
    { id: 'maintenance', type: 'maintenance', filter: 'all', limit: 20 },
  ] } }
  await page.route('**/api/v1/bsp/**', async route => {
    const path = new URL(route.request().url()).pathname
    let body: unknown
    if (path.endsWith('/auth/me')) body = { id: 'fixture', email: 'fixture@example.test', role: 'viewer' }
    else if (path.endsWith('/capabilities')) body = { subscriptions: false, retentionDays: 14 }
    else if (path.endsWith('/public/status')) body = { branding: null, monitors, activeIncidents: [], activeMaintenanceWindows: [], monitorDependencies: [] }
    else if (path.endsWith('/public/layout')) body = layout
    else if (path.endsWith('/public/incidents')) body = [incident]
    else if (path.endsWith('/public/maintenances')) body = [maintenance]
    else if (path.endsWith('/public/locales')) body = []
    else if (path.includes('/public/locales/')) body = { translations: {} }
    else throw new Error(`Unexpected fixture request: ${path}`)
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Fixture service 1' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Fixture service 2' })).toBeVisible()
  await expect(page.getByText('Fixture maintenance')).toBeVisible()
  const row = page.getByRole('button', { name: /Fixture resolved incident/ })
  await expect(row).toHaveAttribute('aria-expanded', 'false')
  await row.click()
  await expect(row).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByText(/Long synthetic timeline update/)).toBeVisible()
  const bounds = await page.locator('.bsp-layout-grid > .bsp-layout-cell').evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
  }))
  expect(bounds).toHaveLength(4)
  for (let i = 1; i < bounds.length; i++) {
    expect(bounds[i]!.top).toBeGreaterThanOrEqual(bounds[i - 1]!.bottom - 1)
  }
})
