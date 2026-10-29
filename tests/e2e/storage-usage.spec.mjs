import { clickControl, revealControl, moreAction } from '../helpers/ui-actions.mjs'
import { test, expect } from '../helpers/browser-fixture.mjs'
import { testApp } from '../helpers/test-app.mjs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

test('D2 storage usage shows measured categories and retention boundaries, refreshes, and fits a narrow window', async ({ page }, testInfo) => {
  const app = await testApp(), errors = [], writes = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method())) writes.push(request.url()) })
  try {
    await page.goto(app.base); await clickControl(page, '#storage-usage-open')
    const dialog = page.locator('#storage-usage-dialog')
    await expect(dialog).toContainText('本次扫描完成')
    await expect(dialog).toContainText('原文件'); await expect(dialog).toContainText('隔离副本')
    await expect(dialog).toContainText('1 条，其中 0 条归档')
    await expect(dialog).toContainText('归档不释放空间')
    await dialog.getByText('统计口径与数据保留', { exact: true }).click()
    await expect(dialog).toContainText('不等于磁盘实际分配空间或可释放空间')
    await page.screenshot({ path: testInfo.outputPath('storage-usage-desktop.png'), fullPage: true })
    await writeFile(join(app.dataDir, 'originals', 'usage-fixture'), Buffer.alloc(2048))
    await dialog.getByRole('button', { name: '刷新用量' }).click()
    await expect(dialog).toContainText('本次扫描完成')
    await expect(dialog.locator('p').filter({ hasText: /^原文件：/ })).toContainText('2 个文件')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: testInfo.outputPath('storage-usage-narrow.png'), fullPage: true })
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    await dialog.getByRole('button', { name: '关闭', exact: true }).click(); await expect(dialog).not.toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(errors).toEqual([]); expect(writes).toEqual([])
  } finally { await app.close() }
})

test('D2 storage usage handles a failed scan and ignores responses after close', async ({ page }) => {
  const app = await testApp(); let release, attempt = 0
  const pending = new Promise(resolve => { release = resolve })
  try {
    await page.route('**/api/storage-usage', async route => {
      if (++attempt === 1) { await pending; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '旧请求失败' }) }) }
      else await route.continue()
    })
    await page.goto(app.base); await clickControl(page, '#storage-usage-open')
    const dialog = page.locator('#storage-usage-dialog')
    await expect(dialog).toContainText('正在统计')
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await clickControl(page, '#storage-usage-open'); await expect(dialog).toContainText('本次扫描完成')
    const completed = page.waitForResponse(response => response.url().endsWith('/api/storage-usage') && response.status() === 503)
    release(); await completed; await expect(dialog).not.toContainText('旧请求失败')
    await page.unroute('**/api/storage-usage')
    await page.route('**/api/storage-usage', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '暂时无法扫描' }) }))
    await dialog.getByRole('button', { name: '刷新用量' }).click(); await expect(dialog).toContainText('暂时无法扫描')
    await expect(dialog.getByRole('button', { name: '刷新用量' })).toBeEnabled()
    await page.unroute('**/api/storage-usage'); await dialog.getByRole('button', { name: '刷新用量' }).click(); await expect(dialog).toContainText('本次扫描完成')
  } finally { release(); await app.close() }
})
