import { defineConfig } from '@playwright/test'
export default defineConfig({ testDir: './tests/storage', timeout: 120000, workers: 1, outputDir: 'test-results/storage', use: { trace: 'retain-on-failure' } })
