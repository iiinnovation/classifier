import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { scannedPdf } from '../helpers/pdf-fixture.mjs'

test('D0 isolated Electron application boots through the authenticated protocol bridge', async ({}, testInfo) => {
  const profile = await mkdtemp(join(tmpdir(), 'classifier-desktop-'))
  let application, completed = false
  const diagnostics = []
  const env = { ...process.env, PATH: process.platform === 'win32' ? join(process.env.SystemRoot, 'System32') : '/usr/bin:/bin' }
  const launch = () => electron.launch({ ...(process.env.CLASSIFIER_PACKAGED_EXECUTABLE ? { executablePath: process.env.CLASSIFIER_PACKAGED_EXECUTABLE } : {}), args: [...(process.env.CLASSIFIER_PACKAGED_EXECUTABLE ? [] : [resolve('.')]), `--user-data-dir=${profile}`], acceptDownloads: true, timeout: 45000, env })
  try {
    application = await launch()
    application.process().stderr.on('data', data => diagnostics.push(data.toString()))
    let page = await application.firstWindow()
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') diagnostics.push(message.text()) })
    await expect(page.locator('#new-topic')).toBeVisible()
    expect(page.url()).toBe('app://classifier/')
    expect(await page.evaluate(() => typeof window.require)).toBe('undefined')
    expect(await page.evaluate(() => typeof window.process)).toBe('undefined')
    expect(await page.evaluate(() => Object.keys(window.classifierDesktop))).toEqual(['sessionId', 'version'])
    expect(await page.evaluate(() => window.open('https://untrusted.invalid'))).toBeNull()
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    const health = await page.evaluate(async () => (await fetch('/health')).json())
    expect(health.status).toBe('ok')
    expect(health.modelConfigured).toBe(false)
    const parser = await page.evaluate(async () => (await fetch('/api/parser-capabilities')).json())
    expect(parser.ocr.available).toBe(true)
    expect(parser.ocr.languages).toEqual(['chi_sim', 'eng'])
    await page.locator('#new-topic').click()
    await page.locator('#topic-name-input').fill('桌面验证')
    await page.locator('#topic-question-input').fill('能否在独立桌面环境中保存研究资料？')
    await page.locator('#topic-form button[type=submit]').click()
    await expect(page.locator('#topic-title')).toHaveText('桌面验证')
    await page.locator('#topic-import').click()
    await page.locator('#file').setInputFiles({ name: 'desktop-scan.pdf', mimeType: 'application/pdf', buffer: scannedPdf() })
    await expect(page.locator('#topic-documents')).toContainText('desktop-scan', { timeout: 30000 })
    await page.locator('#topic-documents').getByRole('button', { name: '打开研读', exact: true }).click()
    await expect(page.locator('#title')).toHaveText('desktop-scan')
    try { await expect(page.locator('#page-image')).toBeVisible() }
    catch (error) {
      const image = await page.evaluate(async () => {
        const element = document.getElementById('page-image')
        const response = await fetch(element.getAttribute('src'))
        const bytes = new Uint8Array(await response.arrayBuffer())
        let decoded
        try { const bitmap = await createImageBitmap(new Blob([bytes], { type: response.headers.get('content-type') })); decoded = { width: bitmap.width, height: bitmap.height }; bitmap.close() }
        catch (error) { decoded = error.message }
        return { status: response.status, type: response.headers.get('content-type'), length: bytes.length, signature: [...bytes.slice(0, 16)], decoded, complete: element.complete, naturalWidth: element.naturalWidth }
      })
      diagnostics.push(JSON.stringify(image)); throw error
    }
    expect(await page.locator('#page-image').evaluate(image => image.naturalWidth)).toBeGreaterThan(0)
    const document = await page.evaluate(async () => {
      const { documents } = await (await fetch('/api/documents')).json()
      return (await fetch(`/api/documents/${documents[0].id}`)).json()
    })
    expect(document.sections[0].extraction).toBe('ocr')
    expect(document.markdown).toMatch(/Classifier research/i)
    expect(document.references.every(item => item.page === 1 && item.bbox?.length === 4)).toBe(true)
    await page.locator('#notes-tab').click()
    await page.locator('#new-note').click()
    await expect(page.locator('#note-content')).toBeFocused()
    await page.locator('#note-details > summary').click()
    await page.locator('#note-field').fill('桌面草稿')
    await page.locator('#note-content').fill('渲染进程崩溃后仍应保留的未保存内容')
    const crashed = page.waitForEvent('crash')
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer())
    await crashed
    await application.close(); application = null
    application = await launch()
    page = await application.firstWindow()
    await expect(page.locator('#resume-note-draft')).toBeVisible()
    await page.locator('#resume-note-draft').click()
    await expect(page.locator('#note-content')).toHaveValue('渲染进程崩溃后仍应保留的未保存内容')
    await expect(page.locator('#note-details-summary')).toContainText('桌面草稿')
    await expect(page.locator('#note-field')).not.toBeVisible()
    await page.locator('#note-content').fill('整个桌面应用退出后仍应保留的未保存内容')
    await page.locator('#close-note').click()
    await page.locator('#reader-back').click()
    await page.screenshot({ path: testInfo.outputPath('desktop-start.png') })
    expect(errors).toEqual([])
    await application.close(); application = null
    const reopened = await launch()
    application = reopened
    const restored = await application.firstWindow()
    await expect(restored.locator('#topic-title')).toHaveText('桌面验证')
    expect(restored.url()).toBe('app://classifier/')
    await restored.locator('#topic-documents').getByRole('button', { name: '打开研读', exact: true }).click()
    await restored.locator('#notes-tab').click()
    await restored.locator('#resume-note-draft').click()
    await expect(restored.locator('#note-content')).toHaveValue('整个桌面应用退出后仍应保留的未保存内容')
    completed = true
  } finally {
    if (!completed) { console.log(diagnostics.join('\n')); await testInfo.attach('desktop-diagnostics', { body: diagnostics.join('\n'), contentType: 'text/plain' }) }
    await application?.close(); await rm(profile, { recursive: true, force: true })
  }
})
