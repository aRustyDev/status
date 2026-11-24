import type { Locator, Page } from '@playwright/test'
import { ADMIN_URL, API_URL, createHttpMonitor, expect, ok, test, unique } from './fixtures'

interface Tree { children: Array<{ id: string; type: string; children?: Array<{ id: string }> }> }

/** Drags with real mouse moves in small steps, as the grid and dnd-kit only react to movement. */
async function drag(page: Page, from: Locator, to: { x: number; y: number }, onTheWay?: () => Promise<void>) {
  const box = (await from.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 8, box.y + box.height / 2 + 8, { steps: 4 })
  await page.mouse.move(to.x, to.y, { steps: 25 })
  await onTheWay?.()
  await page.mouse.up()
}

test('moves canvas monitors into a group and group monitors back out', async ({ adminPage: page, adminApi }) => {
  const grouped = await createHttpMonitor(adminApi, unique('Grouped'), `${API_URL}/health`)
  const loose = await createHttpMonitor(adminApi, unique('Loose'), `${API_URL}/health`)
  await ok(adminApi.put('admin/layout', {
    data: {
      tree: {
        id: 'root', type: 'page', children: [
          { id: 'g1', type: 'group', label: 'Core', collapsible: false, grid: { x: 0, y: 0, w: 2, h: 3 },
            children: [{ id: 'gm', type: 'monitor', monitorId: grouped.id, showUptimeBar: true }] },
          { id: 'lm', type: 'monitor', monitorId: loose.id, showUptimeBar: true, grid: { x: 0, y: 3, w: 1, h: 1 } },
        ],
      },
    },
  }))
  await page.goto(`${ADMIN_URL}/builder`)
  const group = page.locator('[data-group-id="g1"]')
  await expect(group.getByText(grouped.name)).toBeVisible()

  // Into the group: the group lights up instead of the grid placeholder, and stays where it is.
  const groupBox = (await group.boundingBox())!
  const looseHandle = page.getByRole('button', { name: `Monitor ${loose.name}` }).locator('.drag-handle')
  await drag(page, looseHandle, { x: groupBox.x + groupBox.width / 2, y: groupBox.y + groupBox.height / 2 }, async () => {
    await expect(group.getByText('Drop here')).toBeVisible()
    await expect(page.locator('.react-grid-placeholder')).toBeHidden()
    expect((await group.boundingBox())!.y).toBeCloseTo(groupBox.y, 0)
  })
  await expect(group.getByText(loose.name)).toBeVisible()

  // Out of the group: the grid placeholder shows where it will land.
  const canvas = (await page.locator('[data-group-id="g1"]').locator('xpath=ancestor::div[contains(@class,"react-grid-layout")]').boundingBox())!
  const target = { x: canvas.x + canvas.width * 0.85, y: groupBox.y + 20 }
  await drag(page, group.getByRole('button', { name: `Reorder Monitor ${grouped.name}` }), target, async () => {
    await expect(page.locator('.react-grid-placeholder')).toBeVisible()
  })
  await expect(group.getByText(grouped.name)).toBeHidden()

  // dnd-kit swallows the click that follows a drop; a person never clicks that fast.
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Saved!')).toBeVisible()
  const saved = await ok<Tree>(adminApi.get('admin/layout'))
  const savedGroup = saved.children.find((node) => node.id === 'g1')!
  expect(savedGroup.children!.map((child) => child.id)).toEqual(['lm'])
  expect(saved.children.some((node) => node.id === 'gm')).toBe(true)
})

test('toolbox drops still reach groups and cancelled drags restore canvas controls', async ({ adminPage: page, adminApi }) => {
  const monitor = await createHttpMonitor(adminApi, unique('Toolbox group'), `${API_URL}/health`)
  await ok(adminApi.put('admin/layout', {
    data: { tree: { id: 'root', type: 'page', children: [
      { id: 'g1', type: 'group', label: 'Core', collapsible: false, grid: { x: 0, y: 0, w: 2, h: 3 }, children: [] },
      { id: 'd1', type: 'divider', grid: { x: 0, y: 3, w: 3, h: 1 } },
    ] } },
  }))
  await page.goto(`${ADMIN_URL}/builder`)
  const group = page.locator('[data-group-id="g1"]')
  const source = page.locator('[draggable="true"]').filter({ hasText: monitor.name })
  await expect(group).toBeVisible()
  await expect(source).toBeVisible()
  const box = (await group.boundingBox())!
  await drag(page, source, { x: box.x + box.width / 2, y: box.y + box.height * 0.75 })
  await expect(group.getByText(monitor.name)).toBeVisible()

  const card = page.locator('[data-toolbox-grid-item]').first()
  const toolbox = page.getByRole('button', { name: 'Add Text to the page' })
  const from = (await toolbox.boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2 + 8, { steps: 4 })
  await expect(card).toHaveCSS('pointer-events', 'none')
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect(card).toHaveCSS('pointer-events', 'auto')
})

// Regression for #157: a block dropped between existing ones used to crash the builder (React error #185).
for (const block of ['Divider', 'Incidents', 'Maintenance', 'Text']) {
  test(`a ${block} block dropped between existing blocks keeps the builder working`, async ({ adminPage: page, adminApi }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await ok(adminApi.put('admin/layout', {
      data: {
        tree: {
          id: 'root', type: 'page', children: [
            { id: 'd1', type: 'divider', grid: { x: 0, y: 0, w: 3, h: 1 } },
            { id: 'd2', type: 'divider', grid: { x: 0, y: 1, w: 3, h: 1 } },
            { id: 'd3', type: 'divider', grid: { x: 0, y: 2, w: 3, h: 1 } },
          ],
        },
      },
    }))
    await page.goto(`${ADMIN_URL}/builder`)
    const dividers = page.getByRole('button', { name: 'Divider', exact: true })
    await expect(dividers).toHaveCount(3)
    // RGL initially renders at a provisional width before measuring the canvas.
    await expect.poll(async () => {
      const card = await dividers.nth(1).boundingBox()
      const canvas = await page.locator('.react-grid-layout').boundingBox()
      return card && canvas ? Math.abs(card.width - canvas.width) : Infinity
    }).toBeLessThan(1)

    // The middle of the second divider: the new block lands between the first and the last.
    const second = (await dividers.nth(1).boundingBox())!
    await drag(page, page.getByRole('button', { name: `Add ${block} to the page` }),
      { x: second.x + second.width / 2, y: second.y + 2 })

    await expect(page.locator('.react-grid-placeholder')).toBeHidden()
    await expect(page.locator('.react-grid-item')).toHaveCount(4)
    await expect(page.getByText('Something went wrong')).toBeHidden()
    expect(errors).toEqual([])

    await page.waitForTimeout(300)
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Saved!')).toBeVisible()
    const saved = await ok<Tree>(adminApi.get('admin/layout'))
    expect(saved.children).toHaveLength(4)
    expect(saved.children.filter((node) => ['d1', 'd2', 'd3'].includes(node.id))).toHaveLength(3)
  })
}
