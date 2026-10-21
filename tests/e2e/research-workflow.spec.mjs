import { test, expect } from '../helpers/browser-fixture.mjs'
import { researchFixture, researchReply, waitResearch } from '../helpers/research-fixture.mjs'
import { json } from '../helpers/test-app.mjs'

async function topic(page, app) {
  await page.goto(app.base)
  await page.locator('.topic-card').filter({ hasText: app.topic.title }).click()
  await expect(page.locator('#research-task-start')).toBeEnabled()
}
test('AI task turns a goal and documents into a cited comparison and editable summary', async ({ page }, testInfo) => {
  const app = await researchFixture(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await topic(page, app)
    await expect(page.locator('#research-task-scope')).toContainText('已选 2 篇')
    await expect(page.locator('#research-task-goal')).toHaveValue(app.topic.question)
    await page.locator('#research-task-start').click()
    await expect(page.locator('#comparison-draft-preview')).toContainText('AI 比较草稿')
    await expect(page.locator('#comparison-draft-preview tbody tr')).toHaveCount(2)
    await expect(page.locator('#comparison-draft-preview thead th')).toHaveCount(3)
    await expect(page.locator('#comparison-grid')).toContainText('未填写')
    await expect(page.locator('#comparison-saved')).toBeVisible()
    await page.locator('#comparison-draft-preview .comparison-citation').first().click()
    await expect(page.locator('.comparison-quote')).toHaveText(app.original)
    await page.getByRole('button', { name: '打开原文位置', exact: true }).click()
    await expect(page.locator('#reference-ref_00001')).toHaveClass(/highlight/)
    await page.locator('#reader-back').click()
    await expect(page.locator('#comparison-draft-preview')).toContainText('AI 比较草稿')
    await page.screenshot({ path: testInfo.outputPath('research-comparison-draft.png'), fullPage: true })
    await page.getByRole('button', { name: '采用比较草稿', exact: true }).click()
    await expect(page.locator('#comparison-task-status')).toContainText('已采用')
    await expect(page.locator('#comparison-grid')).not.toContainText('未填写')
    await page.locator('#comparison-to-report').click()
    await expect(page.locator('#report-body')).toContainText('研究总结草稿')
    await expect(page.locator('#report-body .report-block')).toHaveCount(2)
    await page.locator('#report-body .report-citation').first().click()
    await expect(page.locator('.report-quote')).toBeVisible()
    await page.locator('#report-inspector-close').click()
    await page.screenshot({ path: testInfo.outputPath('research-summary-draft.png'), fullPage: true })
    await page.getByRole('button', { name: '采用研究总结', exact: true }).click()
    await expect(page.locator('#report-body')).not.toContainText('研究总结草稿')
    await page.locator('#report-edit').click()
    await page.locator('.report-block-text').first().fill('人工核对后的研究总结，保留对应引用。')
    await page.locator('#report-save').click()
    await expect(page.locator('#report-editor')).not.toBeVisible()
    await page.reload()
    await expect(page.locator('#report-body')).toContainText('人工核对后的研究总结')
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const download = page.waitForEvent('download'); await page.locator('#report-export').click()
    expect((await download).suggestedFilename()).toContain('研究总结')
    const comparisons = (await app.value('/api/topics/' + app.topic.id + '/comparisons')).comparisons
    const reports = (await app.value('/api/topics/' + app.topic.id + '/reports')).reports
    expect(comparisons).toHaveLength(1); expect(reports).toHaveLength(1)
    const result = await app.value('/api/reports/' + reports[0].id)
    expect(result.sources[0].id).toBe(comparisons[0].id)
    expect(result.blocks[0].citationIds.length).toBeGreaterThan(0)
    expect(app.inputs).toHaveLength(4)
    expect(errors).toEqual([])
  } finally { await app.close() }
})

test('discarding a full comparison draft keeps manual comparison controls available', async ({ page }) => {
  const app = await researchFixture()
  try {
    await topic(page, app)
    await page.locator('#research-task-start').click()
    await expect(page.locator('#comparison-draft-preview')).toContainText('AI 比较草稿')
    await page.getByRole('button', { name: '放弃草稿', exact: true }).click()
    await expect(page.locator('#comparison-draft-preview')).toBeEmpty()
    await expect(page.locator('#comparison-task-status')).toContainText('已放弃此比较草稿')
    await expect(page.locator('#comparison-saved')).toBeVisible()
    await expect(page.locator('#comparison-generate')).toBeEnabled()
  } finally { await app.close() }
})

test('AI task survives refresh, cancels and retries, then accepts a follow-up using the same materials', async ({ page }) => {
  let hang = true
  const app = await researchFixture({ respond: (input, options) => hang ? new Promise((resolve, reject) => { if (options.signal.aborted) reject(options.signal.reason); else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }) }) : researchReply(input) })
  try {
    await topic(page, app)
    await page.locator('#research-task-goal').fill('比较材料与方法')
    await page.reload()
    await expect(page.locator('#research-task-goal')).toHaveValue('比较材料与方法')
    await page.locator('#research-task-start').click()
    await expect(page.locator('#comparison-task-status')).toContainText('AI 正在整理')
    await page.reload()
    await page.getByRole('button', { name: '停止任务', exact: true }).click()
    await expect(page.locator('#comparison-task-status')).toContainText('已取消')
    hang = false
    await page.locator('#comparison-task-goal').fill('重点比较方法，再增加样本量')
    await page.reload()
    await expect(page.locator('#comparison-task-goal')).toHaveValue('重点比较方法，再增加样本量')
    await page.locator('#comparison-draft-generate').click()
    await expect(page.locator('#comparison-draft-preview')).toContainText('样本量')
    await page.getByRole('button', { name: '采用比较草稿', exact: true }).click()
    await expect(page.locator('#comparison-grid')).toContainText('样本量')
    const comparisons = (await app.value('/api/topics/' + app.topic.id + '/comparisons')).comparisons
    expect(comparisons).toHaveLength(1)
    expect(app.inputs.findLast(input => input.existingColumns).instruction).toBe('重点比较方法，再增加样本量')
  } finally { await app.close() }
})

test('AI task keeps a lost creation response retry on one comparison and exposes manual edits safely', async ({ page }) => {
  const app = await researchFixture()
  let lose = true
  try {
    await topic(page, app)
    await page.route('**/api/topics/' + app.topic.id + '/comparisons', async route => {
      if (route.request().method() !== 'POST' || !lose) return route.continue()
      lose = false; await route.fetch(); await route.abort()
    })
    await page.locator('#research-task-start').click()
    await expect(page.locator('#research-task-error')).not.toBeEmpty()
    await page.locator('#research-task-start').click()
    await expect(page.locator('#comparison-draft-preview')).toContainText('AI 比较草稿')
    const comparisons = (await app.value('/api/topics/' + app.topic.id + '/comparisons')).comparisons
    expect(comparisons).toHaveLength(1)
    await app.value('/api/comparisons/' + comparisons[0].id, json('PATCH', { revision: 1, title: '另一窗口修订的标题' }))
    await page.getByRole('button', { name: '采用比较草稿', exact: true }).click()
    await expect(page.locator('#comparison-draft-preview [role=alert]')).toContainText('修改')
    await page.reload()
    await expect(page.getByRole('button', { name: '采用比较草稿', exact: true })).toBeDisabled()
    expect((await app.value('/api/comparisons/' + comparisons[0].id)).title).toBe('另一窗口修订的标题')
  } finally { await page.unrouteAll({ behavior: 'wait' }); await app.close() }
})

test('AI task explains model availability and requires an explicit valid material scope', async ({ page }) => {
  const app = await researchFixture({ configured: false })
  try {
    await page.goto(app.base)
    await page.locator('.topic-card').filter({ hasText: app.topic.title }).click()
    await expect(page.locator('#research-task-start')).toBeDisabled()
    await expect(page.locator('#research-task-hint')).toContainText('尚未配置模型')
    await expect(page.locator('#new-comparison')).toBeEnabled()
    expect(app.inputs).toHaveLength(0)
  } finally { await app.close() }
})

test('old comparison draft keeps its original paper scope after documents are replaced', async ({ page }) => {
  const app = await researchFixture(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await topic(page, app)
    await page.locator('#research-task-start').click()
    await expect(page.locator('#comparison-draft-preview')).toContainText('AI 比较草稿')
    const table = (await app.value('/api/topics/' + app.topic.id + '/comparisons')).comparisons[0]
    await app.value('/api/topics/' + app.topic.id + '/documents/' + app.outside.id, { method: 'PUT' })
    await app.value('/api/comparisons/' + table.id, json('PATCH', { revision: table.revision, documentIds: [app.legacy.id, app.outside.id] }))
    await page.reload()
    await expect(page.locator('#comparison-draft-preview tbody tr')).toHaveCount(2)
    await expect(page.locator('#comparison-draft-preview tbody')).toContainText(app.second.title)
    await expect(page.locator('#comparison-draft-preview tbody')).not.toContainText(app.outside.title)
    await expect(page.locator('#comparison-saved')).toBeVisible()
    await expect(page.getByRole('button', { name: '采用比较草稿', exact: true })).toBeDisabled()
    await expect(page.locator('#comparison-draft-preview [role=alert]')).toContainText('原范围')
    expect(errors).toEqual([])
  } finally { await app.close() }
})

test('lost follow-up and report task responses reuse completed requests on retry', async ({ page }) => {
  const app = await researchFixture()
  try {
    await topic(page, app)
    await page.locator('#research-task-start').click()
    await expect(page.locator('#comparison-draft-preview')).toContainText('AI 比较草稿')
    let loseDraft = true, loseReport = true
    await page.route('**/api/comparisons/*/draft', async route => {
      if (!loseDraft) return route.continue()
      loseDraft = false
      const response = await route.fetch(), run = await response.json()
      await waitResearch(app, run.id); await route.abort()
    })
    await page.locator('#comparison-task-goal').fill('增加样本量')
    await page.locator('#comparison-draft-generate').click()
    await expect(page.locator('#comparison-message')).not.toBeEmpty()
    await page.locator('#comparison-draft-generate').click()
    await expect(page.locator('#comparison-draft-preview')).toContainText('样本量')
    expect(app.inputs).toHaveLength(6)
    await page.getByRole('button', { name: '采用比较草稿', exact: true }).click()
    await expect(page.locator('#comparison-task-status')).toContainText('已采用')
    await page.route('**/api/reports/*/suggestions', async route => {
      if (!loseReport) return route.continue()
      loseReport = false
      const response = await route.fetch(), run = await response.json()
      await waitResearch(app, run.id); await route.abort()
    })
    await page.locator('#comparison-to-report').click()
    await expect(page.locator('#report-message')).toContainText('重试')
    await page.locator('#report-generate').click()
    await expect(page.locator('#report-body')).toContainText('研究总结草稿')
    expect(app.inputs).toHaveLength(7)
    const table = (await app.value('/api/topics/' + app.topic.id + '/comparisons')).comparisons[0]
    await app.value('/api/comparisons/' + table.id, json('PATCH', { revision: table.revision, title: '材料发生修改' }))
    await page.reload()
    await expect(page.getByRole('button', { name: '采用研究总结', exact: true })).toBeDisabled()
    await expect(page.locator('#report-body')).toContainText('更新所选材料')
    await expect(page.locator('#report-generate')).toBeDisabled()
  } finally { await page.unrouteAll({ behavior: 'wait' }); await app.close() }
})
