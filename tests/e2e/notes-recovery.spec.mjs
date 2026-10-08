import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { testApp, json, upload } from '../helpers/test-app.mjs'

async function seed(app, title, contents = []) {
  const topic = await (await app.request('/api/topics', json('POST', { title, question: `${title}研究问题` }))).json()
  await app.request(`/api/topics/${topic.id}/documents/${app.legacy.id}`, { method: 'PUT' })
  const path = `/api/topics/${topic.id}/documents/${app.legacy.id}/notes`
  const notes = []
  for (const content of contents) notes.push(await (await app.request(path, json('POST', { field: '主要发现', content }))).json())
  return { topic, notes, path }
}
async function open(page, app, topic) {
  await page.goto(app.base)
  await page.getByRole('button', { name: '研究主题', exact: true }).click()
  await page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: topic.title, exact: true }) }).click()
  await page.locator('#topic-documents').getByRole('button', { name: '打开研读', exact: true }).first().click()
  await expect(page.locator('#new-note')).toBeEnabled()
  await page.locator('#notes-tab').click()
}
async function edit(page, content) {
  await page.locator('#notes-list .note-card').filter({ hasText: content }).getByRole('button', { name: '编辑', exact: true }).click()
}

test('M2 late version responses cannot replace an editor in another topic', async ({ page }) => {
  const app = await testApp(), gate = Promise.withResolvers()
  let waiting = false
  try {
    const a = await seed(app, '主题 A', ['A 初始笔记']), b = await seed(app, '主题 B', ['B 初始笔记'])
    await open(page, app, a.topic)
    await edit(page, 'A 初始笔记')
    await page.locator('#note-content').fill('A 当前草稿')
    await app.request(`/api/notes/${a.notes[0].id}`, json('PATCH', { revision: 1, content: 'A 服务端新内容' }))
    await page.locator('#save-note').click()
    await expect(page.locator('#note-load-latest')).toBeVisible()
    await page.route(`**/api/notes/${a.notes[0].id}`, async route => {
      if (route.request().method() === 'GET') { const response = await route.fetch(); waiting = true; await gate.promise; return route.fulfill({ response }).catch(() => {}) }
      await route.continue()
    })
    await page.locator('#note-load-latest').click()
    await expect.poll(() => waiting).toBe(true)
    await page.locator('#close-note').click()
    await page.getByRole('button', { name: '研究主题', exact: true }).click()
    await page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: b.topic.title, exact: true }) }).click()
    await page.locator('#topic-documents').getByRole('button', { name: '打开研读', exact: true }).click()
    await page.locator('#notes-tab').click()
    await edit(page, 'B 初始笔记')
    gate.resolve()
    await page.waitForLoadState('networkidle')
    await expect(page.locator('#note-content')).toHaveValue('B 初始笔记')
    await expect(page.locator('#note-origin')).toContainText('主题 B')
    await page.locator('#note-content').fill('以为正在编辑 B')
    await page.locator('#save-note').click()
    await expect(page.locator('#note-dialog')).not.toBeVisible()
    const savedA = await (await app.request(`/api/notes/${a.notes[0].id}`)).json()
    const savedB = await (await app.request(`/api/notes/${b.notes[0].id}`)).json()
    expect(savedA.content).toBe('A 服务端新内容')
    expect(savedB.content).toBe('以为正在编辑 B')
  } finally { gate.resolve(); await page.unrouteAll({ behavior: 'wait' }); await app.close() }
})

test('M2 drafts from different notes survive another tab saving', async ({ page, context }) => {
  const app = await testApp(), second = await context.newPage()
  try {
    const a = await seed(app, '共享草稿', ['第一条笔记', '第二条笔记'])
    await open(page, app, a.topic)
    await edit(page, '第一条笔记')
    await open(second, app, a.topic)
    await edit(second, '第二条笔记')
    await page.locator('#note-content').fill('第一标签页的新内容')
    await second.locator('#note-content').fill('第二标签页尚未保存的内容')
    const drafts = await second.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('classifier-note-draft:')).map(key => JSON.parse(localStorage.getItem(key))))
    expect(drafts.map(draft => draft.content)).toEqual(expect.arrayContaining(['第一标签页的新内容', '第二标签页尚未保存的内容']))
    await page.locator('#save-note').click()
    await expect(page.locator('#note-dialog')).not.toBeVisible()
    await second.reload()
    await expect(second.locator('#notes-list')).toContainText('第二条笔记')
    await expect(second.locator('#note-draft-notice')).toBeVisible()
    await second.locator('#resume-note-draft').click()
    await expect(second.locator('#note-content')).toHaveValue('第二标签页尚未保存的内容')
    await second.locator('#save-note').click()
    await expect(second.locator('#note-dialog')).not.toBeVisible()
    expect((await (await app.request(`/api/notes/${a.notes[1].id}`)).json()).content).toBe('第二标签页尚未保存的内容')
  } finally { await second.close(); await app.close() }
})

test('M2 lost creation response recovers a revision without losing corrections', async ({ page }) => {
  const app = await testApp()
  let loseResponse = true
  try {
    const a = await seed(app, '保存恢复')
    await open(page, app, a.topic)
    await page.route(`**${a.path}`, async route => {
      if (route.request().method() === 'POST' && loseResponse) { loseResponse = false; await route.fetch(); return route.abort('failed') }
      await route.continue()
    })
    await page.locator('#new-note').click()
    await page.locator('#note-content').fill('首次提交内容')
    await page.locator('#save-note').click()
    await expect(page.locator('#note-error')).not.toBeEmpty()
    await page.locator('#note-content').fill('失败后补充的修订')
    await page.locator('#save-note').click()
    await expect(page.locator('#note-dialog')).not.toBeVisible()
    await page.reload()
    await edit(page, '失败后补充的修订')
    await expect(page.locator('#note-dialog-title')).toHaveText('编辑阅读笔记')
    await expect(page.locator('#note-content')).toHaveValue('失败后补充的修订')
    expect((await (await app.request(a.path)).json()).notes).toHaveLength(1)
  } finally { await app.close() }
})

test('M2 failed document navigation preserves the current notebook', async ({ page }) => {
  const app = await testApp()
  try {
    const a = await seed(app, '文献切换', ['原文献的笔记'])
    const other = await (await app.request('/api/documents', upload('# 加载失败文献\n\n文献内容', 'failure.md'))).json()
    await open(page, app, a.topic)
    await expect(page.locator('#notes-list .note-card')).toHaveCount(1)
    await page.route(`**/api/documents/${other.id}`, route => route.fulfill({ status: 503, json: { error: '文献暂时无法加载' } }))
    await page.locator('#library-toggle').click()
    await page.locator('#documents .doc-item').filter({ hasText: '加载失败文献' }).click()
    await expect(page.locator('#app-message')).toContainText('文献暂时无法加载')
    await page.locator('#close-library').click()
    await expect(page.locator('#title')).toHaveText(app.legacy.title)
    await expect(page.locator('#notes-list .note-card')).toHaveCount(1)
    await expect(page.locator('#new-note')).toBeEnabled()
    await edit(page, '原文献的笔记')
    await page.locator('#note-content').fill('仍可编辑原文献的笔记')
    await page.locator('#save-note').click()
    await expect(page.locator('#note-dialog')).not.toBeVisible()
    await expect(page.locator('#notes-list')).toContainText('仍可编辑原文献的笔记')
    expect((await (await app.request(a.path)).json()).notes).toHaveLength(1)
  } finally { await app.close() }
})

test('M2 the same note keeps independent drafts in two tabs', async ({ page, context }) => {
  const app = await testApp(), second = await context.newPage()
  try {
    const a = await seed(app, '同一笔记', ['共同的初始内容'])
    await open(page, app, a.topic)
    await edit(page, '共同的初始内容')
    await page.locator('#note-content').fill('标签页一的独立草稿')
    await open(second, app, a.topic)
    await edit(second, '共同的初始内容')
    await expect(second.locator('#note-content')).toHaveValue('共同的初始内容')
    await second.locator('#note-content').fill('标签页二的独立草稿')
    await page.reload()
    await page.locator('#resume-note-draft').click()
    await expect(page.locator('#note-content')).toHaveValue('标签页一的独立草稿')
    await page.locator('#save-note').click()
    await expect(page.locator('#note-dialog')).not.toBeVisible()
    await second.reload()
    await second.locator('#resume-note-draft').click()
    await expect(second.locator('#note-content')).toHaveValue('标签页二的独立草稿')
    await second.locator('#save-note').click()
    await expect(second.locator('#note-error')).toContainText('其他页面修改')
    await expect(second.locator('#note-content')).toHaveValue('标签页二的独立草稿')
    expect((await (await app.request(`/api/notes/${a.notes[0].id}`)).json()).content).toBe('标签页一的独立草稿')
  } finally { await second.close(); await app.close() }
})

test('M2 typing while a version is loading invalidates that response', async ({ page }) => {
  const app = await testApp(), gate = Promise.withResolvers()
  let waiting = false
  try {
    const a = await seed(app, '加载时继续编辑', ['初始内容'])
    await open(page, app, a.topic)
    await edit(page, '初始内容')
    await page.locator('#note-content').fill('本地修订')
    await app.request(`/api/notes/${a.notes[0].id}`, json('PATCH', { revision: 1, content: '已保存的新版本' }))
    await page.locator('#save-note').click()
    await expect(page.locator('#note-load-latest')).toBeVisible()
    await page.route(`**/api/notes/${a.notes[0].id}`, async route => {
      if (route.request().method() === 'GET') { const response = await route.fetch(); waiting = true; await gate.promise; return route.fulfill({ response }).catch(() => {}) }
      await route.continue()
    })
    await page.locator('#note-load-latest').click()
    await expect.poll(() => waiting).toBe(true)
    await page.locator('#note-content').fill('加载期间继续输入的内容')
    gate.resolve()
    await page.waitForLoadState('networkidle')
    await expect(page.locator('#note-content')).toHaveValue('加载期间继续输入的内容')
    await expect(page.locator('#note-load-latest')).toBeEnabled()
  } finally { gate.resolve(); await page.unrouteAll({ behavior: 'wait' }); await app.close() }
})

test('M2 an unversioned draft resumes editing after an uncertain creation and reload', async ({ page }) => {
  const app = await testApp()
  let loseResponse = true
  try {
    const a = await seed(app, '无法立即确认创建')
    await open(page, app, a.topic)
    await page.route(`**${a.path}`, async route => {
      if (route.request().method() === 'POST' && loseResponse) { loseResponse = false; await route.fetch(); return route.abort('failed') }
      await route.continue()
    })
    await page.route('**/api/notes/*', route => route.request().method() === 'GET' ? route.fulfill({ status: 503, json: { error: '暂时无法确认' } }) : route.continue())
    await page.locator('#new-note').click()
    await page.locator('#note-content').fill('创建已落库的内容')
    await page.locator('#save-note').click()
    await expect(page.locator('#note-error')).not.toBeEmpty()
    await page.locator('#note-content').fill('网络恢复后的补充内容')
    await page.locator('#save-note').click()
    await expect(page.locator('#note-error')).toContainText('笔记已存在')
    await expect(page.locator('#note-load-latest')).toBeVisible()
    await page.locator('#close-note').click()
    await page.reload()
    await edit(page, '创建已落库的内容')
    await expect(page.locator('#note-dialog-title')).toHaveText('编辑阅读笔记')
    await expect(page.locator('#note-content')).toHaveValue('网络恢复后的补充内容')
    await page.locator('#save-note').click()
    await expect(page.locator('#note-dialog')).not.toBeVisible()
    const notes = (await (await app.request(a.path)).json()).notes
    expect(notes).toHaveLength(1)
    expect(notes[0].content).toBe('网络恢复后的补充内容')
  } finally { await app.close() }
})

test('M2 old single-draft records remain recoverable during draft migration', async ({ page }) => {
  const app = await testApp()
  try {
    const a = await seed(app, '旧草稿恢复')
    await open(page, app, a.topic)
    const document = await (await app.request(`/api/documents/${app.legacy.id}`)).json()
    const key = `classifier-note-draft:${a.topic.id}:${app.legacy.id}`
    const draft = { id: randomUUID(), field: '主要发现', content: '旧版本保留的草稿内容', kind: 'user', status: 'recorded', origin: { type: 'manual' }, referenceIds: [], evidence: [], replaceEvidence: true, documentVersion: document.evidenceVersion, dirty: true, context: { topic: { id: a.topic.id, title: a.topic.title }, document: { id: app.legacy.id, evidenceVersion: document.evidenceVersion } } }
    await page.evaluate(({ key, draft }) => localStorage.setItem(key, JSON.stringify(draft)), { key, draft })
    await page.reload()
    await page.locator('#resume-note-draft').click()
    await expect(page.locator('#note-content')).toHaveValue(draft.content)
    await page.locator('#save-note').click()
    await expect(page.locator('#note-dialog')).not.toBeVisible()
    expect(await page.evaluate(key => localStorage.getItem(key), key)).toBeNull()
    await expect(page.locator('#note-draft-notice')).not.toBeVisible()
    expect((await (await app.request(a.path)).json()).notes[0].content).toBe(draft.content)
  } finally { await app.close() }
})
