import { clickControl, revealControl, moreAction } from '../helpers/ui-actions.mjs'
import { test, expect } from '../helpers/desktop-application.mjs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

for (const storage of ['json', 'sqlite']) for (const state of ['missing', 'corrupt']) test(`D2 ${storage} real desktop preserves research after ${state} sources and exposes only read-only deletion previews`, async ({ desktop }, testInfo) => {
  test.setTimeout(120000)
  let page = desktop.page, calls = 0
  const errors = [], watch = value => value.on('pageerror', error => errors.push(error.message))
  watch(page)
  const service = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const input = JSON.parse(JSON.parse(Buffer.concat(chunks).toString()).messages.at(-1).content)
      calls++
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ blocks: [{ section: '研究总结', text: '当前材料仍需结合研究条件解释。', kind: 'inference', citationIds: input.evidence.map(item => item.id) }] }) } }] }))
    } catch { response.writeHead(500); response.end('{}') }
  })
  service.listen(0, '127.0.0.1'); await once(service, 'listening')
  const value = (path, method = 'GET', body, status = 200) => page.evaluate(async ({ path, method, body, status }) => {
    const response = await fetch(path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    const result = await response.json()
    if (response.status !== status) throw new Error(`${path}: expected ${status}, got ${response.status}: ${JSON.stringify(result)}`)
    return result
  }, { path, method, body, status })
  try {
    const fixture = await page.evaluate(async () => {
      const value = async (path, method = 'GET', body, status = 200) => {
        const response = await fetch(path, { method, ...(body === undefined ? {} : body instanceof FormData ? { body } : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
        const result = await response.json()
        if (response.status !== status) throw new Error(`${path}: ${response.status}: ${JSON.stringify(result)}`)
        return result
      }
      const topic = await value('/api/topics', 'POST', { title: '打包数据生命周期', question: '比较研究条件并保留来源历史' }, 201)
      const documents = []
      for (const number of [1, 2]) {
        const body = new FormData()
        body.append('file', new Blob([`研究 ${number} 比较了不同样本，结论需要结合原文条件核对。`], { type: 'text/plain' }), `study-${number}.txt`)
        body.append('topicId', topic.id)
        const created = await value('/api/documents', 'POST', body, 201)
        documents.push(await value('/api/documents/' + created.id))
      }
      const first = documents[0]
      let note = await value(`/api/topics/${topic.id}/documents/${first.id}/notes`, 'POST', { field: '主要发现', origin: { type: 'reference' }, referenceIds: [first.references[0].id], documentVersion: first.evidenceVersion }, 201)
      const originalNoteContent = note.content
      note = await value('/api/notes/' + note.id, 'PATCH', { revision: note.revision, content: '人工修订后的打包笔记' })
      let comparison = await value(`/api/topics/${topic.id}/comparisons`, 'POST', { title: '打包比较表', documentIds: documents.map(doc => doc.id), columns: [{ name: '研究条件' }] }, 201)
      for (const doc of documents) comparison = await value(`/api/comparisons/${comparison.id}/cells/${doc.id}/${comparison.columns[0].id}`, 'PATCH', { revision: comparison.revision, value: doc.references[0].text, status: 'recorded', kind: 'source', source: { type: 'passages', referenceIds: [doc.references[0].id], documentVersion: doc.evidenceVersion } })
      let report = await value(`/api/topics/${topic.id}/reports`, 'POST', { title: '打包保留成果', sources: [{ type: 'note', id: note.id, revision: note.revision }, { type: 'comparison', id: comparison.id, revision: comparison.revision }] }, 201)
      report = await value('/api/reports/' + report.id + '/assemble', 'POST', { revision: report.revision })
      const other = await value('/api/topics', 'POST', { title: '共享原件主题', question: '保留同一份原文' }, 201)
      await value(`/api/topics/${other.id}/documents/${first.id}`, 'PUT')
      return { topic, first, note, comparison, report, originalNoteContent }
    })
    let dataDir = join(desktop.profile, 'data')
    if (storage === 'sqlite') {
      await desktop.application.evaluate(({ dialog }) => {
        dialog.showMessageBox = async (_window, options) => ({ response: options.buttons?.includes('继续') ? 1 : 0 })
      })
      const opened = desktop.application.waitForEvent('window')
      await desktop.application.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(item => item.label === '资料库').submenu.items.find(item => item.label === '升级当前 JSON 资料库…').click())
      page = await opened; watch(page)
      await expect(page.locator('#new-topic')).toBeVisible()
      dataDir = JSON.parse(await readFile(join(desktop.profile, 'library-selection.json'), 'utf8')).path
    }
    expect((await value('/api/storage-usage')).storage).toBe(storage)
    await page.locator('#model-settings-open').click()
    await page.locator('#model-settings-url').fill(`http://127.0.0.1:${service.address().port}/v1/chat/completions`)
    await page.locator('#model-settings-model').fill('packaged-fixture')
    await page.locator('#model-settings-key').fill('local-test-only')
    await page.locator('#model-settings-save').click()
    await expect(page.locator('#model-settings-dialog')).not.toBeVisible()
    const reportPath = '/api/reports/' + fixture.report.id
    const run = await value(reportPath + '/suggestions', 'POST', { revision: fixture.report.revision }, 202)
    await expect.poll(async () => (await value('/api/runs/' + run.id)).status).toBe('completed')
    expect(calls).toBe(1)

    const previews = []
    for (const [bucket, id] of [['documents', fixture.first.id], ['topics', fixture.topic.id], ['notes', fixture.note.id], ['comparisons', fixture.comparison.id], ['reports', fixture.report.id]]) {
      const preview = await value(`/api/deletion-preview/${bucket}/${id}`)
      expect(preview.readOnly).toBe(true); expect(preview.executionAvailable).toBe(storage === 'sqlite'); expect(preview.complete).toBe(true)
      previews.push({ bucket, counts: preview.counts, readOnly: preview.readOnly, executionAvailable: preview.executionAvailable })
    }
    const detach = await value(`/api/deletion-preview/documents/${fixture.first.id}?action=detach&topicId=${fixture.topic.id}`)
    expect(detach.counts.records).toBe(0); expect(detach.counts.topicLinks).toBe(1)
    for (const [path, method] of [[`/api/deletion-preview/documents/${fixture.first.id}`, 'POST'], [`/api/deletion-preview/documents/${fixture.first.id}`, 'DELETE']]) await value(path, method, undefined, 404)
    await value(`/api/documents/${fixture.first.id}`, 'DELETE', undefined, 400)
    await page.reload()
    await page.locator('.topic-card').filter({ hasText: fixture.topic.title }).click()
    await clickControl(page, '#topic-impact')
    const previewDialog = page.locator('#deletion-preview-dialog')
    await expect(previewDialog).toContainText('共享文献库中的原文件保留')
    await expect(previewDialog).toContainText('涉及 4 条记录')
    await expect(previewDialog.getByRole('button')).toHaveCount(storage === 'sqlite' ? 3 : 2)
    await page.screenshot({ path: testInfo.outputPath('desktop-d2-preview.png'), fullPage: true })
    await previewDialog.getByRole('button', { name: '关闭', exact: true }).click()
    expect((await value(reportPath)).revision).toBe(fixture.report.revision)
    expect((await value('/api/topics/' + fixture.topic.id)).documentCount).toBe(2)

    const original = await readFile(join(dataDir, 'originals', fixture.first.id))
    if (storage === 'json') {
      const path = join(dataDir, 'documents', fixture.first.id + '.json')
      if (state === 'missing') await unlink(path); else await writeFile(path, '{broken packaged source')
    } else {
      const db = new DatabaseSync(join(dataDir, 'library.sqlite'))
      try {
        if (state === 'missing') db.prepare('DELETE FROM records WHERE bucket=? AND id=?').run('documents', fixture.first.id)
        else { db.exec('PRAGMA ignore_check_constraints=ON'); db.prepare('UPDATE records SET body=? WHERE bucket=? AND id=?').run('{broken packaged source', 'documents', fixture.first.id) }
      } finally { db.close() }
    }
    // The original disappears after generation, without changing source revisions.
    // Refusal must be due to unavailable evidence, not an unrelated edit conflict.
    await value(reportPath + '/suggestions', 'POST', { revision: fixture.report.revision }, 409)
    await value(reportPath + '/adopt', 'POST', { revision: fixture.report.revision, runId: run.id }, 409)
    expect(calls).toBe(1)
    const saved = await value(reportPath + '/history')
    expect(saved.blocks[0].text).toBe(fixture.report.blocks[0].text)
    expect(saved.evidence.filter(item => item.documentId === fixture.first.id).every(item => item.sourceState === state && !item.matchesCurrent)).toBe(true)
    expect(saved.history.some(version => version.evidence.some(item => item.sourceState === state))).toBe(true)
    const label = state === 'missing' ? '原文缺失' : '原文记录损坏'
    const markdown = await page.evaluate(async path => (await fetch(path)).text(), `${reportPath}/export?revision=${saved.revision}`)
    expect(markdown).toContain(label); expect(markdown).not.toContain('原文已删除')
    await page.reload()
    await expect(page.locator('#topic-note-list')).toContainText(label)
    await page.locator('#topic-note-list').getByRole('button', { name: '查看笔记与历史' }).click()
    await expect(page.locator('#note-history-list')).toContainText(fixture.originalNoteContent)
    await page.locator('#note-history-list').getByRole('button', { name: '恢复为新版本' }).click()
    await expect(page.locator('#note-history-dialog')).not.toBeVisible()
    await expect(page.locator('#topic-note-list')).toContainText(fixture.originalNoteContent)
    await expect(page.locator('#topic-note-list').getByRole('button', { name: '打开笔记', exact: true })).toBeDisabled()
    await page.locator('#comparison-list').getByRole('button', { name: '打开比较', exact: true }).click()
    await expect(page.locator('#comparison-generate')).toBeDisabled()
    await page.locator('#comparison-back').click()
    await page.locator('#report-list').getByRole('button', { name: '打开成果', exact: true }).click()
    await expect(page.locator('#report-body')).toContainText(fixture.report.blocks[0].text)
    await expect(page.locator('#report-generate')).toBeDisabled()
    await page.locator('#report-body .report-citation').first().click()
    await expect(page.locator('#report-inspector-body')).toContainText(label)
    await expect(page.locator('#report-inspector-body').getByRole('button', { name: '打开原文位置' })).toBeDisabled()
    await page.screenshot({ path: testInfo.outputPath(`desktop-d2-source-${state}.png`), fullPage: true })
    expect(await readFile(join(dataDir, 'originals', fixture.first.id))).toEqual(original)
    expect((await value(reportPath)).revision).toBe(fixture.report.revision)
    expect(errors).toEqual([])
    const runtime = await desktop.application.evaluate(({ app }) => ({ packaged: app.isPackaged, source: app.getAppPath(), versions: process.versions }))
    expect(runtime.packaged).toBe(Boolean(process.env.CLASSIFIER_PACKAGED_EXECUTABLE))
    await writeFile(testInfo.outputPath('data-lifecycle.json'), JSON.stringify({ ...runtime, storage, state, previews, detach: detach.counts, originalPreserved: true, retainedReportRevision: saved.revision, historyRestoredAndListRefreshed: true, exportState: label, lostSourceGenerationAndAdoptionRejected: true, modelCalls: calls, pageErrors: errors }, null, 2) + '\n')
  } finally { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)) }
})
