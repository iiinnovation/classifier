import { defineConfig } from '@playwright/test'
export default defineConfig({ testDir: './tests/desktop', timeout: 90000, workers: 1, outputDir: 'test-results/electron-shell', use: { trace: 'retain-on-failure' } })
