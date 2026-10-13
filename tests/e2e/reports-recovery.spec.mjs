import { test, expect, readSessionDraft } from '../helpers/browser-fixture.mjs'
import { reportFixture } from '../helpers/report-fixture.mjs'
import { json } from '../helpers/test-app.mjs'

async function open(page, app, sources = []) {
  const report = await app.value(`/api/topics/${app.topic.id}/reports`, json('POST', { title: '恢复验收成果', sources }), 201)
  await page.goto(app.base)
  await page.locator('.topic-card').filter({ hasText: app.topic.title }).click()
  await page.getByRole('button', { name: '打开成果', exact: true }).click()
  await expect(page.locator('#report-title')).toHaveText(report.title)
  return report
}
async function pick(page, doc) {
  await page.locator('#report-document-choice').selectOption(doc.id)
  await page.locator('.report-reference-picker input').first().check()
  await page.getByRole('button', { name: '加入所选片段', exact: true }).click()
}
async function save(page) { await page.locator('#report-save').click(); await expect(page.locator('#report-editor')).not.toBeVisible() }

test('M4 restored passage drafts show exact selections and let the user remove one', async ({ page }) => {
  const app = await reportFixture()
  try {
    const report = await open(page, app)
    await page.locator('#report-materials').click()
    await pick(page, app.first); await pick(page, app.second)
    const draftKey = `classifier-report-draft:${app.topic.id}:${report.id}:sources`
    const original = JSON.parse(await readSessionDraft(page, draftKey))
    await page.reload(); await page.locator('#report-resume').click()
    const options = page.locator('.report-material-options')
    await expect(options.getByRole('checkbox', { name: app.first.title, exact: true })).toBeChecked()
    await expect(options.getByRole('checkbox', { name: app.second.title, exact: true })).toBeChecked()
    await options.getByRole('checkbox', { name: app.first.title, exact: true }).uncheck()
    // Re-rendering the choices must not change a restored passage selector.
    await pick(page, app.second)
    await options.getByRole('checkbox', { name: app.first.title, exact: true }).check()
    await options.getByRole('checkbox', { name: app.second.title, exact: true }).uncheck()
    const pending = JSON.parse(await readSessionDraft(page, draftKey))
    expect(pending.body.sources).toEqual([original.body.sources.find(source => source.documentId === app.first.id)])
    await save(page)
    const saved = await app.value(`/api/reports/${report.id}`)
    expect(saved.sources).toHaveLength(1)
    expect(saved.sources[0].documentId).toBe(app.first.id)
    expect(saved.sources[0].documentVersion).toBe(app.first.evidenceVersion)
    expect(saved.sources[0].content.referenceIds).toEqual([app.first.references[0].id])
  } finally { await app.close() }
})

test('M4 a restored passage draft remains removable after its document leaves the topic', async ({ page }) => {
  const app = await reportFixture()
  try {
    const report = await open(page, app)
    await page.locator('#report-materials').click(); await pick(page, app.first)
    await app.value(`/api/topics/${app.topic.id}/documents/${app.first.id}`, { method: 'DELETE' })
    await page.reload(); await page.locator('#report-resume').click()
    const unavailable = page.locator('.report-material-options').getByRole('checkbox', { name: /原文材料（当前不可用/ })
    await expect(unavailable).toBeChecked()
    await unavailable.uncheck(); await save(page)
    expect((await app.value(`/api/reports/${report.id}`)).sources).toEqual([])
  } finally { await app.close() }
})

async function openCitationWhileEditing(page, app) {
  const report = await open(page, app, [app.selectors[0]])
  await page.locator('#report-assemble').click()
  await expect(page.locator('#report-body .report-block')).toHaveCount(1)
  await page.locator('#report-edit').click()
  await page.locator('.report-block-text').fill('回查原文之前尚未保存的修订')
  await page.locator('#report-latest').click()
  await page.locator('#report-inspector-body .report-citation').first().click()
  return report
}

test('M4 opening a citation during editing reveals the reader and retains the draft after returning', async ({ page }) => {
  const app = await reportFixture(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    const report = await openCitationWhileEditing(page, app)
    await page.getByRole('button', { name: '打开原文位置', exact: true }).click()
    await expect(page.locator('#report-editor')).not.toBeVisible()
    await expect(page.locator('#report-inspector')).not.toBeVisible()
    await expect(page.locator('#workspace')).toBeVisible()
    await expect(page.locator('#reference-ref_00001')).toHaveClass(/highlight/)
    await page.locator('#reader-back').click()
    await page.reload(); await page.locator('#report-resume').click()
    await expect(page.locator('.report-block-text')).toHaveValue('回查原文之前尚未保存的修订')
    expect((await app.value(`/api/reports/${report.id}`)).blocks[0].text).toBe(`${app.first.title} · ${app.original}`)
    await save(page)
    expect((await app.value(`/api/reports/${report.id}`)).blocks[0].text).toBe('回查原文之前尚未保存的修订')
    expect(errors).toEqual([])
  } finally { await app.close() }
})

test('M4 failed citation navigation still leaves a recoverable editing draft', async ({ page }) => {
  const app = await reportFixture()
  try {
    await openCitationWhileEditing(page, app)
    await page.route(`**/api/documents/${app.first.id}`, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '原文暂时不可用' }) }))
    await page.getByRole('button', { name: '打开原文位置', exact: true }).click()
    await expect(page.locator('#app-message')).toContainText('原文暂时不可用')
    await expect(page.locator('#report-editor')).not.toBeVisible()
    await page.locator('#report-resume').click()
    await expect(page.locator('.report-block-text')).toHaveValue('回查原文之前尚未保存的修订')
    await save(page)
    await expect(page.locator('#report-body')).toContainText('回查原文之前尚未保存的修订')
  } finally { await page.unrouteAll({ behavior: 'wait' }); await app.close() }
})
