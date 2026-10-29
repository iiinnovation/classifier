import { test } from '../helpers/desktop-application.mjs'
import { exerciseModelRevocation } from '../helpers/model-revocation.mjs'

test('D3 real utility backend revokes model authorization and stops in-flight sends through the settings dialog', async ({ desktop }, testInfo) => {
  await exerciseModelRevocation(desktop.page, testInfo)
})
