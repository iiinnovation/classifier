import { defineConfig } from '@playwright/test'
export default defineConfig({ testDir: './tests/volume', timeout: 240000, workers: 1, outputDir: 'test-results/full-volume', use: { trace: 'retain-on-failure' } })
