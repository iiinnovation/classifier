import { test, expect } from '../helpers/browser-fixture.mjs'
import { readFile } from 'node:fs/promises'
import { reportFixture, reportReply } from '../helpers/report-fixture.mjs'
import { json } from '../helpers/test-app.mjs'

async function openTopic(page, app) {
  await page.goto(app.base)
  await page.getByRole('button', { name: '研究主题', exact: true }).click()
  await page.locator('.topic-card').filter({ hasText: app.topic.title }).click()
}
async function save(page) { await page.locator('#report-save').click(); await expect(page.locator('#report-editor')).not.toBeVisible() }
async function create(page, app) {
  await openTopic(page, app)
  await page.locator('#new-report').click()
  await page.locator('#report-title-input').fill('可追溯的研究总结')
  await save(page)
  await expect(page.locator('#report-title')).toHaveText('可追溯的研究总结')
}
async function choose(page, comparison = true) {
  await page.locator('#report-materials').click()
  await page.locator('.report-material-options').getByRole('checkbox', { name: '笔记 · 主要发现', exact: true }).check()
  if (comparison) await page.locator('.report-material-options').getByRole('checkbox', { name: '比较表 · 条件比较', exact: true }).check()
  await save(page)
}

test('M4 selected notes and comparisons become editable, traceable, exportable research with history and restart', async ({ page }, testInfo) => {
  const app = await reportFixture(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await create(page, app); await choose(page)
    await page.locator('#report-assemble').click()
    await expect(page.locator('#report-body .report-block')).toHaveCount(4)
    const assembled = (await app.value(`/api/topics/${app.topic.id}/reports`)).reports[0]
    await page.locator('#report-assemble').click()
    await expect(page.locator('#app-message')).toContainText('无需重复加入')
    await expect(page.locator('#report-body .report-block')).toHaveCount(4)
    expect((await app.value(`/api/reports/${assembled.id}`)).revision).toBe(assembled.revision)
    await expect(page.locator('#report-body .report-block').first()).toContainText(`${app.first.title} · ${app.original}`)
    await expect(page.locator('#report-body')).toContainText('不可直接比较；测量条件不一致')
    await page.locator('#report-body .report-citation').first().click()
    await expect(page.locator('.report-quote')).toHaveText(app.first.references[0].text)
    await page.getByRole('button', { name: '打开原文位置', exact: true }).click()
    await expect(page.locator('#reference-ref_00001')).toHaveClass(/highlight/)
    await expect(page.locator('#reader-back')).toHaveText('← 返回研究成果')
    await page.locator('#reader-back').click()
    await page.locator('#report-edit').click()
    await page.locator('.report-block-text').first().fill('人工修订的发现，仅针对当前样本。')
    await page.getByRole('button', { name: '＋ 添加段落', exact: true }).click()
    await page.locator('.report-block-section').last().fill('待验证事项')
    await page.locator('.report-paragraph-settings > summary').last().click()
    await page.locator('.report-block-kind').last().selectOption('question')
    await page.locator('.report-block-text').last().fill('其他研究对象是否适用，仍需验证。')
    await save(page)
    await page.locator('#report-body .report-block').first().getByRole('button', { name: '确认本段已核对', exact: true }).click()
    await expect(page.locator('#report-body .report-block').first()).toContainText('已核对')
    const downloadPromise = page.waitForEvent('download')
    await page.locator('#report-export').click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe('可追溯的研究总结.md')
    const markdown = await readFile(await download.path(), 'utf8')
    for (const content of ['人工修订的发现', '待验证问题', 'Researcher A', app.first.id, app.second.id, app.first.references[0].title, '不可直接比较']) expect(markdown).toContain(content)
    await page.locator('#report-edit').click()
    await page.locator('.report-block-text').first().fill('刷新后要继续的成果草稿')
    await page.reload()
    await page.locator('#report-resume').click()
    await expect(page.locator('.report-block-text').first()).toHaveValue('刷新后要继续的成果草稿')
    await save(page)
    await app.restart(); await page.reload()
    await expect(page.locator('#report-body')).toContainText('刷新后要继续的成果草稿')
    await page.locator('#report-history').click()
    const old = page.locator('.report-history-item').filter({ hasText: '人工修订的发现' }).first()
    await old.getByRole('button', { name: '恢复为新版本', exact: true }).click()
    await expect(page.locator('#report-inspector')).not.toBeVisible()
    await expect(page.locator('#report-body')).toContainText('人工修订的发现')
    await page.screenshot({ path: testInfo.outputPath('report-desktop.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('report-mobile.png'), fullPage: true })
    await page.locator('#report-archive').click()
    await expect(page.locator('#report-edit')).toBeDisabled()
    await page.locator('#report-archive').click()
    await expect(page.locator('#report-edit')).toBeEnabled()
    expect(errors).toEqual([])
  } finally { await app.close() }
})

test('manuscript editing keeps citations through reorder undo and draft recovery', async ({ page }, testInfo) => {
  const app = await reportFixture()
  try {
    await create(page, app); await choose(page)
    await page.locator('#report-assemble').click()
    const original = await app.value('/api/reports/' + (await app.value(`/api/topics/${app.topic.id}/reports`)).reports[0].id)
    await page.locator('#report-edit').click()
    const rows = page.locator('.report-block-editor')
    await expect(rows).toHaveCount(4)
    await expect(page.locator('#report-question-input')).not.toBeVisible()
    await expect(page.locator('.report-block-kind').first()).not.toBeVisible()
    await expect(page.locator('.report-block-text').first()).toBeFocused()
    await expect(rows.first().locator('.report-selected-citations')).toContainText('出处：')
    await page.locator('.report-block-text').first().fill('连续写作后的论述，仍保留该段原有证据。')
    await rows.first().locator('.report-paragraph-settings > summary').click()
    await rows.first().getByRole('button', { name: '移除段落', exact: true }).click()
    await expect(rows).toHaveCount(3)
    await page.getByRole('button', { name: '撤销移除段落', exact: true }).click()
    await expect(rows).toHaveCount(4)
    await expect(page.locator('.report-block-text').first()).toHaveValue('连续写作后的论述，仍保留该段原有证据。')
    await rows.nth(1).locator('.report-paragraph-settings > summary').click()
    await rows.nth(1).getByRole('button', { name: '上移段落', exact: true }).click()
    await page.reload(); await page.locator('#report-resume').click()
    await expect(rows.first()).toHaveAttribute('data-block-id', original.blocks[1].id)
    await expect(page.locator('.report-block-text').nth(1)).toHaveValue('连续写作后的论述，仍保留该段原有证据。')
    await page.screenshot({ path: testInfo.outputPath('manuscript-desktop.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.locator('#report-editor').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('manuscript-mobile.png'), fullPage: true })
    await save(page)
    const saved = await app.value('/api/reports/' + original.id)
    expect(saved.blocks.map(block => block.id)).toEqual([original.blocks[1].id, original.blocks[0].id, ...original.blocks.slice(2).map(block => block.id)])
    for (const block of saved.blocks) expect(block.citationIds).toEqual(original.blocks.find(item => item.id === block.id).citationIds)
  } finally { await app.close() }
})

test('M4 original selection survives saved source removal and prevents navigation after parse changes', async ({ page }) => {
  const app = await reportFixture()
  try {
    await create(page, app)
    await page.locator('#report-materials').click()
    await page.locator('#report-document-choice').selectOption(app.first.id)
    await page.locator('.report-reference-picker input').first().check()
    await page.getByRole('button', { name: '加入所选片段', exact: true }).click()
    await save(page)
    await page.locator('#report-assemble').click()
    await expect(page.locator('#report-body')).toContainText(app.original)
    await app.value(`/api/topics/${app.topic.id}/documents/${app.first.id}`, { method: 'DELETE' })
    await page.reload()
    await page.locator('#report-body .report-citation').first().click()
    await expect(page.getByRole('button', { name: '打开原文位置', exact: true })).toBeEnabled()
    await page.locator('#report-inspector-close').click()
    await app.changeDocument(app.first.id, doc => { doc.references[0].text = '新解析的原文' })
    await page.reload()
    await expect(page.locator('#report-message')).toContainText('材料已有更新')
    await page.locator('#report-body .report-citation').first().click()
    await expect(page.locator('.report-quote')).toHaveText(app.original)
    await expect(page.getByRole('button', { name: '打开原文位置', exact: true })).toBeDisabled()
  } finally { await app.close() }
})

test('M4 conflicting edits and late latest responses preserve typing and the reloadable draft', async ({ page }) => {
  const app = await reportFixture(), gate = Promise.withResolvers()
  let waiting = false
  try {
    await create(page, app); await choose(page, false)
    await page.locator('#report-assemble').click()
    await expect(page.locator('#report-body .report-block')).toHaveCount(1)
    await page.locator('#report-edit').click()
    await page.locator('.report-block-text').fill('尚未保存的成果修订')
    const report = (await app.value(`/api/topics/${app.topic.id}/reports`)).reports[0]
    await app.value(`/api/reports/${report.id}`, json('PATCH', { revision: report.revision, title: '另一标签页的标题' }))
    await page.locator('#report-save').click()
    await expect(page.locator('#report-editor-error')).toContainText('已被修改')
    await page.route(`**/api/reports/${report.id}`, async route => {
      const response = await route.fetch(); waiting = true; await gate.promise; await route.fulfill({ response }).catch(() => {})
    })
    await page.locator('#report-latest').click()
    await expect.poll(() => waiting).toBe(true)
    await page.locator('.report-block-text').fill('等待最新版本时继续补充的判断')
    gate.resolve()
    await page.waitForLoadState('networkidle')
    await expect(page.locator('#report-inspector')).not.toBeVisible()
    await expect(page.locator('.report-block-text')).toHaveValue('等待最新版本时继续补充的判断')
    await page.unrouteAll({ behavior: 'wait' }); await page.reload()
    await page.locator('#report-resume').click()
    await expect(page.locator('.report-block-text')).toHaveValue('等待最新版本时继续补充的判断')
    await page.locator('#report-latest').click()
    await expect(page.locator('#report-inspector-title')).toContainText('另一标签页的标题')
    await page.getByRole('button', { name: '使用已保存版本编辑', exact: true }).click()
    await expect(page.locator('#report-title-input')).toHaveValue('另一标签页的标题')
    await page.locator('.report-block-text').fill('核对后手工合并的内容')
    await save(page)
    await expect(page.locator('#report-body')).toContainText('核对后手工合并的内容')
  } finally { gate.resolve(); await page.unrouteAll({ behavior: 'wait' }); await app.close() }
})

test('M4 model drafts require adoption, protect later edits and allow cancellation', async ({ page }) => {
  let hang = false
  const qaOptions = { config: { url: 'https://fixture.invalid', key: 'test-only', model: 'fixture' }, fetchImpl: async (_url, options) => {
    if (hang) return new Promise((resolve, reject) => { if (options.signal.aborted) reject(options.signal.reason); else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }) })
    const input = JSON.parse(JSON.parse(options.body).messages[1].content)
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reportReply(input)) } }] }))
  } }
  const app = await reportFixture(qaOptions)
  try {
    await create(page, app); await choose(page)
    await page.locator('#report-generate').click()
    await page.getByRole('button', { name: '审阅研究草稿', exact: true }).first().click()
    await expect(page.locator('#report-inspector-body')).toContainText('所选研究需要结合各自条件解释')
    await expect(page.locator('#report-body')).toContainText('研究总结草稿 · 待核对')
    await expect(page.locator('#report-body > .report-block')).toHaveCount(0)
    await page.getByRole('button', { name: '采用此草稿并替换正文', exact: true }).click()
    await expect(page.locator('#report-inspector')).not.toBeVisible()
    await expect(page.locator('#report-body')).toContainText('模型归纳')
    await page.locator('#report-generate').click()
    await expect(page.getByRole('button', { name: '审阅研究草稿', exact: true })).toHaveCount(2)
    await page.locator('#report-edit').click()
    await page.locator('.report-block-text').first().fill('模型生成之后的人工修改')
    await save(page)
    await page.getByRole('button', { name: '审阅研究草稿', exact: true }).first().click()
    await expect(page.getByRole('button', { name: '采用此草稿并替换正文', exact: true })).toBeDisabled()
    await expect(page.locator('#report-inspector-body')).toContainText('不会覆盖人工修改')
    await page.locator('#report-inspector-close').click()
    hang = true
    await page.locator('#report-generate').click()
    await page.getByRole('button', { name: '停止生成', exact: true }).click()
    await expect(page.locator('#report-suggestions')).toContainText('用户已取消')
    await expect(page.locator('#report-body')).toContainText('模型生成之后的人工修改')
  } finally { await app.close() }
})

test('M4 an uncertain creation retains corrections and recovers the existing report after reload', async ({ page }) => {
  const app = await reportFixture()
  try {
    await openTopic(page, app)
    await page.locator('#new-report').click()
    await page.locator('#report-title-input').fill('创建时的标题')
    let once = true
    await page.route(`**/api/topics/${app.topic.id}/reports`, async route => {
      if (route.request().method() === 'POST' && once) {
        once = false; await route.fetch()
        await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: '保存响应丢失' }) })
      } else await route.continue()
    })
    await page.locator('#report-save').click()
    await expect(page.locator('#report-editor-error')).toContainText('保存响应丢失')
    await page.locator('#report-title-input').fill('响应丢失后补充的标题')
    await page.reload()
    await page.getByRole('button', { name: '继续成果草稿：响应丢失后补充的标题', exact: true }).click()
    await expect(page.locator('#report-title-input')).toHaveValue('响应丢失后补充的标题')
    await save(page)
    await expect(page.locator('#report-title')).toHaveText('响应丢失后补充的标题')
    expect((await app.value(`/api/topics/${app.topic.id}/reports`)).reports).toHaveLength(1)
  } finally { await page.unrouteAll({ behavior: 'wait' }); await app.close() }
})
