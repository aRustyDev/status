// Exercise the actual production bundles served by the Node container, not just their HTML shells.
import { chromium, expect } from '@playwright/test'

const baseURL = process.env['NODE_SMOKE_URL'] ?? 'http://127.0.0.1:3000'
const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext({ baseURL })
  const page = await context.newPage()
  await page.goto('/admin/login')
  await expect(page).toHaveURL(/\/admin\/setup$/)
  await expect(page.getByRole('heading', { name: 'Choose a database' })).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Create admin account' })).toBeVisible()
  await page.getByPlaceholder('admin@example.com').fill('docker-smoke@example.test')
  await page.getByPlaceholder('Min. 8 characters').fill('docker-smoke-password')
  await page.getByPlaceholder('Repeat password').fill('docker-smoke-password')
  await page.getByRole('button', { name: 'Create Account' }).click()
  await expect(page.getByRole('heading', { name: "You're all set." })).toBeVisible()
  await page.getByRole('button', { name: 'Go to Dashboard' }).click()
  await expect(page).toHaveURL(/\/admin\/?$/)
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await page.goto('/')
  await expect(page.getByText('My Status Page').first()).toBeVisible()
  await context.close()
  const signedOut = await browser.newPage({ baseURL })
  await signedOut.goto('/admin/login')
  await signedOut.locator('input[type="email"]').fill('docker-smoke@example.test')
  await signedOut.locator('input[type="password"]').fill('docker-smoke-password')
  await signedOut.locator('button[type="submit"]').click()
  await expect(signedOut).toHaveURL(/\/admin\/?$/)
  await expect(signedOut.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await signedOut.close()
  console.log('Node production setup, login, dashboard, and reader passed')
} finally {
  await browser.close()
}
