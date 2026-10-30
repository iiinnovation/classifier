import { test, expect } from '../helpers/desktop-application.mjs'
import { _electron as electron } from '@playwright/test'
import { clickControl } from '../helpers/ui-actions.mjs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

async function fill(page, url, key = 'desktop-vault-fixture-secret') {
  await page.locator('#model-settings-open').click()
  await page.locator('#model-settings-url').fill(url)
  await page.locator('#model-settings-model').fill('settings-fixture')
  await page.locator('#model-settings-key').fill(key)
}
const settings = page => page.evaluate(async () => (await (await fetch('/api/settings/text-model')).json()))
const secret = 'desktop-vault-fixture-secret'

test('Mac desktop remembers an OS-protected connection across complete exits and tests only fixed text', async ({ desktop }, info) => {
  test.skip(process.platform !== 'darwin', 'Current delivery scope is macOS.')
  const calls = [], service = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    calls.push({ authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) })
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))
  })
  service.listen(0, '127.0.0.1'); await once(service, 'listening')
  let application = desktop.application, page = desktop.page, extraApplication
  const url = `http://127.0.0.1:${service.address().port}/v1/chat/completions`
  async function reopen() {
    await application.close()
    extraApplication = await electron.launch({ executablePath: desktop.executable, args: desktop.args, env: desktop.env, acceptDownloads: true, timeout: 45000 })
    application = extraApplication; page = await application.firstWindow()
    await expect(page.locator('#new-topic')).toBeVisible()
  }
  try {
    await fill(page, url)
    await expect(page.locator('#model-settings-remember')).not.toBeChecked()
    await page.locator('#model-settings-test').click()
    await expect(page.locator('#model-settings-status')).toContainText('测试通过')
    expect((await settings(page)).hasKey).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0].body.messages).toHaveLength(1)
    expect(calls[0].body.messages[0].content).toContain('synthetic connection test')
    await page.locator('#model-settings-save').click()
    await expect(page.locator('#model-settings-dialog')).not.toBeVisible()
    expect((await settings(page)).persistence).toBe('session')
    await reopen()
    expect((await settings(page)).hasKey).toBe(false); expect(calls).toHaveLength(1)
    await fill(page, url)
    await expect(page.locator('#model-settings-remember-field')).toBeVisible()
    await page.locator('#model-settings-remember').check()
    await page.locator('#model-settings-test').click()
    await expect(page.locator('#model-settings-status')).toContainText('测试通过')
    await page.locator('#model-settings-save').click()
    await expect(page.locator('#model-settings-dialog')).not.toBeVisible()
    const stored = await readFile(join(desktop.profile, 'model-settings.json'), 'utf8')
    expect(stored).not.toContain(secret); expect(JSON.parse(stored).text.encryptedKey).toBeTruthy()
    await reopen()
    const restored = await settings(page)
    expect(restored.hasKey).toBe(true); expect(restored.persistence).toBe('remembered')
    expect(restored.credentialProtection).toBe('macos-keychain')
    expect(restored.connectionTest.state).toBe('untested'); expect(calls).toHaveLength(2)
    await page.locator('#model-settings-open').click()
    await expect(page.locator('#model-settings-key')).toHaveValue('')
    await expect(page.locator('#model-settings-remember')).toBeChecked()
    await page.locator('#model-settings-test').click()
    await expect(page.locator('#model-settings-status')).toContainText('测试通过')
    expect(calls.at(-1).authorization).toBe('Bearer ' + secret)
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(secret)
    for (const bucket of ['runs', 'imports', 'notes', 'reports']) expect(await readdir(join(desktop.profile, 'data', bucket))).toEqual([])
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.locator('#model-settings-dialog').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath('protected-connection-narrow.png'), fullPage: true })
    await clickControl(page, '#model-settings-revoke')
    await expect(page.locator('#model-settings-dialog')).not.toBeVisible()
    await reopen()
    expect((await settings(page)).hasKey).toBe(false); expect(calls).toHaveLength(3)
    await expect(page.locator('#model-settings-open')).toHaveText('模型连接')
    await writeFile(info.outputPath('protected-connection.json'), JSON.stringify({ osProtection: restored.credentialProtection, sessionForgottenOnExit: true, rememberedConnectionRestored: true, noAutomaticModelCallsOnStartup: true, keyExcludedFromProfilePlaintextAndBrowserStorage: true, revocationSurvivedExit: true, requests: calls.length }, null, 2))
  } finally { await extraApplication?.close().catch(() => {}); service.closeAllConnections(); await new Promise(resolve => service.close(resolve)) }
})

test('connection test cancellation and authentication errors preserve current settings without exposing upstream errors', async ({ desktop }) => {
  let mode = 'hang', calls = 0, closed = 0
  const service = createServer(async (req, res) => {
    for await (const _chunk of req) {}
    calls++; res.once('close', () => closed++)
    if (mode === 'fail') { res.writeHead(401); res.end('do-not-echo-' + secret) }
    if (mode === 'success') { res.writeHead(200); res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })) }
  })
  service.listen(0, '127.0.0.1'); await once(service, 'listening')
  const { page } = desktop
  try {
    await fill(page, `http://127.0.0.1:${service.address().port}/chat`)
    await page.locator('#model-settings-test').click()
    await expect.poll(() => calls).toBe(1)
    await page.locator('#model-settings-test-stop').click()
    await expect(page.locator('#model-settings-status')).toContainText('测试已停止')
    await expect.poll(() => closed).toBe(1)
    mode = 'fail'
    await page.locator('#model-settings-test').click()
    await expect(page.locator('#model-settings-error')).toContainText('拒绝认证')
    await expect(page.locator('#model-settings-error')).not.toContainText(secret)
    expect((await settings(page)).hasKey).toBe(false)
    mode = 'success'
    await page.locator('#model-settings-test').click()
    await expect(page.locator('#model-settings-status')).toContainText('测试通过')
    await page.locator('#model-settings-model').fill('changed-after-test')
    await expect(page.locator('#model-settings-status')).toContainText('设置尚未保存')
    await page.locator('#model-settings-save').click()
    await expect(page.locator('#model-settings-dialog')).not.toBeVisible()
    expect((await settings(page)).connectionTest.state).toBe('untested')
  } finally { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)) }
})

test('revoking during a protected save aborts active research and prevents the slow save from re-enabling its connection', async ({ desktop }) => {
  test.skip(process.platform !== 'darwin', 'Current delivery scope is macOS.')
  let sends = 0, closed = 0
  const service = createServer(async (req, res) => { for await (const _chunk of req) {}; sends++; res.once('close', () => closed++) })
  service.listen(0, '127.0.0.1'); await once(service, 'listening')
  const { application, page } = desktop
  try {
    await fill(page, `http://127.0.0.1:${service.address().port}/chat`)
    await page.locator('#model-settings-save').click()
    await expect(page.locator('#model-settings-dialog')).not.toBeVisible()
    const runId = await page.evaluate(async () => {
      const body = new FormData(); body.append('file', new Blob(['保存期间撤销授权的合成研究材料。']), 'settings-revoke.txt')
      const document = await (await fetch('/api/documents', { method: 'POST', body })).json()
      return (await (await fetch(`/api/documents/${document.id}/questions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: '研究材料' }) })).json()).id
    })
    await expect.poll(() => sends).toBe(1)
    await application.evaluate(({ safeStorage }) => {
      globalThis.modelSaveGate = Promise.withResolvers(); globalThis.modelSaveEntered = false
      globalThis.originalModelEncrypt = safeStorage.encryptStringAsync
      safeStorage.encryptStringAsync = async key => { globalThis.modelSaveEntered = true; await globalThis.modelSaveGate.promise; return globalThis.originalModelEncrypt.call(safeStorage, key) }
    })
    await page.locator('#model-settings-open').click()
    await page.locator('#model-settings-key').fill('slow-save-new-secret')
    await page.locator('#model-settings-remember').check()
    await page.locator('#model-settings-save').click()
    await expect.poll(() => application.evaluate(() => globalThis.modelSaveEntered)).toBe(true)
    await expect(page.locator('#model-settings-revoke')).toBeEnabled()
    await clickControl(page, '#model-settings-revoke')
    await expect.poll(() => page.evaluate(async () => (await (await fetch('/health')).json()).modelConfigured)).toBe(false)
    await expect.poll(() => closed).toBe(1)
    await application.evaluate(() => globalThis.modelSaveGate.resolve())
    await expect(page.locator('#model-settings-dialog')).not.toBeVisible()
    expect((await settings(page)).hasKey).toBe(false)
    await expect.poll(() => page.evaluate(async id => (await (await fetch(`/api/runs/${id}`)).json()).status, runId)).toBe('cancelled')
    expect(await readdir(desktop.profile)).not.toContain('model-settings.json')
    expect(sends).toBe(1)
  } finally {
    await application.evaluate(({ safeStorage }) => { globalThis.modelSaveGate?.resolve(); if (globalThis.originalModelEncrypt) safeStorage.encryptStringAsync = globalThis.originalModelEncrypt }).catch(() => {})
    service.closeAllConnections(); await new Promise(resolve => service.close(resolve))
  }
})
