import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { testApp, json, upload } from '../helpers/test-app.mjs'

async function setup(qaOptions) {
  const app = await testApp({ qaOptions })
  const topic = await (await app.request('/api/topics', json('POST', { title: '比较研究', question: '研究材料和适用条件如何不同？' }))).json()
  await app.request(`/api/topics/${topic.id}/documents/${app.legacy.id}`, { method: 'PUT' })
  const second = await (await app.request('/api/documents', upload('# 第二份研究\n\n材料来自不同来源，在不同条件下完成测量。', 'second.md', topic.id))).json()
  const third = await (await app.request('/api/documents', upload('# 第三份研究\n\n另一个研究对象与条件。', 'third.md', topic.id))).json()
  const first = await (await app.request(`/api/documents/${app.legacy.id}`)).json()
  const note = await (await app.request(`/api/topics/${topic.id}/documents/${first.id}/notes`, json('POST', { field: '材料', origin: { type: 'reference' }, referenceIds: [first.references[0].id], documentVersion: first.evidenceVersion }))).json()
  return { ...app, topic, first, second, third, note }
}
async function topicView(page, app) {
  await page.goto(app.base)
  await page.getByRole('button', { name: '研究主题', exact: true }).click()
  await page.locator('.topic-card').filter({ hasText: app.topic.title }).click()
}
async function createThroughUi(page, app) {
  await topicView(page, app)
  await page.locator('#new-comparison').click()
  await page.locator('#cmp-title').fill('研究材料对照')
  await page.getByRole('checkbox', { name: app.first.title, exact: true }).check()
  await page.getByRole('checkbox', { name: app.second.title, exact: true }).check()
  while (await page.locator('.comparison-column-option').count() > 1) await page.locator('.comparison-column-option').last().getByRole('button', { name: '移除维度' }).click()
  await page.locator('.column-name').fill('材料')
  await page.locator('.column-description').fill('材料来源和适用条件')
  await page.locator('#comparison-save').click()
  await expect(page.locator('#comparison-editor')).not.toBeVisible()
  await expect(page.locator('#comparison-title')).toHaveText('研究材料对照')
}
const row = (page, id) => page.locator(`#comparison-grid tr[data-document-id="${id}"]`)
async function editRow(page, id) { await row(page, id).getByRole('button', { name: '编辑比较项', exact: true }).first().click() }
async function save(page) { await page.locator('#comparison-save').click(); await expect(page.locator('#comparison-editor')).not.toBeVisible() }

test('M3 create, edit evidence, compare conditions, preserve history, drafts and restart', async ({ page }, testInfo) => {
  const app = await setup()
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  try {
    await createThroughUi(page, app)
    await editRow(page, app.first.id)
    await page.locator('#cmp-note-choice').selectOption(app.note.id)
    await page.getByRole('button', { name: '从笔记填入', exact: true }).click()
    await expect(page.locator('#cmp-value')).toHaveValue(app.first.references[0].text)
    await page.locator('#cmp-conditions').fill('只报告两组材料')
    await page.locator('#cmp-comparability').selectOption('conditional')
    await page.locator('#comparison-save').click()
    await expect(page.locator('#comparison-editor-error')).toContainText('原因')
    await page.locator('#cmp-reason').fill('需要统一测量条件')
    await save(page)
    await expect(row(page, app.first.id)).toContainText('有条件可比')
    await row(page, app.first.id).getByRole('button', { name: '查看出处 (1)' }).click()
    await page.locator('#comparison-inspector-body').getByRole('button', { name: /^出处：/ }).click()
    await expect(page.locator('.comparison-quote')).toHaveText(app.original)
    await page.getByRole('button', { name: '打开原文位置', exact: true }).click()
    await expect(page.locator('#reference-ref_00001')).toHaveClass(/highlight/)
    await expect(page.locator('#reader-back')).toHaveText('← 返回比较表')
    await page.locator('#reader-back').click()
    await expect(page.locator('#comparison-title')).toHaveText('研究材料对照')

    await editRow(page, app.second.id)
    await page.locator('#cmp-value').fill('不同来源的研究材料')
    await page.locator('#cmp-kind').selectOption('source')
    await page.getByRole('button', { name: '选择当前原文', exact: true }).click()
    await page.locator('.comparison-reference-options input[type="checkbox"]').first().check()
    await page.locator('#cmp-comparability').selectOption('not_comparable')
    await page.locator('#cmp-reason').fill('测量设置不同')
    await save(page)
    await expect(row(page, app.second.id)).toContainText('不可直接比较')
    await page.getByRole('button', { name: '编辑综合判断', exact: true }).click()
    await page.locator('#cmp-relation').selectOption('difference')
    await page.locator('#cmp-analysis-value').fill('两篇研究条件不一致，暂不直接比较数值。')
    await page.locator('#cmp-analysis-conditions').fill('需补齐材料来源与测量设置。')
    await save(page)
    await expect(page.locator('#comparison-analyses')).toContainText('两篇研究条件不一致')
    const stored = (await (await app.request(`/api/topics/${app.topic.id}/comparisons`)).json()).comparisons[0]
    const baseRevision = stored.revision
    await editRow(page, app.first.id)
    await page.locator('#cmp-value').fill('人工修订后的比较内容')
    await save(page)
    await expect(page.locator('#comparison-analyses')).toContainText('需要复核')
    await page.locator('#comparison-history').click()
    await page.locator('#comparison-inspector-body .comparison-analysis').filter({ has: page.getByRole('heading', { name: `版本 ${baseRevision} · 研究材料对照`, exact: true }) }).getByRole('button', { name: '恢复为新版本' }).click()
    await expect(page.locator('#comparison-inspector')).not.toBeVisible()
    await expect(row(page, app.first.id)).toContainText(app.original)

    await editRow(page, app.first.id)
    await page.locator('#cmp-conditions').fill('刷新后继续的条件草稿')
    await page.reload()
    await expect(page.locator('#comparison-title')).toHaveText('研究材料对照')
    await page.locator('#comparison-resume').click()
    await expect(page.locator('#cmp-conditions')).toHaveValue('刷新后继续的条件草稿')
    await save(page)
    await app.restart(); await page.reload()
    await expect(row(page, app.first.id)).toContainText('刷新后继续的条件草稿')
    await page.screenshot({ path: testInfo.outputPath('comparison-desktop.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('comparison-mobile.png'), fullPage: true })
    await page.locator('#comparison-configure').click()
    await page.getByRole('checkbox', { name: app.third.title, exact: true }).check()
    await page.getByRole('button', { name: '＋ 添加维度' }).click()
    await page.locator('.column-name').last().fill('成本边界')
    await save(page)
    await expect(page.locator('#comparison-grid tbody tr')).toHaveCount(3)
    await expect(page.locator('#comparison-grid')).toContainText('成本边界')
    await page.locator('#comparison-archive').click()
    await expect(page.locator('#comparison-message')).toContainText('已归档')
    await page.locator('#comparison-archive').click()
    await expect(page.locator('#comparison-archive')).toHaveText('归档')
    expect(errors).toEqual([])
  } finally { await app.close() }
})

test('M3 model proposals require adoption and reject a stale column', async ({ page }) => {
  let hang = false
  const seen = []
  const qaOptions = { config: { url: 'https://model.invalid/comparison', key: 'test-only', model: 'fixture' }, fetchImpl: async (_url, options) => {
    if (hang) return new Promise((resolve, reject) => { if (options.signal.aborted) reject(options.signal.reason); else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }) })
    const input = JSON.parse(JSON.parse(options.body).messages[1].content); seen.push(input)
    const cells = input.documents.map(doc => ({ documentId: doc.id, value: `建议：${doc.title}中的研究材料`, status: 'recorded', kind: 'source', conditions: '当前材料描述的条件', comparability: 'conditional', reason: '需核对条件一致性', referenceIds: input.evidence.filter(item => item.documentId === doc.id).slice(0, 1).map(item => item.id) }))
    const analysis = { relation: 'difference', value: '所选文献在研究条件上存在差异。', conditions: '不能直接合并不同设置的结果。', referenceIds: cells.flatMap(cell => cell.referenceIds) }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ cells, analysis }) } }] }))
  } }
  const app = await setup(qaOptions)
  try {
    await createThroughUi(page, app)
    await page.locator('#comparison-generate').click()
    await page.getByRole('button', { name: '审阅本列建议', exact: true }).first().click()
    await expect(page.locator('#comparison-inspector-body')).toContainText('建议：')
    await expect(row(page, app.first.id)).toContainText('未填写')
    await page.getByRole('button', { name: '采用本列建议', exact: true }).click()
    await expect(page.locator('#comparison-inspector')).not.toBeVisible()
    await expect(row(page, app.first.id)).toContainText('建议：')
    expect(seen[0].documents.map(doc => doc.id)).toEqual([app.first.id, app.second.id])
    expect(seen[0].evidence.some(item => item.documentId === app.third.id)).toBe(false)
    await page.locator('#comparison-generate').click()
    await expect(page.getByRole('button', { name: '审阅本列建议', exact: true })).toHaveCount(2)
    await editRow(page, app.first.id)
    await page.locator('#cmp-value').fill('保留任务之后的人工修改')
    await save(page)
    await page.getByRole('button', { name: '审阅本列建议', exact: true }).first().click()
    await page.getByRole('button', { name: '采用本列建议', exact: true }).click()
    await expect(page.locator('#comparison-inspector-error')).toContainText('旧建议不会覆盖')
    await page.locator('#comparison-inspector-close').click()
    await expect(row(page, app.first.id)).toContainText('保留任务之后的人工修改')
    hang = true
    await page.locator('#comparison-generate').click()
    await page.getByRole('button', { name: '停止生成', exact: true }).click()
    await expect(page.locator('#comparison-suggestions')).toContainText('用户已取消')
    await page.reload()
    await expect(row(page, app.first.id)).toContainText('保留任务之后的人工修改')
  } finally { await app.close() }
})

test('M3 stale edits keep input and can load the latest saved cell', async ({ page }) => {
  const app = await setup()
  try {
    await createThroughUi(page, app)
    await editRow(page, app.first.id)
    await page.locator('#cmp-value').fill('尚未保存的人工比较')
    const table = (await (await app.request(`/api/topics/${app.topic.id}/comparisons`)).json()).comparisons[0]
    await app.request(`/api/comparisons/${table.id}`, json('PATCH', { revision: table.revision, title: '另一个页面修改的标题' }))
    await page.locator('#comparison-save').click()
    await expect(page.locator('#comparison-editor-error')).toContainText('已被修改')
    await expect(page.locator('#cmp-value')).toHaveValue('尚未保存的人工比较')
    await page.locator('#comparison-editor-latest').click()
    await expect(page.locator('#cmp-value')).toHaveValue('')
    await page.locator('#cmp-value').fill('合并后保存的人工比较')
    await save(page)
    await expect(row(page, app.first.id)).toContainText('合并后保存的人工比较')
  } finally { await app.close() }
})

test('M3 a late source reload cannot discard typing in a comparison editor', async ({ page }) => {
  const app = await setup(), gate = Promise.withResolvers()
  let waiting = false
  try {
    await createThroughUi(page, app)
    await editRow(page, app.first.id)
    await page.locator('#cmp-value').fill('当前的人工比较')
    const table = (await (await app.request(`/api/topics/${app.topic.id}/comparisons`)).json()).comparisons[0]
    await app.request(`/api/comparisons/${table.id}`, json('PATCH', { revision: table.revision, title: '并发更新标题' }))
    await page.locator('#comparison-save').click()
    await expect(page.locator('#comparison-editor-latest')).toBeVisible()
    await page.route(`**/api/comparisons/${table.id}/sources/${app.first.id}`, async route => {
      const response = await route.fetch(); waiting = true; await gate.promise; await route.fulfill({ response }).catch(() => {})
    })
    await page.locator('#comparison-editor-latest').click()
    await expect.poll(() => waiting).toBe(true)
    await page.locator('#cmp-value').fill('等待期间补充的比较内容')
    gate.resolve()
    await page.waitForLoadState('networkidle')
    await expect(page.locator('#cmp-value')).toHaveValue('等待期间补充的比较内容')
  } finally { gate.resolve(); await page.unrouteAll({ behavior: 'wait' }); await app.close() }
})
