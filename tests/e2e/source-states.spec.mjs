import { clickControl, revealControl, moreAction } from '../helpers/ui-actions.mjs'
import { test, expect } from '../helpers/browser-fixture.mjs'
import { reportFixture, reportReply, waitReportRun } from '../helpers/report-fixture.mjs'
import { json } from '../helpers/test-app.mjs'
import { unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

for (const state of ['missing', 'corrupt']) test(`D2 ${state} sources keep research and history readable while disabling unavailable source actions`, async ({ page }, testInfo) => {
  const app = await reportFixture({ config: { url: 'https://fixture.invalid', key: 'test-only', model: 'fixture' }, fetchImpl: async (_url, options) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reportReply(JSON.parse(JSON.parse(options.body).messages.at(-1).content))) } }] })) })
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  try {
    let report = await app.value(`/api/topics/${app.topic.id}/reports`, json('POST', { title: '保留的研究成果', sources: app.selectors }), 201)
    report = await app.value(`/api/reports/${report.id}/assemble`, json('POST', { revision: report.revision }))
    const run = await app.value(`/api/reports/${report.id}/suggestions`, json('POST', { revision: report.revision }), 202)
    expect((await waitReportRun(app, run.id)).status).toBe('completed')
    const note = await app.value(`/api/notes/${app.note.id}`, json('PATCH', { revision: app.note.revision, content: '人工修订后的笔记内容' }))
    if (process.env.CLASSIFIER_TEST_STORAGE === 'sqlite') {
      const db = new DatabaseSync(join(app.dataDir, 'library.sqlite'))
      try {
        if (state === 'missing') db.prepare('DELETE FROM records WHERE bucket=? AND id=?').run('documents', app.first.id)
        else { db.exec('PRAGMA ignore_check_constraints=ON'); db.prepare('UPDATE records SET body=? WHERE bucket=? AND id=?').run('{broken source', 'documents', app.first.id) }
      } finally { db.close() }
    } else {
      const path = join(app.dataDir, 'documents', app.first.id + '.json')
      if (state === 'missing') await unlink(path); else await writeFile(path, '{broken source')
    }
    const label = state === 'missing' ? '原文缺失' : '原文记录损坏', issue = state === 'missing' ? '来源缺失' : '来源记录损坏'
    await page.goto(app.base); await page.locator('.topic-card').filter({ hasText: app.topic.title }).click()
    await expect(page.locator('#topic-note-list')).toContainText(label)
    await expect(page.locator('#comparison-list')).toContainText(issue); await expect(page.locator('#report-list')).toContainText(issue)
    await expect(page.locator('#topic-note-list').getByRole('button', { name: '打开笔记', exact: true })).toBeDisabled()
    await page.locator('#topic-note-list').getByRole('button', { name: '查看笔记与历史' }).click()
    await expect(page.locator('#note-history-list')).toContainText(app.note.content)
    await page.locator('#note-history-list').getByRole('button', { name: app.first.references[0].title, exact: true }).first().click()
    await expect(page.locator('#evidence-warning')).toContainText(label); await expect(page.locator('#evidence-open-source')).toBeDisabled()
    await page.locator('#close-evidence').click(); await page.locator('#close-note-history').click()
    await page.locator('#comparison-list').getByRole('button', { name: '打开比较', exact: true }).click()
    await expect(page.locator('#comparison-message')).toContainText(issue); await expect(page.locator('#comparison-generate')).toBeDisabled()
    await page.locator(`#comparison-grid tr[data-document-id="${app.first.id}"]`).getByRole('button', { name: '查看出处 (1)', exact: true }).click()
    await expect(page.locator('#comparison-inspector-body')).toContainText(label)
    await expect(page.locator('#comparison-inspector-body').getByRole('button', { name: '打开原文位置' })).toBeDisabled()
    await page.locator('#comparison-inspector-close').click(); await page.locator('#comparison-back').click()
    await page.locator('#report-list').getByRole('button', { name: '打开成果', exact: true }).click()
    await expect(page.locator('#report-message')).toContainText(issue); await expect(page.locator('#report-body')).toContainText(report.blocks[0].text)
    await expect(page.locator('#report-generate')).toBeDisabled()
    await page.locator('#report-body .report-citation').first().click()
    await expect(page.locator('#report-inspector-body')).toContainText(label)
    await expect(page.locator('#report-inspector-body').getByRole('button', { name: '打开原文位置' })).toBeDisabled()
    await page.screenshot({ path: testInfo.outputPath(`source-${state}.png`), fullPage: true })
    await page.locator('#report-inspector-close').click()
    await page.locator('#report-pending').getByRole('button', { name: '审阅研究草稿' }).click()
    await expect(page.locator('#report-inspector-body').getByRole('button', { name: '采用此草稿并替换正文' })).toBeDisabled()
    await page.locator('#report-inspector-body .report-citation').first().click()
    await expect(page.locator('#report-inspector-body')).toContainText(label)
    await expect(page.locator('#report-inspector-body').getByRole('button', { name: '打开原文位置' })).toBeDisabled()
    await page.locator('#report-inspector-close').click(); await clickControl(page, '#report-materials')
    await expect(page.locator(`#report-document-choice option[value="${app.first.id}"]`)).toBeDisabled()
    for (const button of await page.locator('#report-fields').getByRole('button', { name: '选用当前版本' }).all()) await expect(button).toBeDisabled()
    await page.locator('#report-editor-close').click(); await page.locator('#report-back').click()
    await expect(page.locator('#topic-note-list')).toContainText(note.content)
    await page.locator('#topic-note-list').getByRole('button', { name: '查看笔记与历史' }).click()
    await page.locator('#note-history-list').getByRole('button', { name: '恢复为新版本' }).click()
    await expect(page.locator('#note-history-dialog')).not.toBeVisible()
    await expect(page.locator('#topic-note-list')).toContainText(app.note.content)
    await expect(page.locator('#topic-note-list')).not.toContainText(note.content)
    await expect(page.locator('#topic-note-list')).toContainText(label)
    expect(errors).toEqual([])
  } finally { await app.close() }
})
