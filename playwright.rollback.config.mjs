import { defineConfig } from '@playwright/test'
export default defineConfig({ testDir: './tests/rollback', timeout: 120000, workers: 1, outputDir: 'test-results/rollback-baseline', use: { trace: 'retain-on-failure' } })
