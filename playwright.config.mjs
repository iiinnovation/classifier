import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  workers: 1,
  outputDir: process.env.CLASSIFIER_E2E_TRANSPORT === 'electron' ? 'test-results/electron-business' : 'test-results/browser',
  use: {
    browserName: 'chromium',
    ...(process.env.CLASSIFIER_BROWSER_CHANNEL ? { channel: process.env.CLASSIFIER_BROWSER_CHANNEL } : {}),
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
