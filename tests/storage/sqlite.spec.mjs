import { test, expect } from '../helpers/desktop-application.mjs'
import { resolve, join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { storageScenarios } from '../helpers/storage-scenarios.mjs'

test('S0 packaged utility runtime validates SQLite transactions and file recovery', async ({ desktop }, testInfo) => {
  const helper = resolve('tests/helpers/storage-probe.mjs')
  async function run(root, action, { checkpoint = '', hold = false } = {}) {
    return desktop.application.evaluate(async ({ utilityProcess }, args) => {
      const { helper, root, action, checkpoint, hold } = args
      const child = utilityProcess.fork(helper, [root, action, checkpoint], { stdio: 'pipe', serviceName: 'Classifier S0 Probe' })
      globalThis.s0Children ||= new Map()
      const handle = crypto.randomUUID()
      globalThis.s0Children.set(handle, child)
      return new Promise((resolve, reject) => {
        let response, diagnostics = ''
        const timer = setTimeout(() => { child.kill(); reject(new Error('S0 utility probe timed out: ' + action + ' ' + diagnostics)) }, 15000)
        child.stdout?.on('data', () => {})
        child.stderr?.on('data', data => { diagnostics += data })
        child.on('message', message => {
          if (message.type === 'checkpoint') {
            response = { checkpoint: message.stage, killed: !hold, handle }
            if (hold) { clearTimeout(timer); resolve(response) } else process.kill(child.pid, 'SIGKILL')
          } else { response = message; child.postMessage({ type: 'finish' }) }
        })
        child.once('exit', code => {
          clearTimeout(timer); globalThis.s0Children.delete(handle)
          if (response?.type === 'error') reject(new Error(response.message))
          else if (response?.killed) resolve(response)
          else if (code === 0 && response?.type === 'result') resolve(response)
          else reject(new Error('S0 utility exited unexpectedly: ' + code + ' ' + diagnostics))
        })
      })
    }, { helper, root, action, checkpoint, hold })
  }
  async function stop(handle) {
    await desktop.application.evaluate(async (_, handle) => {
      const child = globalThis.s0Children.get(handle)
      if (child) await new Promise(resolve => { child.once('exit', resolve); process.kill(child.pid, 'SIGKILL') })
    }, handle)
  }
  try {
    const report = await storageScenarios(join(desktop.profile, 's0'), run, stop)
    expect(report.runtime.electron).toBeTruthy()
    const packaged = await desktop.application.evaluate(({ app }) => app.isPackaged)
    if (process.env.CLASSIFIER_PACKAGED_EXECUTABLE) expect(packaged).toBe(true)
    report.packaged = packaged
    report.testHelperExternalToPackage = true
    report.timestamp = new Date().toISOString()
    await writeFile(testInfo.outputPath('storage-validation.json'), JSON.stringify(report, null, 2) + '\n')
    await testInfo.attach('storage-validation', { body: JSON.stringify(report, null, 2), contentType: 'application/json' })
  } finally {
    await desktop.application.evaluate(async () => {
      await Promise.all([...(globalThis.s0Children?.values() || [])].map(child => new Promise(resolve => { child.once('exit', resolve); child.kill() })))
    })
  }
})
