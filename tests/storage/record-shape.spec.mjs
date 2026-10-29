import { test, expect } from '../helpers/desktop-application.mjs'
import { join, resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'

test('D1 packaged records isolate nested damage before lists, task recovery and saved research rendering', async ({ desktop }, testInfo) => {
  const result = await desktop.application.evaluate(async ({ app, utilityProcess }, args) => {
    const child = utilityProcess.fork(args.helper, [args.root, app.getAppPath()], { stdio: 'pipe', serviceName: 'Classifier Record Shape Validation' })
    let diagnostics = '', result
    child.stdout?.on('data', () => {}); child.stderr?.on('data', value => { diagnostics += value.toString() })
    await new Promise((resolve, reject) => {
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill() }, 90000)
      child.once('message', message => { result = message.result; child.postMessage({ type: 'finish' }) })
      child.once('exit', code => { clearTimeout(timer); code === 0 && result && !timedOut ? resolve() : reject(new Error('Record shape validation failed: ' + diagnostics)) })
    })
    return { packaged: app.isPackaged, ...result }
  }, { helper: resolve('tests/helpers/record-shape-child.mjs'), root: join(desktop.profile, 'record-shape-fixtures') })
  expect(result.packaged).toBe(Boolean(process.env.CLASSIFIER_PACKAGED_EXECUTABLE))
  expect(result.results.map(value => value.storage)).toEqual(['json', 'sqlite'])
  for (const storage of result.results) {
    expect(storage.scenarios).toHaveLength(20)
    expect(storage.scenarios.every(value => value.passed)).toBe(true)
    expect(storage.healthyListsAndSnapshotsReadable && storage.damagedTaskBytesUnchanged && storage.originalAndQuarantineBytesPreserved && storage.restartVerified).toBe(true)
  }
  await writeFile(testInfo.outputPath('record-shape-validation.json'), JSON.stringify(result, null, 2) + '\n')
})
