import { test, expect } from '../helpers/desktop-application.mjs'
import { join, resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'

test('D1 candidate rollback build rejects newer formats and restores compatible snapshots without rewriting newer data', async ({ desktop }, testInfo) => {
  const result = await desktop.application.evaluate(async ({ app, utilityProcess }, args) => {
    const child = utilityProcess.fork(args.helper, [args.root, app.getAppPath()], { stdio: 'pipe', serviceName: 'Classifier Rollback Baseline Validation' })
    let diagnostics = '', result
    child.stdout?.on('data', () => {}); child.stderr?.on('data', value => { diagnostics += value.toString() })
    await new Promise((resolve, reject) => {
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill() }, 90000)
      child.once('message', message => { result = message.result; child.postMessage({ type: 'finish' }) })
      child.once('exit', code => { clearTimeout(timer); code === 0 && result && !timedOut ? resolve() : reject(new Error('Rollback validation failed: ' + diagnostics)) })
    })
    return { packaged: app.isPackaged, ...result }
  }, { helper: resolve('tests/helpers/rollback-baseline-child.mjs'), root: join(desktop.profile, 'rollback-fixtures') })
  expect(result.packaged).toBe(Boolean(process.env.CLASSIFIER_PACKAGED_EXECUTABLE))
  expect(result.cases).toHaveLength(6)
  expect(result.cases.every(value => value.passed && value.newerLibraryPreserved && value.refusedBeforeTaskUpdates)).toBe(true)
  await writeFile(testInfo.outputPath('rollback-baseline.json'), JSON.stringify(result, null, 2) + '\n')
})
