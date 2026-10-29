import { expect } from '@playwright/test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { clickControl } from './ui-actions.mjs'

// Exercise the page's real settings flow against a local controlled provider.
// The provider keeps its first response pending until revocation aborts it.
export async function exerciseModelRevocation(page, testInfo) {
  let sends = 0, closed = 0
  const service = createServer(async (req, res) => {
    for await (const _chunk of req) { /* Drain synthetic request content. */ }
    sends++
    res.once('close', () => { closed++ })
  })
  service.listen(0, '127.0.0.1'); await once(service, 'listening')
  try {
    await page.locator('#model-settings-open').click()
    await page.locator('#model-settings-url').fill(`http://127.0.0.1:${service.address().port}/chat`)
    await page.locator('#model-settings-model').fill('revocation-fixture')
    await page.locator('#model-settings-key').fill('revocation-fixture-secret-only')
    await page.locator('#model-settings-save').click()
    await expect(page.locator('#model-settings-dialog')).not.toBeVisible()
    const documentId = await page.evaluate(async () => {
      const form = new FormData(); form.append('file', new Blob(['撤销测试的本地研究材料，已保存内容仍可读取。']), 'revocation.txt')
      const response = await fetch('/api/documents', { method: 'POST', body: form })
      if (!response.ok) throw new Error(await response.text())
      return (await response.json()).id
    })
    const runId = await page.evaluate(async documentId => {
      const response = await fetch(`/api/documents/${documentId}/questions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: '研究材料' }) })
      if (!response.ok) throw new Error(await response.text())
      return (await response.json()).id
    }, documentId)
    await expect.poll(() => sends).toBe(1)
    await page.locator('#model-settings-open').click()
    await expect(page.locator('#model-settings-key')).toHaveValue('')
    await expect(page.locator('#model-settings-dialog')).toContainText('立即禁止后续发送')
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('model-revocation-narrow.png'), fullPage: true })
    await clickControl(page, '#model-settings-revoke')
    await expect(page.locator('#model-settings-dialog')).not.toBeVisible()
    await expect.poll(() => closed).toBe(1)
    const status = () => page.evaluate(async id => (await (await fetch(`/api/runs/${id}`)).json()).status, runId)
    await expect.poll(status).toBe('cancelled')
    const result = await page.evaluate(async documentId => {
      const health = await (await fetch('/health')).json()
      const document = await (await fetch(`/api/documents/${documentId}`)).json()
      const settings = await (await fetch('/api/settings/text-model')).text()
      return { modelConfigured: health.modelConfigured, title: document.title, text: document.sections[0].text, settings, storage: JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }) }
    }, documentId)
    expect(result.modelConfigured).toBe(false)
    expect(result.text).toContain('已保存内容仍可读取')
    expect(result.settings + result.storage).not.toContain('revocation-fixture-secret-only')
    await page.reload()
    await expect(page.locator('#model-settings-open')).toBeVisible()
    expect(await status()).toBe('cancelled'); expect(sends).toBe(1)
    await writeFile(testInfo.outputPath('model-revocation.json'), JSON.stringify({ sends, upstreamRequestAborted: closed === 1, runCancelled: true, savedOriginalPreserved: true, keyExcludedFromResponseAndBrowserStorage: true, refreshDoesNotRestartTask: true, narrowWindowFits: true }, null, 2) + '\n')
  } finally {
    service.closeAllConnections()
    await new Promise(resolve => service.close(resolve))
  }
}
