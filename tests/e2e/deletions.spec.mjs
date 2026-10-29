import { clickControl, revealControl, moreAction } from '../helpers/ui-actions.mjs'
import { test, expect } from '../helpers/browser-fixture.mjs'
import { reportFixture } from '../helpers/report-fixture.mjs'
import { json } from '../helpers/test-app.mjs'

test('D2 document deletion requires current scope confirmation and keeps report text, deleted-source labels and export', async ({ page }, testInfo) => {
  const app = await reportFixture(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    let report = await app.value(`/api/topics/${app.topic.id}/reports`, json('POST', { title: '删除后保留成果', sources: app.selectors }), 201)
    report = await app.value(`/api/reports/${report.id}/assemble`, json('POST', { revision: report.revision }))
    await page.goto(app.base)
    await page.locator('.topic-card').filter({ hasText: app.topic.title }).click()
    await moreAction(page.locator(`#topic-documents [data-document-id="${app.first.id}"]`), '删除影响')
    const dialog = page.locator('#deletion-preview-dialog'), execute = page.locator('#deletion-execute')
    await expect(dialog).toContainText('这不等于彻底清除内容')
    if (process.env.CLASSIFIER_TEST_STORAGE !== 'sqlite') {
      await expect(dialog).toContainText('显式备份并迁移到 SQLite')
      await expect(execute).not.toBeVisible(); await expect(page.locator('#deletion-confirm')).not.toBeVisible()
      return
    }
    await expect(execute).toBeDisabled()
    await page.locator('#deletion-confirm').check()
    await app.value(`/api/notes/${app.note.id}`, json('PATCH', { revision: app.note.revision, content: '预览后新增的人工修订' }))
    await execute.click()
    await expect(dialog).toContainText('请刷新后重新确认')
    await dialog.getByRole('button', { name: '刷新影响范围' }).click()
    await expect(page.locator('#deletion-confirm')).not.toBeChecked()
    await expect(execute).toBeDisabled()
    await page.locator('#deletion-confirm').check()
    await page.screenshot({ path: testInfo.outputPath('deletion-confirmation.png'), fullPage: true })
    await execute.click()
    await expect(dialog).not.toBeVisible()
    await expect(page.locator(`#topic-documents [data-document-id="${app.first.id}"]`)).toHaveCount(0)
    await expect(page.locator('#topic-note-list')).toContainText('原文已删除')
    await page.locator('#report-list').getByRole('button', { name: '打开成果', exact: true }).click()
    await expect(page.locator('#report-body')).toContainText(report.blocks[0].text)
    await page.locator('#report-body .report-citation').first().click()
    await expect(page.locator('#report-inspector-body')).toContainText('原文已删除')
    await expect(page.locator('#report-inspector-body').getByRole('button', { name: '打开原文位置' })).toBeDisabled()
    await page.screenshot({ path: testInfo.outputPath('deleted-source-report.png'), fullPage: true })
    const exported = await (await app.request(`/api/reports/${report.id}/export?revision=${report.revision}`)).text()
    expect(exported).toContain('原文已删除'); expect(exported).toContain(report.blocks[0].text)
    await app.restart(); await page.reload()
    await expect(page.locator('#report-body')).toContainText(report.blocks[0].text)
    expect(errors).toEqual([])
  } finally { await app.close() }
})

test('D2 topic deletion returns home and retains shared library documents', async ({ page }, testInfo) => {
  const app = await reportFixture()
  try {
    await page.goto(app.base)
    await page.locator('.topic-card').filter({ hasText: app.topic.title }).click()
    await clickControl(page, '#topic-impact')
    const dialog = page.locator('#deletion-preview-dialog')
    await expect(dialog).toContainText('共享文献库中的原文件保留')
    if (process.env.CLASSIFIER_TEST_STORAGE !== 'sqlite') {
      await expect(page.locator('#deletion-execute')).not.toBeVisible()
      return
    }
    await page.locator('#deletion-confirm').check(); await page.locator('#deletion-execute').click()
    await expect(dialog).not.toBeVisible()
    await expect(page.locator('.topic-card').filter({ hasText: app.topic.title })).toHaveCount(0)
    await page.locator('#all-documents-open').click()
    await expect(page.locator('#all-documents-list')).toContainText(app.first.title)
    await expect(page.locator('#all-documents-list')).toContainText(app.second.title)
    await page.screenshot({ path: testInfo.outputPath('topic-deleted-shared-documents.png'), fullPage: true })
  } finally { await app.close() }
})
