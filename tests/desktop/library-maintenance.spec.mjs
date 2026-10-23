import { test, expect } from '../helpers/desktop-application.mjs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

test('D1 desktop menu checks backs up and restores into an isolated library', async ({ desktop }) => {
  const { application, page, profile } = desktop
  const topic = await page.evaluate(async () => (await fetch('/api/topics', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '备份时的主题', question: '主题研究问题' }) })).json())
  await application.evaluate(({ dialog }, profile) => {
    globalThis.maintenanceMessages = []
    globalThis.maintenanceChoice = profile
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [globalThis.maintenanceChoice] })
    dialog.showMessageBox = async (_window, options) => {
      globalThis.maintenanceMessages.push(options)
      return { response: options.buttons?.includes('继续') ? 1 : 0 }
    }
  }, profile)
  async function click(label) {
    await application.evaluate(({ Menu }, label) => {
      const menu = Menu.getApplicationMenu().items.find(item => item.label === '资料库')
      menu.submenu.items.find(item => item.label === label).click()
    }, label)
  }
  await click('检查当前资料库…')
  await expect.poll(() => application.evaluate(() => globalThis.maintenanceMessages.some(item => item.title === '资料库检查结果'))).toBe(true)
  await click('创建目录备份…')
  await expect.poll(() => application.evaluate(() => globalThis.maintenanceMessages.find(item => item.message === '备份已完成并通过校验')?.detail)).toBeTruthy()
  const backup = await application.evaluate(() => globalThis.maintenanceMessages.find(item => item.message === '备份已完成并通过校验').detail)
  await page.evaluate(async id => fetch('/api/topics/' + id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '备份之后的修改' }) }), topic.id)
  await page.evaluate(id => localStorage.setItem(`classifier-desktop-session:v1:primary:classifier-report-draft:${id}`, 'old draft'), topic.id)
  await application.evaluate((_electron, backup) => { globalThis.maintenanceChoice = backup }, backup)
  const opened = application.waitForEvent('window')
  await click('从目录备份恢复…')
  const restoredPage = await opened
  await expect(restoredPage.locator('#new-topic')).toBeVisible()
  await expect.poll(() => application.evaluate(() => globalThis.maintenanceMessages.some(item => item.message === '已打开恢复后的资料库'))).toBe(true)
  expect(await restoredPage.evaluate(async id => (await (await fetch('/api/topics/' + id)).json()).title, topic.id)).toBe('备份时的主题')
  expect(await restoredPage.evaluate(() => globalThis.classifierDesktop.libraryId)).toBeTruthy()
  const original = JSON.parse(await readFile(join(profile, 'data/topics', topic.id + '.json'), 'utf8'))
  expect(original.title).toBe('备份之后的修改')
  const selected = JSON.parse(await readFile(join(profile, 'library-selection.json'), 'utf8'))
  expect(selected.path).not.toBe(join(profile, 'data'))
  expect(await restoredPage.evaluate(id => localStorage.getItem(`classifier-desktop-session:v1:primary:classifier-report-draft:${id}`), topic.id)).toBe('old draft')
  expect(await application.evaluate(() => globalThis.maintenanceMessages.filter(item => item.type === 'error'))).toEqual([])
})

test('D1 migration menu upgrades JSON and shows completed progress without rewriting it', async ({ desktop }) => {
  const { application, page, profile } = desktop
  const topic = await page.evaluate(async () => (await fetch('/api/topics', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '迁移主题', question: '迁移保留研究内容' }) })).json())
  await application.evaluate(({ dialog }) => {
    globalThis.migrationMessages = []
    dialog.showMessageBox = async (_window, options) => { globalThis.migrationMessages.push(options); return { response: options.buttons?.includes('继续') ? 1 : 0 } }
  })
  const opened = application.waitForEvent('window')
  await application.evaluate(({ Menu }) => {
    Menu.getApplicationMenu().items.find(item => item.label === '资料库').submenu.items.find(item => item.label === '升级当前 JSON 资料库…').click()
  })
  const migratedPage = await opened
  await expect(migratedPage.locator('#new-topic')).toBeVisible()
  await expect.poll(() => application.evaluate(() => globalThis.migrationMessages.some(item => item.message === '资料库升级完成'))).toBe(true)
  expect(await migratedPage.evaluate(async id => (await (await fetch('/api/topics/' + id)).json()).title, topic.id)).toBe('迁移主题')
  const selection = JSON.parse(await readFile(join(profile, 'library-selection.json'), 'utf8'))
  const manifest = JSON.parse(await readFile(join(selection.path, 'library-manifest.json'), 'utf8'))
  expect(manifest.storage).toBe('sqlite'); expect(manifest.state).toBe('ready')
  expect(JSON.parse(await readFile(join(profile, 'data/topics', topic.id + '.json'), 'utf8')).title).toBe('迁移主题')
  await application.evaluate(({ dialog, Menu }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    Menu.getApplicationMenu().items.find(item => item.label === '资料库').submenu.items.find(item => item.label === '查看迁移进度或继续迁移…').click()
  }, selection.path)
  await expect.poll(() => application.evaluate(() => globalThis.migrationMessages.find(item => item.title === '迁移进度')?.message)).toBe('已完成')
  expect(await application.evaluate(() => globalThis.migrationMessages.filter(item => item.type === 'error'))).toEqual([])
})
