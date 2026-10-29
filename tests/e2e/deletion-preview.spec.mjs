import { clickControl, revealControl, moreAction } from '../helpers/ui-actions.mjs'
import { test, expect } from '../helpers/browser-fixture.mjs'
import { reportFixture } from '../helpers/report-fixture.mjs'
import { json } from '../helpers/test-app.mjs'

test('D2 preview shows shared originals, research history and retained copies without deleting', async ({ page }, testInfo) => {
  const app = await reportFixture(), errors = [], writes = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    let report = await app.value(`/api/topics/${app.topic.id}/reports`, json('POST', { title: 'Preserved report', sources: app.selectors }), 201)
    report = await app.value(`/api/reports/${report.id}/assemble`, json('POST', { revision: report.revision }))
    const other = await app.value('/api/topics', json('POST', { title: 'Shared topic', question: 'Keep the same original' }), 201)
    await app.value(`/api/topics/${other.id}/documents/${app.first.id}`, { method: 'PUT' })
    page.on('request', request => { if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method())) writes.push(request.url()) })
    await page.goto(app.base)
    await page.locator('.topic-card').filter({ hasText: app.topic.title }).click()
    await clickControl(page, '#topic-impact')
    const dialog = page.locator('#deletion-preview-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('共享文献库中的原文件保留')
    await expect(dialog).toContainText('涉及 4 条记录')
    await dialog.getByText('保留的文献（2）', { exact: true }).click()
    await expect(dialog).toContainText(app.first.title)
    await page.screenshot({ path: testInfo.outputPath('topic-impact.png'), fullPage: true })
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    const card = page.locator(`#topic-documents [data-document-id="${app.first.id}"]`)
    await moreAction(card, '删除影响')
    await expect(dialog).toContainText('2 处主题关联')
    await expect(dialog).toContainText('这不等于彻底清除内容')
    await expect(dialog.getByRole('button')).toHaveCount(process.env.CLASSIFIER_TEST_STORAGE === 'sqlite' ? 3 : 2)
    await dialog.getByRole('button', { name: '刷新影响范围' }).click()
    await expect(dialog).toContainText('本次已读取当前影响范围')
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await moreAction(card, '移出影响')
    await expect(dialog).toContainText('涉及 0 条记录及其 0 个历史版本、1 处主题关联、0 篇原文')
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await page.locator('#comparison-list').getByRole('button', { name: '打开比较', exact: true }).click()
    await clickControl(page, '#comparison-impact')
    await expect(dialog).toContainText('保留的相关研究与复制内容（1）')
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await page.locator('#comparison-back').click()
    await page.locator('#report-list').getByRole('button', { name: '打开成果', exact: true }).click()
    await clickControl(page, '#report-impact')
    await expect(dialog).toContainText('原始文献和其他研究中复制的材料保留')
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await page.locator('#report-back').click()
    await card.locator('.document-link').click()
    await page.locator('#notes-tab').click()
    await moreAction(page.locator(`#note-${app.note.id}`), '删除影响')
    await expect(dialog).toContainText('保留的相关研究与复制内容（1）')
    expect(writes).toEqual([]); expect(errors).toEqual([])
    expect((await app.value(`/api/reports/${report.id}`)).revision).toBe(report.revision)
    expect((await app.value(`/api/topics/${app.topic.id}`)).documentCount).toBe(2)
    for (const method of ['POST', 'DELETE']) expect((await app.request(`/api/deletion-preview/documents/${app.first.id}`, { method })).status).toBe(404)
    expect((await app.request(`/api/documents/${app.first.id}`, { method: 'DELETE' })).status).toBe(400)
  } finally { await app.close() }
})

test('D2 closing an in-flight preview prevents its late result from replacing another target', async ({ page }) => {
  const app = await reportFixture()
  let release
  const pending = new Promise(resolve => { release = resolve })
  try {
    await page.route(`**/api/deletion-preview/topics/${app.topic.id}`, async route => { await pending; await route.continue() })
    await page.goto(app.base)
    await page.locator('.topic-card').filter({ hasText: app.topic.title }).click()
    await clickControl(page, '#topic-impact')
    const dialog = page.locator('#deletion-preview-dialog')
    await expect(dialog).toContainText('正在检查')
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await moreAction(page.locator(`#topic-documents [data-document-id="${app.first.id}"]`), '删除影响')
    await expect(dialog.locator('h2')).toContainText(app.first.title)
    const completed = page.waitForResponse(response => response.url().includes(`/api/deletion-preview/topics/${app.topic.id}`))
    release(); await completed
    await expect(dialog.locator('h2')).toContainText(app.first.title)
  } finally { release(); await app.close() }
})
