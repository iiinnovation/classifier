import { test } from '../helpers/browser-fixture.mjs'
import { testApp } from '../helpers/test-app.mjs'
import { reportExportScenario } from '../helpers/report-export-scenario.mjs'

test('Word export keeps saved writing and sources, works at narrow width and leaves Markdown available', async ({ page }, info) => {
  const app = await testApp()
  try { await page.goto(app.base); await reportExportScenario(page, info) }
  finally { await app.close() }
})
