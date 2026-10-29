import { test, expect } from '../helpers/desktop-application.mjs'
import { diskFaultGroups } from '../helpers/disk-fault-cases.mjs'
import { resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'

for (const [group, scenarios] of Object.entries(diskFaultGroups)) test(`D1 production utility disk faults: ${group}`, async ({ desktop }, testInfo) => {
  const results = await desktop.application.evaluate(async ({ app, utilityProcess }, args) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    const fs = require('node:fs/promises'), { join } = require('node:path')
    const results = []
    for (const scenario of args.scenarios) {
      const root = await fs.mkdtemp(join(args.profile, 'disk-fault-'))
      const child = utilityProcess.fork(args.helper, [root, scenario, app.getAppPath()], { stdio: 'pipe', serviceName: 'Classifier Disk Fault Validation' })
      let diagnostics = '', result
      child.stdout?.on('data', () => {}); child.stderr?.on('data', value => { diagnostics += value.toString() })
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('Disk fault timeout: ' + scenario + ': ' + diagnostics)) }, 30000)
        child.once('message', message => { result = message.result; child.postMessage({ type: 'finish' }) })
        child.once('exit', code => { clearTimeout(timer); code === 0 && result?.passed ? resolve() : reject(new Error('Disk fault failed: ' + scenario + ': ' + diagnostics)) })
      })
      results.push(result)
    }
    return { packaged: app.isPackaged, results }
  }, { profile: desktop.profile, helper: resolve('tests/helpers/disk-fault-child.mjs'), scenarios })
  if (process.env.CLASSIFIER_PACKAGED_EXECUTABLE) expect(results.packaged).toBe(true)
  expect(results.results.map(value => value.scenario)).toEqual(scenarios)
  expect(results.results.every(value => value.passed && value.reached > 0)).toBe(true)
  await writeFile(testInfo.outputPath('disk-failures.json'), JSON.stringify(results, null, 2) + '\n')
})
