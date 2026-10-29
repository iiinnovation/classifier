import { test, expect } from '../helpers/desktop-application.mjs'
import { withFullVolume } from '../helpers/full-volume.mjs'
import { join, resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'

test('D1 packaged storage survives actual APFS space exhaustion and retries after space is freed', async ({ desktop }, testInfo) => {
  const result = await withFullVolume(async volume => {
    const parameters = join(volume.root, 'parameters.json')
    await writeFile(parameters, JSON.stringify(volume))
    return desktop.application.evaluate(async ({ app, utilityProcess }, args) => {
      const child = utilityProcess.fork(args.helper, [args.parameters, app.getAppPath()], { stdio: 'pipe', serviceName: 'Classifier Bounded Full Volume Validation' })
      let diagnostics = '', result
      child.stdout?.on('data', () => {}); child.stderr?.on('data', value => { diagnostics += value.toString() })
      await new Promise((resolve, reject) => {
        let timedOut = false
        const timer = setTimeout(() => { timedOut = true; child.kill() }, 180000)
        child.once('message', message => { result = message.result; child.postMessage({ type: 'finish' }) })
        child.once('exit', code => { clearTimeout(timer); code === 0 && result && !timedOut ? resolve() : reject(new Error('Bounded volume validation failed: ' + diagnostics)) })
      })
      return { packaged: app.isPackaged, ...result }
    }, { helper: resolve('tests/helpers/full-volume-child.mjs'), parameters })
  })
  expect(result.packaged).toBe(Boolean(process.env.CLASSIFIER_PACKAGED_EXECUTABLE))
  expect(result.scenarios.map(value => value.name)).toEqual(['json-edit', 'sqlite-edit', 'sqlite-import', 'backup', 'restore', 'zip-backup', 'zip-restore', 'migration', 'quarantine'])
  expect(result.scenarios.every(value => value.passed)).toBe(true)
  await writeFile(testInfo.outputPath('full-volume-validation.json'), JSON.stringify(result, null, 2) + '\n')
})
