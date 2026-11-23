import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

type Role = 'viewer' | 'operator' | 'admin'
type TestPage = { components?: Array<Record<string, unknown>>; checks?: Array<Record<string, unknown>>; incidents?: Array<Record<string, unknown>>; windows?: Array<Record<string, unknown>>; lastComponent?: Record<string, unknown>; lastMaintenance?: Record<string, unknown>; lastCheck?: Record<string, unknown>; holdCreate?: Promise<void>; failNextCreate?: boolean; failRefreshAfterCreate?: boolean; failNextStatus?: boolean; unauthorizedNextStatus?: boolean; unauthorizedNextCreate?: boolean; unauthorizedRefreshAfterCreate?: boolean; lastUpdate?: Record<string, unknown> }

test.beforeEach(async ({ page }) => {
  await page.route('http://board.test/**', async route => {
    const url = new URL(route.request().url())
    const pathname = url.pathname
    if (pathname === '/admin' && (url.searchParams.get('role') || 'viewer') === 'viewer') {
      await route.fulfill({ status: 403, json: { error: 'Insufficient role' } })
      return
    }
    const file = pathname.startsWith('/assets/') ? pathname.slice(1) : 'index.html'
    const contentType = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html'
    await route.fulfill({ body: await readFile(resolve('dist', file)), contentType })
  })
  await page.route('**/api/v1/**', async route => {
    const request = route.request()
    expect(request.headers()['x-requested-with']).toBe('XMLHttpRequest')
    const path = new URL(request.url()).pathname.replace('/api/v1', '')
    const method = request.method()
    const role = (new URL(page.url()).searchParams.get('role') || 'viewer') as Role
    const state = page as unknown as TestPage
    const components = state.components ||= [{ id: 'api', name: 'API', manualStatus: 'operational', status: 'operational', position: 0, version: 1 }]
    const incidents = state.incidents ||= []
    const windows = state.windows ||= []
    if (path === '/public/status' && state.unauthorizedNextStatus) { state.unauthorizedNextStatus = false; await route.fulfill({ status: 401, body: '' }); return }
    if (path === '/public/status' && state.failNextStatus) { state.failNextStatus = false; await route.fulfill({ status: 503, json: { error: 'Status unavailable' } }); return }
    let data: unknown
    if (path === '/auth/me') data = { id: 'user', email: 'engineer@example.com', role, version: 1 }
    else if (path === '/public/status') data = { components, activeIncidents: incidents.filter(item => !item.draft), activeMaintenanceWindows: [] }
    else if (path === '/public/incidents') data = incidents.filter(item => !item.draft)
    else if (path === '/public/maintenances') data = windows
    else if (path === '/admin/components' && method === 'POST') { data = { id: 'new-service' } }
    else if (path === '/admin/components/api' && method === 'PATCH') { state.lastComponent = request.postDataJSON(); await route.fulfill({ status: 409, json: { error: 'Conflict' } }); return }
    else if (path === '/admin/components') data = components
    else if (path === '/admin/users' || path === '/admin/audit') data = []
    else if (path === '/admin/checks' && method === 'GET') data = state.checks || []
    else if (path === '/admin/checks/check' && method === 'PATCH') { state.lastCheck = request.postDataJSON(); await route.fulfill({ status: 409, json: { error: 'Conflict' } }); return }
    else if (path === '/admin/maintenance/window' && method === 'PATCH') { state.lastMaintenance = request.postDataJSON(); await route.fulfill({ status: 409, json: { error: 'Conflict' } }); return }
    else if (path === '/admin/endpoints') data = [{ id: 'target', name: 'Approved target' }]
    else if (path === '/admin/checks' && method === 'POST') data = { id: 'new-check' }
    else if (path === '/admin/incidents' && method === 'GET') data = incidents
    else if (path === '/admin/maintenance' && method === 'GET') data = windows
    else if (path === '/admin/incidents' && method === 'POST') {
      if (state.holdCreate) await state.holdCreate
      if (state.unauthorizedNextCreate) { state.unauthorizedNextCreate = false; await route.fulfill({ status: 401, body: '' }); return }
      if (state.failNextCreate) { state.failNextCreate = false; await route.fulfill({ status: 503, json: { error: 'Could not save draft' } }); return }
      if (state.failRefreshAfterCreate) { state.failRefreshAfterCreate = false; state.failNextStatus = true }
      if (state.unauthorizedRefreshAfterCreate) { state.unauthorizedRefreshAfterCreate = false; state.unauthorizedNextStatus = true }
      const body = request.postDataJSON()
      data = { id: 'incident', ...body, status: 'investigating', draft: true, version: 1, updates: [{ id: 'update', body: body.body, status: 'investigating', postedAt: Date.now() }] }
      incidents.push(data as Record<string, unknown>)
    } else if (path === '/admin/incidents/incident' && method === 'PATCH') {
      const body = request.postDataJSON()
      expect(body.version).toBe(incidents[0]!.version)
      const updates = incidents[0]!.updates as Array<{ body: string }>
      updates[0]!.body = body.body
      incidents[0]!.version = Number(incidents[0]!.version) + 1
      data = { id: 'incident', version: incidents[0]!.version }
    } else if (path === '/admin/incidents/incident/updates' && method === 'POST') {
      const body = request.postDataJSON()
      state.lastUpdate = body
      if (body.version !== incidents[0]!.version) { await route.fulfill({ status: 409, json: { error: 'Conflict' } }); return }
      data = { id: 'incident', version: Number(body.version) + 1 }
    } else if (path === '/admin/incidents/incident/publish' && method === 'POST') {
      expect(request.postDataJSON().version).toBe(incidents[0]!.version)
      incidents[0]!.draft = false
      incidents[0]!.version = Number(incidents[0]!.version) + 1
      data = { id: 'incident', version: incidents[0]!.version }
    } else if (path === '/admin/maintenance' && method === 'POST') {
      data = { id: 'window', ...request.postDataJSON(), state: 'upcoming', version: 1 }
      windows.push(data as Record<string, unknown>)
    } else {
      await route.fulfill({ status: 404, json: { error: `Unexpected ${method} ${path}` } })
      return
    }
    await route.fulfill({ json: data })
  })
})

test('reader sees status and cannot open management', async ({ page }) => {
  await page.goto('/?role=viewer')
  await expect(page.getByRole('heading', { name: 'Engineering status' })).toBeVisible()
  await expect(page.getByText('API', { exact: true })).toBeVisible()
  await expect(page.getByText('operational', { exact: true })).toBeVisible()
  await expect(page.getByText('No active incidents.')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Manage' })).toHaveCount(0)
  const response = await page.goto('/admin?role=viewer')
  expect(response?.status()).toBe(403)
  await expect(page.getByText('Insufficient role')).toBeVisible()
})

test('operator drafts and publishes an incident', async ({ page }) => {
  await page.goto('/admin?role=operator')
  await expect(page.getByRole('heading', { name: 'Manage status' })).toBeVisible()
  await page.getByText('New incident', { exact: true }).click()
  const form = page.locator('details').filter({ hasText: 'New incident' })
  await form.getByLabel('Title').fill('API latency')
  await form.getByLabel('Opening update').fill('Investigating slow requests')
  await form.getByRole('checkbox', { name: 'API' }).check()
  await form.getByRole('button', { name: 'Create draft' }).click()
  await expect(page.getByText('Draft created.')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'API latency' })).toBeVisible()
  await expect(page.getByText('draft', { exact: true })).toBeVisible()
  await page.getByText('Edit incident', { exact: true }).click()
  const editForm = page.locator('details').filter({ hasText: 'Edit incident' })
  await editForm.getByLabel('Opening update').fill('Investigating elevated latency')
  await editForm.getByRole('button', { name: 'Save incident' }).click()
  await expect(page.getByText('Incident updated.')).toBeVisible()
  await expect(page.getByRole('paragraph').filter({ hasText: 'Investigating elevated latency' })).toBeVisible()
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await expect(page.getByText('Incident published.')).toBeVisible()
  await expect(page.getByText('draft', { exact: true })).toHaveCount(0)
  await page.goto('/?role=operator')
  await expect(page.getByRole('heading', { name: 'API latency' })).toBeVisible()
  await expect(page.getByText('Investigating elevated latency')).toBeVisible()
})

test('operator schedules planned maintenance for a service', async ({ page }) => {
  await page.goto('/admin?role=operator')
  const section = page.getByRole('heading', { name: 'Maintenance', exact: true }).locator('..')
  await section.getByLabel('Title').fill('Database upgrade')
  await section.getByLabel('Description').fill('Brief interruption expected')
  await section.getByLabel('Starts').fill('2030-06-01T12:00')
  await section.getByLabel('Ends').fill('2030-06-01T13:00')
  await section.getByRole('checkbox', { name: 'API' }).check()
  await section.getByRole('button', { name: 'Schedule maintenance' }).click()
  await expect(page.getByText('Maintenance scheduled.')).toBeVisible()
  await page.goto('/?role=operator')
  await expect(page.getByRole('heading', { name: 'Database upgrade' })).toBeVisible()
  await expect(page.getByText('Brief interruption expected')).toBeVisible()
})

test('an Access 401 offers sign-in in a separate tab without losing an unsaved draft', async ({ page }) => {
  const state = page as unknown as TestPage
  await page.goto('/admin?role=operator')
  await page.getByText('New incident', { exact: true }).click()
  const form = page.locator('details').filter({ hasText: 'New incident' })
  await form.getByLabel('Title').fill('Keep this draft')
  await form.getByLabel('Opening update').fill('Do not lose this update')

  state.unauthorizedNextStatus = true
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('Your Access session may have expired')
  const signIn = alert.getByRole('link', { name: 'Sign in in a new tab' })
  await expect(signIn).toHaveAttribute('href', '/')
  await expect(signIn).toHaveAttribute('target', '_blank')
  await expect(form.getByLabel('Title')).toHaveValue('Keep this draft')
  await expect(form.getByLabel('Opening update')).toHaveValue('Do not lose this update')

  await alert.getByRole('button', { name: 'Retry' }).click()
  await expect(alert).toHaveCount(0)
  await expect(form.getByLabel('Title')).toHaveValue('Keep this draft')
  state.unauthorizedNextCreate = true
  await form.getByRole('button', { name: 'Create draft' }).click()
  await expect(page.getByRole('alert')).toContainText('Your Access session may have expired')
  await expect(form.getByLabel('Title')).toHaveValue('Keep this draft')
  await expect(form.getByLabel('Opening update')).toHaveValue('Do not lose this update')

  state.unauthorizedRefreshAfterCreate = true
  await form.getByRole('button', { name: 'Create draft' }).click()
  await expect(page.getByRole('alert')).toContainText('Saved. Your Access session may have expired')
  await expect(form.getByLabel('Title')).toHaveValue('')
  expect(state.incidents).toHaveLength(1)
})

test('an Access 401 on initial load offers sign-in without showing an endless loading state', async ({ page }) => {
  const state = page as unknown as TestPage
  state.unauthorizedNextStatus = true
  await page.goto('/?role=viewer')
  await expect(page.getByRole('alert')).toContainText('Your Access session may have expired')
  await expect(page.getByRole('link', { name: 'Sign in in a new tab' })).toHaveAttribute('href', '/')
  await expect(page.getByText('Loading status…')).toHaveCount(0)
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByRole('heading', { name: 'Engineering status' })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('a concurrent incident change preserves the unsaved update and sends the original version', async ({ page }) => {
  const state = page as unknown as TestPage
  state.incidents = [{ id: 'incident', title: 'API latency', status: 'investigating', impact: 'minor', draft: false, componentIds: ['api'], version: 1, updates: [{ id: 'update', body: 'Investigating', status: 'investigating', postedAt: Date.now() }] }]
  await page.goto('/admin?role=operator')
  await page.getByRole('heading', { name: 'API latency' }).waitFor()
  await page.locator('summary').filter({ hasText: 'Post update' }).click()
  const update = page.locator('details').filter({ hasText: 'Post update' }).locator('textarea')
  await update.fill('Keep this unsaved update')
  state.incidents[0]!.version = 2
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByText('This item changed while you were editing.', { exact: false })).toBeVisible()
  await expect(update).toHaveValue('Keep this unsaved update')
  await page.getByRole('button', { name: 'Post update', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('This item changed. Refresh and try again.')
  expect(state.lastUpdate?.version).toBe(1)
  await expect(update).toHaveValue('Keep this unsaved update')
  await page.getByRole('button', { name: 'Discard draft and use latest' }).click()
  await expect(update).toHaveValue('')
})

test('incident creation preserves a failed draft and clears it after a successful write even if refresh fails', async ({ page }) => {
  const state = page as unknown as TestPage
  state.failNextCreate = true
  await page.goto('/admin?role=operator')
  await page.getByText('New incident', { exact: true }).click()
  const form = page.locator('details').filter({ hasText: 'New incident' })
  await form.getByLabel('Title').fill('Draft to retain')
  await form.getByLabel('Opening update').fill('Work in progress')
  await form.getByLabel('Impact').selectOption('critical')
  await form.getByRole('checkbox', { name: 'API' }).check()
  await form.getByRole('button', { name: 'Create draft' }).click()
  await expect(page.getByRole('alert')).toContainText('Could not save draft')
  await expect(form.getByLabel('Title')).toHaveValue('Draft to retain')
  await expect(form.getByLabel('Opening update')).toHaveValue('Work in progress')
  await expect(form.getByRole('checkbox', { name: 'API' })).toBeChecked()
  state.failRefreshAfterCreate = true
  await form.getByRole('button', { name: 'Create draft' }).click()
  await expect(page.getByRole('alert')).toContainText('Saved, but the board could not refresh')
  await expect(form.getByLabel('Title')).toHaveValue('')
  await expect(form.getByLabel('Opening update')).toHaveValue('')
  await expect(form.getByLabel('Impact')).toHaveValue('minor')
  await expect(form.getByRole('checkbox', { name: 'API' })).not.toBeChecked()
  expect(state.incidents).toHaveLength(1)
})

test('successful service, check and maintenance creation clear their forms', async ({ page }) => {
  await page.goto('/admin?role=admin')
  const service = page.getByLabel('Service name')
  await service.fill('New service')
  await page.getByRole('button', { name: 'Add service' }).click()
  await expect(page.getByText('Service added.')).toBeVisible()
  await expect(service).toHaveValue('')
  const maintenance = page.getByRole('heading', { name: 'Maintenance', exact: true }).locator('..')
  await maintenance.getByLabel('Title').fill('A window')
  await maintenance.getByLabel('Description').fill('Work')
  await maintenance.getByLabel('Starts').fill('2030-06-01T12:00')
  await maintenance.getByLabel('Ends').fill('2030-06-01T13:00')
  await maintenance.getByRole('checkbox', { name: 'API' }).check()
  await maintenance.getByRole('button', { name: 'Schedule maintenance' }).click()
  await expect(page.getByText('Maintenance scheduled.')).toBeVisible()
  await expect(maintenance.getByLabel('Title').first()).toHaveValue('')
  await expect(maintenance.getByLabel('Description').first()).toHaveValue('')
  await expect(maintenance.getByLabel('Starts').first()).toHaveValue('')
  await expect(maintenance.getByRole('checkbox', { name: 'API' }).first()).not.toBeChecked()
  const check = page.getByRole('heading', { name: 'Add HTTP check' }).locator('..')
  await check.getByRole('combobox', { name: 'Service', exact: true }).selectOption('api')
  await check.getByRole('combobox', { name: 'Approved endpoint' }).selectOption('target')
  await check.getByLabel('Expected HTTP status').fill('204')
  await check.getByRole('button', { name: 'Add check' }).click()
  await expect(page.getByText('HTTP check added.')).toBeVisible()
  await expect(check.getByRole('combobox', { name: 'Service', exact: true })).toHaveValue('')
  await expect(check.getByRole('combobox', { name: 'Approved endpoint' })).toHaveValue('')
  await expect(check.getByLabel('Expected HTTP status')).toHaveValue('200')
})

test('saving incident details does not erase a separately drafted timeline update', async ({ page }) => {
  const state = page as unknown as TestPage
  state.incidents = [{ id: 'incident', title: 'API latency', status: 'investigating', impact: 'minor', draft: false, componentIds: ['api'], version: 1, updates: [{ id: 'update', body: 'Investigating', status: 'investigating', postedAt: Date.now() }] }]
  await page.goto('/admin?role=operator')
  await page.getByRole('heading', { name: 'API latency' }).waitFor()
  const post = page.locator('details').filter({ hasText: 'Post update' })
  await post.locator('summary').click()
  await post.locator('textarea').fill('A separate draft update')
  const edit = page.locator('details').filter({ hasText: 'Edit incident' })
  await edit.locator('summary').click()
  await edit.getByLabel('Title').fill('API latency updated')
  await edit.getByRole('button', { name: 'Save incident' }).click()
  await expect(page.getByText('Incident updated.')).toBeVisible()
  await expect(post.locator('textarea')).toHaveValue('A separate draft update')
  await expect(post.getByText('This item changed while you were editing.', { exact: false })).toBeVisible()
  await post.getByRole('button', { name: 'Post update', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('This item changed. Refresh and try again.')
  expect(state.lastUpdate?.version).toBe(1)
  await expect(post.locator('textarea')).toHaveValue('A separate draft update')
})

test('component, maintenance and check drafts retain their original versions after refresh', async ({ page }) => {
  const state = page as unknown as TestPage
  state.components = [{ id: 'api', name: 'API', manualStatus: 'operational', status: 'operational', position: 0, version: 1 }]
  state.windows = [{ id: 'window', name: 'Work', description: 'Original', startsAt: Date.parse('2030-06-01T12:00:00Z'), endsAt: Date.parse('2030-06-01T13:00:00Z'), componentIds: ['api'], state: 'upcoming', version: 1 }]
  state.checks = [{ id: 'check', componentId: 'api', endpointId: 'target', enabled: true, intervalMinutes: 1, expectedStatus: 200, version: 1 }]
  await page.goto('/admin?role=admin')
  const service = page.getByRole('heading', { name: 'Services', exact: true }).locator('..')
  await service.getByLabel('Name', { exact: true }).fill('Locally edited')
  state.components[0]!.version = 2
  state.components[0]!.name = 'Edited elsewhere'
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(service.getByText('This item changed while you were editing.', { exact: false })).toBeVisible()
  await expect(service.getByLabel('Name', { exact: true })).toHaveValue('Locally edited')
  await service.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('This item changed')
  expect(state.lastComponent?.version).toBe(1)
  await service.getByRole('button', { name: 'Discard draft and use latest' }).click()
  await expect(service.getByLabel('Name', { exact: true })).toHaveValue('Edited elsewhere')
  const maintenance = page.locator('details').filter({ hasText: 'Edit maintenance' })
  await maintenance.locator('summary').click()
  await maintenance.getByLabel('Description').fill('Local maintenance notes')
  state.windows[0]!.version = 2
  state.windows[0]!.description = 'Notes from another operator'
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByText('This item changed while you were editing.', { exact: false })).toBeVisible()
  await expect(maintenance.getByLabel('Description')).toHaveValue('Local maintenance notes')
  await maintenance.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('alert')).toContainText('This item changed')
  expect(state.lastMaintenance?.version).toBe(1)
  await page.getByRole('button', { name: 'Discard draft and use latest' }).click()
  await expect(maintenance.getByLabel('Description')).toHaveValue('Notes from another operator')
  const check = page.getByRole('heading', { name: 'Edit check' }).locator('..')
  await check.getByLabel('Expected HTTP status').fill('204')
  state.checks[0]!.version = 2
  state.checks[0]!.expectedStatus = 201
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByText('This item changed while you were editing.', { exact: false })).toBeVisible()
  await expect(check.getByLabel('Expected HTTP status')).toHaveValue('204')
  await check.getByRole('button', { name: 'Save check' }).click()
  await expect(page.getByRole('alert')).toContainText('This item changed')
  expect(state.lastCheck?.version).toBe(1)
  await page.getByRole('button', { name: 'Discard draft and use latest' }).click()
  await expect(check.getByLabel('Expected HTTP status')).toHaveValue('201')
})

test('a create form cannot be edited while its save is in flight', async ({ page }) => {
  const state = page as unknown as TestPage
  let release!: () => void
  state.holdCreate = new Promise<void>(resolve => { release = resolve })
  await page.goto('/admin?role=operator')
  await page.getByText('New incident', { exact: true }).click()
  const form = page.locator('details').filter({ hasText: 'New incident' })
  await form.getByLabel('Title').fill('Pending draft')
  await form.getByLabel('Opening update').fill('Pending update')
  await form.getByRole('button', { name: 'Create draft' }).click()
  await expect(form.getByLabel('Title')).toBeDisabled()
  await expect(form.getByLabel('Opening update')).toBeDisabled()
  release()
  await expect(page.getByText('Draft created.')).toBeVisible()
  await expect(form.getByLabel('Title')).toHaveValue('')
})
