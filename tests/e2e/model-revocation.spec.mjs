import { test } from '../helpers/browser-fixture.mjs'
import { testApp } from '../helpers/test-app.mjs'
import { createSettingsProvider } from '../../apps/api/src/settings.mjs'
import { exerciseModelRevocation } from '../helpers/model-revocation.mjs'

test('D3 model revocation aborts in-flight requests, preserves research and survives page refresh', async ({ page }, testInfo) => {
  const app = await testApp({ settingsProvider: createSettingsProvider() })
  try { await page.goto(app.base); await exerciseModelRevocation(page, testInfo) }
  finally { await app.close() }
})
