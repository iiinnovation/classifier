import { test, expect } from '../helpers/desktop-application.mjs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { scannedPdf } from '../helpers/pdf-fixture.mjs'

test('D0 second launch restores the existing window and exits without another backend', async ({ desktop }) => {
  const { application, executable, args, env, snapshot } = desktop
  const before = await snapshot()
  await application.evaluate(({ app, BrowserWindow }) => {
    globalThis.secondLaunchReceived = false
    app.once('second-instance', () => { globalThis.secondLaunchReceived = true })
    BrowserWindow.getAllWindows()[0].minimize()
  })
  const second = spawn(executable, args, { env, stdio: 'ignore' })
  try {
    const exited = new Promise((resolve, reject) => { second.once('exit', code => resolve(code)); second.once('error', reject) })
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows()
      return { received: globalThis.secondLaunchReceived, count: windows.length, minimized: windows[0].isMinimized(), visible: windows[0].isVisible() }
    }), { timeout: 15000 }).toEqual({ received: true, count: 1, minimized: false, visible: true })
    await expect.poll(() => second.exitCode, { timeout: 15000 }).toBe(0)
    expect(await exited).toBe(0)
    const after = await snapshot()
    expect(after.filter(item => /Helper/.test(item.name)).map(item => item.pid).sort()).toEqual(before.filter(item => /Helper/.test(item.name)).map(item => item.pid).sort())
  } finally { if (second.exitCode === null) second.kill() }
})

test('D0 real utility backend rejects direct access and rotates authentication on restart', async ({ desktop }, testInfo) => {
  const result = await desktop.application.evaluate(async ({ app }, profile) => {
    const require = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`)
    const { BackendController } = require(`${app.getAppPath()}/apps/desktop/backend-controller.mjs`)
    const { join } = require('node:path')
    const root = app.isPackaged ? join(process.resourcesPath, 'ocr') : join(app.getAppPath(), 'resources/ocr', `${process.platform}-${process.arch}`)
    const controller = new BackendController({ dataDir: join(profile, 'restart-data'), ocrRoot: root })
    const request = (port, token, origin = 'app://classifier') => fetch(`http://127.0.0.1:${port}/health`, { headers: { origin, ...(token ? { 'x-classifier-instance': token } : {}) } }).then(response => response.status)
    try {
      await controller.start()
      const first = { ...controller.connection }, versions = controller.info.versions
      const initial = [await request(first.port), await request(first.port, first.token, 'https://untrusted.invalid'), await request(first.port, first.token)]
      await controller.stop()
      let oldPortClosed = false
      try { await request(first.port, first.token) } catch { oldPortClosed = true }
      await controller.start()
      const next = controller.connection
      return { initial, oldPortClosed, tokenRotated: first.token !== next.token, restarted: [await request(next.port, first.token), await request(next.port, next.token)], versions }
    } finally { await controller.stop() }
  }, desktop.profile)
  expect(result.initial).toEqual([401, 403, 200])
  expect(result.oldPortClosed).toBe(true)
  expect(result.tokenRotated).toBe(true)
  expect(result.restarted).toEqual([401, 200])
  await writeFile(testInfo.outputPath('backend-authentication.json'), JSON.stringify(result, null, 2) + '\n')
  await testInfo.attach('backend-authentication', { body: JSON.stringify(result, null, 2), contentType: 'application/json' })
})

test('D0 unexpected backend exit is visible and the bridge returns a classified disconnection', async ({ desktop }) => {
  const { application, page } = desktop
  const pid = await application.evaluate(({ app, dialog }) => {
    globalThis.backendExitMessage = null
    dialog.showMessageBox = async (_window, options) => { globalThis.backendExitMessage = options.message; return { response: 0 } }
    return app.getAppMetrics().find(item => item.name === 'Classifier Backend')?.pid
  })
  expect(pid).toBeGreaterThan(0)
  await desktop.snapshot()
  process.kill(pid, 'SIGKILL')
  await expect.poll(() => application.evaluate(() => globalThis.backendExitMessage), { timeout: 15000 }).toContain('本地服务意外退出')
  const response = await page.evaluate(async () => { const response = await fetch('/health'); return { status: response.status, body: await response.json() } })
  expect(response.status).toBe(503)
  expect(response.body.error).toContain('已断开')
})

test('D0 window close cancels active OCR and leaves no application or Tesseract process', async ({ desktop }) => {
  const { application, page, profile } = desktop
  await page.locator('#import-open').click()
  await page.locator('#file').setInputFiles({ name: 'close-during-ocr.pdf', mimeType: 'application/pdf', buffer: scannedPdf(10, 300) })
  await expect.poll(async () => (await desktop.snapshot()).some(item => item.ocrRecognition), { timeout: 30000 }).toBe(true)
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await expect.poll(desktop.remaining, { timeout: 15000 }).toEqual([])
  const files = await readdir(join(profile, 'data/imports'))
  const jobs = await Promise.all(files.filter(file => file.endsWith('.json')).map(file => readFile(join(profile, 'data/imports', file), 'utf8').then(JSON.parse)))
  expect(jobs).toHaveLength(1)
  expect(jobs[0].status).toBe('cancelled')
})

test('D0 forced main process exit leaves no application descendants', async ({ desktop }) => {
  await desktop.page.locator('#import-open').click()
  await desktop.page.locator('#file').setInputFiles({ name: 'force-exit-during-ocr.pdf', mimeType: 'application/pdf', buffer: scannedPdf(10, 300) })
  await expect.poll(async () => (await desktop.snapshot()).some(item => item.ocrRecognition), { timeout: 30000 }).toBe(true)
  desktop.application.process().kill('SIGKILL')
  await expect.poll(desktop.remaining, { timeout: 15000 }).toEqual([])
})

test('D0 shutdown cancels and awaits a synchronous PDF import', async ({ desktop }) => {
  const { application, page, profile } = desktop
  await page.evaluate(bytes => {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), 'synchronous.pdf')
    void fetch('/api/documents', { method: 'POST', body: form }).catch(() => {})
  }, [...scannedPdf(10, 300)])
  await expect.poll(async () => (await desktop.snapshot()).some(item => item.ocrRecognition), { timeout: 30000 }).toBe(true)
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await expect.poll(desktop.remaining, { timeout: 15000 }).toEqual([])
  expect((await readdir(join(profile, 'data/documents'))).filter(file => file.endsWith('.json'))).toEqual([])
})
