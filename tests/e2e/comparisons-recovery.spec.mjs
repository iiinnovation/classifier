import { test, expect } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { testApp, json, upload } from '../helpers/test-app.mjs'

async function value(app, path, options, status = 200) {
  const response = await app.request(path, options)
  expect(response.status).toBe(status)
  return response.json()
}
async function finished(app, id) {
  for (let i = 0; i < 200; i++) {
    const run = await value(app, `/api/runs/${id}`)
    if (!['queued', 'running'].includes(run.status)) return run
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error('Task still running')
}
async function seed(app) {
  const topic = await value(app, '/api/topics', json('POST', { title: 'M3 审查复现', question: '材料和条件的差异是什么？' }), 201)
  await value(app, `/api/topics/${topic.id}/documents/${app.legacy.id}`, { method: 'PUT' })
  const second = await value(app, '/api/documents', upload('# 研究二\n\n材料与条件来自研究二。', 'two.md', topic.id), 201)
  const third = await value(app, '/api/documents', upload('# 研究三\n\n材料与条件来自研究三。', 'three.md', topic.id), 201)
  const columns = [{ id: randomUUID(), name: '材料' }, { id: randomUUID(), name: '方法' }]
  const table = await value(app, `/api/topics/${topic.id}/comparisons`, json('POST', { title: '复现比较表', documentIds: [app.legacy.id, second.id, third.id], columns }), 201)
  return { topic, table, columns, second, third }
}
async function open(page, app, topic) {
  await page.goto(app.base)
  await page.locator('.topic-card').filter({ hasText: topic.title }).click()
  await page.getByRole('button', { name: '打开比较', exact: true }).click()
  await expect(page.locator('#comparison-title')).toHaveText('复现比较表')
}

test('M3 a removed analysis dimension retains an accessible draft after loading latest', async ({ page }) => {
  const app = await testApp()
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  try {
    const { topic, table, columns } = await seed(app)
    await open(page, app, topic)
    await page.locator(`#comparison-analyses [data-column-id="${columns[0].id}"]`).getByRole('button', { name: '编辑综合判断', exact: true }).click()
    const content = '未保存的跨文献判断，删除维度后仍然需要恢复。'
    await page.locator('#cmp-analysis-value').fill(content)
    const key = `classifier-comparison-draft:${topic.id}:${table.id}:analysis::${columns[0].id}`
    await value(app, `/api/comparisons/${table.id}`, json('PATCH', { revision: table.revision, columns: [columns[1]] }))
    await page.locator('#comparison-save').click()
    await expect(page.locator('#comparison-editor-error')).toContainText('已被修改')
    await page.locator('#comparison-editor-latest').click()
    await expect(page.locator('#comparison-editor-error')).toContainText('已移除，草稿仍保留')
    await expect(page.locator('#cmp-analysis-value')).toHaveValue(content)
    expect(JSON.parse(await page.evaluate(key => sessionStorage.getItem(key), key)).body.value).toBe(content)
    await page.reload()
    await expect(page.locator('#comparison-drafts')).toBeVisible()
    await page.locator('#comparison-resume').click()
    await expect(page.locator('#comparison-inspector-body')).toContainText(content)
    await expect(page.locator('#comparison-inspector-body')).toContainText('草稿对应的维度或文献已移除')
    expect(errors).toEqual([])
  } finally { await app.close() }
})

test('M3 a removed row keeps its pending cell draft readable', async ({ page }) => {
  const app = await testApp()
  try {
    const { topic, table, columns, second, third } = await seed(app)
    await open(page, app, topic)
    await page.locator(`#comparison-grid tr[data-document-id="${third.id}"]`).getByRole('button', { name: '编辑比较项', exact: true }).first().click()
    await page.locator('#cmp-value').fill('被移除文献中尚未保存的比较内容')
    await value(app, `/api/comparisons/${table.id}`, json('PATCH', { revision: table.revision, documentIds: [app.legacy.id, second.id] }))
    await page.locator('#comparison-save').click()
    await expect(page.locator('#comparison-editor-latest')).toBeVisible()
    await page.locator('#comparison-editor-latest').click()
    await expect(page.locator('#comparison-editor-error')).toContainText('草稿仍保留')
    await page.reload()
    await page.locator('#comparison-resume').click()
    await expect(page.locator('#comparison-inspector-body')).toContainText('被移除文献中尚未保存的比较内容')
  } finally { await app.close() }
})

test('M3 historical citations resolve removed rows and still reject changed source versions', async ({ page }) => {
  const app = await testApp()
  try {
    const { topic, table, columns, second, third } = await seed(app)
    const original = await value(app, `/api/documents/${third.id}`)
    const filled = await value(app, `/api/comparisons/${table.id}/cells/${third.id}/${columns[0].id}`, json('PATCH', { revision: table.revision, value: '研究三报告的材料与条件', status: 'recorded', kind: 'source', source: { type: 'passages', referenceIds: [original.references[0].id], documentVersion: original.evidenceVersion } }))
    await value(app, `/api/comparisons/${table.id}`, json('PATCH', { revision: filled.revision, documentIds: [app.legacy.id, second.id] }))
    await open(page, app, topic)
    async function citation() {
      await page.locator('#comparison-history').click()
      await page.locator('#comparison-inspector-body .comparison-analysis').filter({ has: page.getByRole('heading', { name: `版本 ${filled.revision} · ${table.title}`, exact: true }) }).getByRole('button', { name: /^出处：/ }).click()
      await expect(page.locator('.comparison-quote')).toHaveText(original.references[0].text)
    }
    await citation()
    await expect(page.getByRole('button', { name: '打开原文位置', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '打开原文位置', exact: true }).click()
    await expect(page.locator('#title')).toHaveText(third.title)
    await expect(page.locator(`#reference-${original.references[0].id}`)).toHaveClass(/highlight/)
    await page.locator('#reader-back').click()
    await expect(page.locator('#comparison-grid tbody tr')).toHaveCount(2)
    const file = join(app.dataDir, 'documents', `${third.id}.json`)
    const changed = JSON.parse(await readFile(file, 'utf8')); changed.references[0].text = '当前解析版本已变化。'
    await writeFile(file, JSON.stringify(changed))
    await page.reload()
    await citation()
    await expect(page.getByRole('button', { name: '打开原文位置', exact: true })).toBeDisabled()
    await expect(page.locator('#comparison-inspector-body')).toContainText('版本已变化')
  } finally { await app.close() }
})
