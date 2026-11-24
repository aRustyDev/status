import { globSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

// Entry points and static translation tables carry no testable logic.
const COVERAGE_EXCLUDE = ['**/*.test.{ts,tsx}', '**/main.tsx', '**/i18n/defaults.ts', '**/i18n/statusDefaults.ts']

/**
 * Per-file floor for admin pages and components and the public status page. The global thresholds below are an
 * average, so a single untested page could hide behind well-tested ones. Vitest's glob thresholds
 * are also aggregates, and `perFile` would turn the global thresholds per-file for every source,
 * so instead each matching file gets its own threshold entry: a new page or status source with no
 * tests fails the gate on its own.
 */
const PER_FILE_GATED = ['apps/{admin,admin-node}/src/pages/*.tsx', 'apps/{admin,admin-node}/src/components/**/*.tsx', 'apps/{status,status-node}/src/**/*.{ts,tsx}']
const PER_FILE_FLOOR = { lines: 40, statements: 40, functions: 30, branches: 30 }
// These retained upstream-only monitor editors are not imported by the Cloudflare monitor form;
// their Node equivalents remain covered and gated. The notification control is unreachable while
// the Workers capabilities contract reports notifications as unavailable. Global coverage still
// includes these Cloudflare files, and they must leave this list if their capabilities are enabled.
const PER_FILE_EXEMPT = [
  'apps/admin/src/components/monitors/AuthSection.tsx',
  'apps/admin/src/components/monitors/GroupCombobox.tsx',
  'apps/admin/src/components/monitors/HttpAssertionsFields.tsx',
  'apps/admin/src/components/monitors/LatencyAlertSection.tsx',
  'apps/admin/src/components/monitors/MonitorSidePanel.tsx',
  'apps/admin/src/components/monitors/MonitorTypeConfigFields.tsx',
  'apps/admin/src/components/monitors/MonitorTypePicker.tsx',
  'apps/admin/src/components/monitors/ScheduleSection.tsx',
  'apps/admin/src/components/monitors/ServiceFields.tsx',
  'apps/admin/src/components/monitors/TagsSection.tsx',
  'apps/admin/src/components/monitors/TestResultPanel.tsx',
  'apps/admin/src/components/subscribers/NotifySubscribersCheckbox.tsx',
]

const perFileThresholds = Object.fromEntries(
  globSync(PER_FILE_GATED, { cwd: import.meta.dirname, exclude: [...COVERAGE_EXCLUDE, ...PER_FILE_EXEMPT] })
    .map((file) => file.replaceAll('\\', '/'))
    .sort()
    .map((file) => [file, PER_FILE_FLOOR]),
)

export default defineConfig({
  test: {
    environment: 'jsdom',
    // Node 25+ defines its own `localStorage` global (Web Storage), which is undefined unless
    // --localstorage-file is given. Because jsdom's window is the global object in tests, that getter
    // shadows jsdom's working Storage. Turning Node's implementation off in the workers lets jsdom's through.
    execArgv: ['--no-webstorage'],
    include: ['apps/{admin,status,admin-node,status-node}/src/**/*.test.{ts,tsx}'],
    // The interface package is built for bundlers (its imports of folders have no index.js), so Vite transforms it
    // like the app's own sources instead of leaving it to Node.
    server: { deps: { inline: ['@better-forge/ui'] } },
    setupFiles: ['./vitest.setup.ts'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['apps/{admin,admin-node}/src/**/*.{ts,tsx}', 'apps/{status,status-node}/src/**/*.{ts,tsx}'],
      exclude: COVERAGE_EXCLUDE,
      thresholds: {
        lines: 80,
        functions: 75,
        statements: 80,
        branches: 75,
        ...perFileThresholds,
      },
    },
  },
})
