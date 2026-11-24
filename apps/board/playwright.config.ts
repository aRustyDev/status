import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  workers: 1,
  use: {
    baseURL: 'http://board.test',
    browserName: 'chromium',
    launchOptions: process.env.BOARD_CHROMIUM_PATH ? { executablePath: process.env.BOARD_CHROMIUM_PATH } : {},
  },
})
