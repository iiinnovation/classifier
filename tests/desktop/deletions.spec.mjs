import { clickControl, revealControl, moreAction } from '../helpers/ui-actions.mjs'
import { test, expect } from '../helpers/desktop-application.mjs'
import { readFile, writeFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { scannedPdf } from '../helpers/pdf-fixture.mjs'
import { DatabaseSync } from 'node:sqlite'

async function sqliteWindow(desktop) {
  await desktop.application.evaluate(({ dialog }) => { dialog.showMessageBox = async (_window, options) => ({ response: options.buttons?.includes('继续') ? 1 : 0 }) })
  const opened = desktop.application.waitForEvent('window')
  await desktop.application.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(item => item.label === '资料库').submenu.items.find(item => item.label === '升级当前 JSON 资料库…').click())
  const page = await opened
  await expect(page.locator('#new-topic')).toBeVisible()
  const directory = JSON.parse(await readFile(join(desktop.profile, 'library-selection.json'), 'utf8')).path
  return { page, directory }
}
async function value(page, path, method = 'GET', body, status = 200) {
  return page.evaluate(async ({ path, method, body, status }) => {
    const response = await fetch(path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    const result = await response.json()
    if (response.status !== status) throw new Error(`${path}: ${response.status}: ${JSON.stringify(result)}`)
    return result
  }, { path, method, body, status })
}
test('D2 real desktop deletes a shared original after explicit confirmation and keeps report evidence and history', async ({ desktop }, testInfo) => {
  const { page, directory } = await sqliteWindow(desktop)
  const fixture = await page.evaluate(async () => {
    const value = async (path, method = 'GET', body) => {
      const response = await fetch(path, { method, ...(body === undefined ? {} : body instanceof FormData ? { body } : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
      if (!response.ok) throw new Error(await response.text())
      return response.json()
    }
    const topic = await value('/api/topics', 'POST', { title: '真实桌面删除', question: '共享资料删除后继续阅读已有成果' })
    const upload = new FormData(); upload.append('file', new Blob(['研究发现需要结合原文条件解释。']), 'shared.txt'); upload.append('topicId', topic.id)
    const imported = await value('/api/documents', 'POST', upload), document = await value('/api/documents/' + imported.id)
    const other = await value('/api/topics', 'POST', { title: '保留共享主题', question: '关联同一篇文献' })
    await value(`/api/topics/${other.id}/documents/${document.id}`, 'PUT')
    let note = await value(`/api/topics/${topic.id}/documents/${document.id}/notes`, 'POST', { field: '主要发现', origin: { type: 'reference' }, referenceIds: [document.references[0].id], documentVersion: document.evidenceVersion })
    note = await value('/api/notes/' + note.id, 'PATCH', { revision: note.revision, content: '已保存的人工修订' })
    let report = await value(`/api/topics/${topic.id}/reports`, 'POST', { title: '删除后保留成果', sources: [{ type: 'note', id: note.id, revision: note.revision }] })
    report = await value('/api/reports/' + report.id + '/assemble', 'POST', { revision: report.revision })
    return { topic, other, document, note, report }
  })
  await page.reload(); await page.locator('.topic-card').filter({ hasText: fixture.topic.title }).click()
  await moreAction(page.locator(`#topic-documents [data-document-id="${fixture.document.id}"]`), '删除影响')
  await expect(page.locator('#deletion-execute')).toBeDisabled()
  await page.locator('#deletion-confirm').check()
  await page.screenshot({ path: testInfo.outputPath('desktop-deletion-confirmation.png'), fullPage: true })
  await page.locator('#deletion-execute').click(); await expect(page.locator('#deletion-preview-dialog')).not.toBeVisible()
  await expect(page.locator('#topic-note-list')).toContainText('原文已删除')
  await page.locator('#report-list').getByRole('button', { name: '打开成果', exact: true }).click()
  await expect(page.locator('#report-body')).toContainText(fixture.report.blocks[0].text)
  await page.locator('#report-body .report-citation').first().click()
  await expect(page.locator('#report-inspector-body')).toContainText('原文已删除')
  await expect(page.locator('#report-inspector-body').getByRole('button', { name: '打开原文位置' })).toBeDisabled()
  await page.screenshot({ path: testInfo.outputPath('desktop-deleted-source-report.png'), fullPage: true })
  const history = await value(page, `/api/reports/${fixture.report.id}/history`)
  expect(history.revision).toBe(fixture.report.revision); expect(history.history.length).toBeGreaterThan(0)
  expect((await value(page, `/api/topics/${fixture.other.id}`)).documentCount).toBe(0)
  await expect(lstat(join(directory, 'originals', fixture.document.id))).rejects.toMatchObject({ code: 'ENOENT' })
  const db = new DatabaseSync(join(directory, 'library.sqlite'), { readOnly: true })
  let version
  try { version = db.prepare('PRAGMA user_version').get().user_version } finally { db.close() }
  expect(version).toBe(2)
  const runtime = await desktop.application.evaluate(({ app }) => ({ packaged: app.isPackaged, source: app.getAppPath(), versions: process.versions }))
  await writeFile(testInfo.outputPath('deletion.json'), JSON.stringify({ ...runtime, databaseVersion: version, sharedLinksRemoved: true, retainedReportRevision: history.revision, savedEvidenceAndHistoryPreserved: true, originalRemoved: true }, null, 2) + '\n')
})

test('D2 real desktop topic deletion cancels active OCR and awaits its exit before committing', async ({ desktop }, testInfo) => {
  const { page } = await sqliteWindow(desktop)
  const topic = await value(page, '/api/topics', 'POST', { title: '删除时停止 OCR', question: '中断导入不使主题或文献复活' }, 201)
  await page.reload(); await page.locator('.topic-card').filter({ hasText: topic.title }).click()
  await page.locator('#import-open').click()
  await page.locator('#file').setInputFiles({ name: 'delete-topic-during-ocr.pdf', mimeType: 'application/pdf', buffer: scannedPdf(10, 300) })
  await expect.poll(async () => (await desktop.snapshot()).some(item => item.ocrRecognition), { timeout: 30000 }).toBe(true)
  await page.locator('#close-import').click()
  await clickControl(page, '#topic-impact')
  await expect(page.locator('#deletion-preview-dialog')).toContainText('相关活动任务')
  await page.locator('#deletion-confirm').check(); await page.locator('#deletion-execute').click()
  await expect(page.locator('#deletion-preview-dialog')).not.toBeVisible()
  await expect.poll(async () => (await desktop.snapshot()).some(item => item.ocrRecognition), { timeout: 15000 }).toBe(false)
  expect((await value(page, '/api/topics')).topics.some(value => value.id === topic.id)).toBe(false)
  expect((await value(page, '/api/documents')).documents).toEqual([])
  const runtime = await desktop.application.evaluate(({ app }) => ({ packaged: app.isPackaged, source: app.getAppPath(), versions: process.versions }))
  await writeFile(testInfo.outputPath('deletion-ocr.json'), JSON.stringify({ ...runtime, activeOcrObserved: true, ocrStoppedBeforeCompletion: true, topicDeleted: true, noImportedDocumentOrResurrection: true }, null, 2) + '\n')
})
