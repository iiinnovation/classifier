import { test } from '../helpers/desktop-application.mjs'
import { reportExportScenario } from '../helpers/report-export-scenario.mjs'

test('real desktop downloads an editable Word report with saved writing and historical source locations', async ({ desktop }, info) => {
  await reportExportScenario(desktop.page, info)
})
