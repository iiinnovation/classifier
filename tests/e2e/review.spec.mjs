import { test, expect } from '@playwright/test'
import { testApp, json } from '../helpers/test-app.mjs'

async function topic(app, title) {
  const response = await app.request('/api/topics', json('POST', { title, question: `${title} 的研究问题` }))
  expect(response.status).toBe(201)
  return response.json()
}
async function openTopic(page, title) {
  await page.getByRole('button', { name: '研究主题', exact: true }).click()
  await page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).click()
  await expect(page.locator('#topic-title')).toHaveText(title)
}

test('committed topic creation closes the editor even when list refresh fails', async ({ page }) => {
  const app = await testApp()
  let writes = 0, failRefresh = false
  try {
    await page.goto(app.base)
    await expect(page.locator('#all-document-count')).toContainText('1 篇文献')
    await page.route('**/api/topics', async route => {
      if (route.request().method() === 'POST') { writes++; failRefresh = true }
      else if (failRefresh) { failRefresh = false; return route.fulfill({ status: 503, json: { error: '列表暂时不可用' } }) }
      await route.continue()
    })
    await page.locator('#new-topic').click()
    await page.locator('#topic-name-input').fill('已保存的主题')
    await page.locator('#topic-question-input').fill('保存后的刷新失败是否会造成重复？')
    await page.getByRole('button', { name: '保存主题', exact: true }).click()
    await expect(page.locator('#topic-dialog')).not.toBeVisible()
    await expect(page.locator('#app-message')).toContainText('已保存')
    await expect(page.locator('#app-message')).toContainText('刷新')
    await openTopic(page, '已保存的主题')
    expect(writes).toBe(1)
    expect((await (await app.request('/api/topics')).json()).topics).toHaveLength(1)
  } finally { await app.close() }
})

test('saving freezes form fields until the captured edits have been persisted', async ({ page }) => {
  const app = await testApp()
  const release = Promise.withResolvers()
  let saving = false
  try {
    await topic(app, '编辑中')
    await page.goto(app.base)
    await openTopic(page, '编辑中')
    await page.route('**/api/topics/*', async route => {
      if (route.request().method() === 'PATCH') { saving = true; await release.promise }
      await route.continue().catch(() => {})
    })
    await page.locator('#edit-topic').click()
    await page.locator('#topic-name-input').fill('保存这一版')
    await page.getByRole('button', { name: '保存主题', exact: true }).click()
    await expect.poll(() => saving).toBe(true)
    await expect(page.locator('#topic-name-input')).toBeDisabled()
    await expect(page.locator('#topic-question-input')).toBeDisabled()
    release.resolve()
    await expect(page.locator('#topic-dialog')).not.toBeVisible()
    await expect(page.locator('#topic-title')).toHaveText('保存这一版')
    await page.locator('#edit-topic').click()
    await expect(page.locator('#topic-name-input')).toBeEnabled()
  } finally { release.resolve(); await page.unrouteAll({ behavior: 'wait' }); await app.close() }
})

test('transient import polling failure retries the same job instead of forgetting it', async ({ page }) => {
  const app = await testApp()
  let polls = 0, uploads = 0
  try {
    await topic(app, '导入重试')
    await page.goto(app.base)
    await openTopic(page, '导入重试')
    await page.route('**/api/imports', async route => { uploads++; await route.continue() })
    await page.route('**/api/imports/*', async route => {
      if (route.request().method() === 'GET' && ++polls === 1) return route.fulfill({ status: 503, json: { error: '短暂不可用' } })
      await route.continue()
    })
    await page.locator('#topic-import').click()
    await page.locator('#file').setInputFiles({ name: 'retry.txt', mimeType: 'text/plain', buffer: Buffer.from('仍在后台执行的资料解析。') })
    await expect(page.locator('#topic-documents')).toContainText('retry', { timeout: 10_000 })
    await expect(page.locator('#import-dialog')).not.toBeVisible()
    expect(uploads).toBe(1); expect(polls).toBeGreaterThan(1)
    expect(await page.evaluate(() => localStorage.getItem('classifier-import'))).toBeNull()
  } finally { await app.close() }
})

test('recovering a background import preserves the topic the user chose before reload', async ({ page }) => {
  const app = await testApp()
  const release = Promise.withResolvers()
  let polling = false
  try {
    const a = await topic(app, '正在阅读 A'), b = await topic(app, '导入目标 B')
    await page.goto(app.base)
    await openTopic(page, b.title)
    await page.route('**/api/imports/*', async route => {
      if (route.request().method() === 'GET') { polling = true; await release.promise }
      await route.continue().catch(() => {})
    })
    await page.locator('#topic-import').click()
    await page.locator('#file').setInputFiles({ name: 'background.txt', mimeType: 'text/plain', buffer: Buffer.from('归属于 B 的资料。') })
    await expect.poll(() => polling).toBe(true)
    await page.locator('#close-import').click()
    await openTopic(page, a.title)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator('#import-dialog')).toBeVisible()
    release.resolve()
    await expect(page.locator('#import-dialog')).not.toBeVisible()
    await expect(page.locator('#topic-title')).toHaveText(a.title)
    expect((await (await app.request(`/api/topics/${b.id}`)).json()).documents).toHaveLength(1)
  } finally { release.resolve(); await page.unrouteAll({ behavior: 'wait' }); await app.close() }
})

test('an old library response cannot replace newly saved bibliography in the editor', async ({ page }) => {
  const app = await testApp()
  const release = Promise.withResolvers()
  let delayed = false
  try {
    const a = await topic(app, '书目竞态')
    await app.request(`/api/topics/${a.id}/documents/${app.legacy.id}`, { method: 'PUT' })
    await page.goto(app.base)
    await openTopic(page, a.title)
    await page.route('**/api/documents', async route => {
      if (!delayed) {
        delayed = true
        const old = await route.fetch()
        await release.promise
        return route.fulfill({ response: old }).catch(() => {})
      }
      await route.continue()
    })
    await page.getByRole('button', { name: '打开研读', exact: true }).click()
    await expect.poll(() => delayed).toBe(true)
    await page.locator('#edit-document').click()
    await page.locator('#metadata-name').fill('修订后的标题')
    await page.locator('#metadata-authors').fill('新的作者')
    await page.getByRole('button', { name: '保存书目信息', exact: true }).click()
    await expect(page.locator('#metadata-dialog')).not.toBeVisible()
    release.resolve()
    await expect(page.locator('#ask')).toBeEnabled()
    await page.locator('#edit-document').click()
    await expect(page.locator('#metadata-name')).toHaveValue('修订后的标题')
    await expect(page.locator('#metadata-authors')).toHaveValue('新的作者')
  } finally { release.resolve(); await page.unrouteAll({ behavior: 'wait' }); await app.close() }
})

test('a delayed startup restore respects navigation performed while it was loading', async ({ page }) => {
  const app = await testApp()
  const release = Promise.withResolvers()
  let loading = false
  try {
    const a = await topic(app, '上次的主题')
    await app.request(`/api/topics/${a.id}/documents/${app.legacy.id}`, { method: 'PUT' })
    await page.addInitScript(saved => localStorage.setItem('classifier-workspace', JSON.stringify(saved)), { view: 'reader', topicId: a.id, documentId: app.legacy.id })
    await page.route(`**/api/topics/${a.id}`, async route => {
      loading = true; await release.promise
      await route.continue().catch(() => {})
    })
    await page.goto(app.base, { waitUntil: 'domcontentloaded' })
    await expect.poll(() => loading).toBe(true)
    await page.getByRole('button', { name: '研究主题', exact: true }).click()
    await expect(page.locator('#research-home-panel')).toBeVisible()
    release.resolve()
    await page.waitForLoadState('networkidle')
    await expect(page.locator('#research-home-panel')).toBeVisible()
    await expect(page.locator('#workspace')).not.toBeVisible()
  } finally { release.resolve(); await page.unrouteAll({ behavior: 'wait' }); await app.close() }
})

test('finishing an import does not cancel a document the user is opening', async ({ page }) => {
  const app = await testApp()
  const releaseImport = Promise.withResolvers(), releaseDocument = Promise.withResolvers()
  let polling = false, opening = false
  try {
    const a = await topic(app, '阅读与导入')
    await app.request(`/api/topics/${a.id}/documents/${app.legacy.id}`, { method: 'PUT' })
    await page.goto(app.base)
    await openTopic(page, a.title)
    await page.route('**/api/imports/*', async route => {
      polling = true; await releaseImport.promise
      await route.continue().catch(() => {})
    })
    await page.route(`**/api/documents/${app.legacy.id}`, async route => {
      opening = true; await releaseDocument.promise
      await route.continue().catch(() => {})
    })
    await page.locator('#topic-import').click()
    await page.locator('#file').setInputFiles({ name: 'another.txt', mimeType: 'text/plain', buffer: Buffer.from('另一份文献') })
    await expect.poll(() => polling).toBe(true)
    await page.locator('#close-import').click()
    await page.getByRole('button', { name: '打开研读', exact: true }).click()
    await expect.poll(() => opening).toBe(true)
    releaseImport.resolve()
    await expect(page.locator('#app-message')).toContainText('已导入 1 份文档')
    releaseDocument.resolve()
    await expect(page.locator('#workspace')).toBeVisible()
    await expect(page.locator('#title')).toHaveText(app.legacy.title)
  } finally { releaseImport.resolve(); releaseDocument.resolve(); await page.unrouteAll({ behavior: 'wait' }); await app.close() }
})
