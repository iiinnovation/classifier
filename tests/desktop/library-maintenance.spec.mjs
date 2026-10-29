import { test, expect } from '../helpers/desktop-application.mjs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

for (const format of ['directory', 'zip']) test(`D1 desktop menu checks ${format} backs up and restores into an isolated library`, async ({ desktop }) => {
  const { application, page, profile } = desktop
  const topic = await page.evaluate(async () => (await fetch('/api/topics', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '备份时的主题', question: '主题研究问题' }) })).json())
  await application.evaluate(({ dialog }, profile) => {
    globalThis.maintenanceMessages = []
    globalThis.maintenanceChoice = profile
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [globalThis.maintenanceChoice] })
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: profile + '/backup.zip' })
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
  await click(format === 'zip' ? '导出 ZIP 备份…' : '创建目录备份…')
  const backupMessage = format === 'zip' ? 'ZIP 备份已完成并通过校验' : '备份已完成并通过校验'
  await expect.poll(() => application.evaluate((_electron, message) => globalThis.maintenanceMessages.find(item => item.message === message)?.detail, backupMessage)).toBeTruthy()
  const backup = await application.evaluate((_electron, message) => globalThis.maintenanceMessages.find(item => item.message === message).detail, backupMessage)
  await page.evaluate(async id => fetch('/api/topics/' + id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '备份之后的修改' }) }), topic.id)
  await page.evaluate(id => localStorage.setItem(`classifier-desktop-session:v1:primary:classifier-report-draft:${id}`, 'old draft'), topic.id)
  await application.evaluate((_electron, backup) => { globalThis.maintenanceChoice = backup }, backup)
  const opened = application.waitForEvent('window')
  await click(format === 'zip' ? '从 ZIP 备份恢复…' : '从目录备份恢复…')
  const restoredPage = await opened
  await expect(restoredPage.locator('#new-topic')).toBeVisible()
  await expect.poll(() => application.evaluate((_electron, message) => globalThis.maintenanceMessages.some(item => item.message === message), format === 'zip' ? '已打开 ZIP 恢复后的资料库' : '已打开恢复后的资料库')).toBe(true)
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

for (const format of ['directory', 'zip']) test(`D1 selectively recovers damaged records from ${format} while preserving newer research`, async ({ desktop }, testInfo) => {
  const { application, page, profile } = desktop
  const topics = await page.evaluate(async () => {
    const create = async title => (await fetch('/api/topics', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, question: '选择性恢复研究资料' }) })).json()
    return { damaged: await create('待恢复主题'), healthy: await create('另一项研究') }
  })
  await application.evaluate(({ dialog }, profile) => {
    globalThis.recoveryMessages = []; globalThis.recoveryChoice = profile; globalThis.recoveryFormat = 'directory'
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [globalThis.recoveryChoice] })
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: profile + '/recovery-backup.zip' })
    dialog.showMessageBox = async (_window, options) => {
      globalThis.recoveryMessages.push(options)
      if (options.message === '选择恢复来源') return { response: globalThis.recoveryFormat === 'zip' ? 2 : 1 }
      if (options.title === '选择恢复版本') return { response: 1 }
      return { response: options.buttons?.includes('继续') ? 1 : 0 }
    }
  }, profile)
  const click = label => application.evaluate(({ Menu }, label) => Menu.getApplicationMenu().items.find(item => item.label === '资料库').submenu.items.find(item => item.label === label).click(), label)
  await click(format === 'zip' ? '导出 ZIP 备份…' : '创建目录备份…')
  const backupMessage = format === 'zip' ? 'ZIP 备份已完成并通过校验' : '备份已完成并通过校验'
  await expect.poll(() => application.evaluate((_electron, message) => globalThis.recoveryMessages.find(item => item.message === message)?.detail, backupMessage)).toBeTruthy()
  const backup = await application.evaluate((_electron, message) => globalThis.recoveryMessages.find(item => item.message === message).detail, backupMessage)
  await page.evaluate(async id => fetch('/api/topics/' + id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '备份之后的新修改' }) }), topics.healthy.id)
  const damagedPath = join(profile, 'data/topics', topics.damaged.id + '.json'), damagedBytes = '{原始损坏内容'
  await writeFile(damagedPath, damagedBytes)
  await page.reload()
  await expect(page.locator('#library-health')).toBeVisible()
  await expect(page.locator('#library-health-summary')).toContainText('1 项资料')
  await expect(page.locator('#topic-cards')).toContainText('备份之后的新修改')
  await page.locator('#library-health summary').click()
  await expect(page.locator('#library-health-items')).toContainText('保全副本已保存')
  await page.screenshot({ path: testInfo.outputPath('damaged-library-notice.png'), fullPage: true })
  await application.evaluate((_electron, state) => { globalThis.recoveryChoice = state.backup; globalThis.recoveryFormat = state.format }, { backup, format })
  const opened = application.waitForEvent('window')
  await click('选择性恢复损坏资料…')
  const repaired = await opened
  await expect(repaired.locator('#topic-cards')).toContainText('待恢复主题')
  await expect(repaired.locator('#topic-cards')).toContainText('备份之后的新修改')
  await expect(repaired.locator('#library-health')).toBeHidden()
  await expect.poll(() => application.evaluate(() => globalThis.recoveryMessages.some(item => item.message === '所选资料已恢复并打开新库'))).toBe(true)
  expect(await readFile(damagedPath, 'utf8')).toBe(damagedBytes)
  const final = await application.evaluate(() => globalThis.recoveryMessages.find(item => item.message === '所选资料已恢复并打开新库').detail)
  const preserved = final.split('当前原件保全：')[1]
  expect(await readFile(join(preserved, 'topics', topics.damaged.id + '.json'), 'utf8')).toBe(damagedBytes)
  expect(await application.evaluate(() => globalThis.recoveryMessages.filter(item => item.type === 'error'))).toEqual([])
  await repaired.screenshot({ path: testInfo.outputPath('selective-recovery-complete.png'), fullPage: true })
})

test('D1 startup compatibility flow refuses a future library then restores a snapshot through real utility processes', async ({ desktop }, testInfo) => {
  const verification = await desktop.application.evaluate(async ({ app }, profile) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    const { join } = require('node:path'), { randomUUID } = require('node:crypto'), { readFile, writeFile } = require('node:fs/promises')
    const { createStore } = require(app.getAppPath() + '/apps/api/src/store.mjs')
    const { backupLibrary } = require(app.getAppPath() + '/apps/api/src/storage-maintenance.mjs')
    const { createLibraryManager, selectedLibrary } = require(app.getAppPath() + '/apps/desktop/library-manager.mjs')
    const { recoverStartup } = require(app.getAppPath() + '/apps/desktop/startup-recovery.mjs')
    const { runMaintenance } = require(app.getAppPath() + '/apps/desktop/maintenance-process.mjs')
    const { BackendController } = require(app.getAppPath() + '/apps/desktop/backend-controller.mjs')
    const source = join(profile, 'future-library'), backup = join(profile, 'compatible-backup'), id = randomUUID(), jobId = randomUUID(), createdAt = new Date().toISOString()
    const store = await createStore(source)
    await store.write('topics', { id, title: 'compatible snapshot', question: 'Can recovery preserve the newer library?', documents: [], createdAt })
    await store.write('runs', { id: jobId, status: 'running', createdAt })
    await backupLibrary(source, backup)
    await store.write('topics', { id, title: 'newer work in future library', question: 'Research', documents: [], createdAt })
    const manifest = JSON.stringify({ formatVersion: 99, storage: 'sqlite', state: 'ready', recordVersion: 99 })
    await writeFile(join(source, 'library-manifest.json'), manifest)
    const ocrRoot = app.isPackaged ? join(process.resourcesPath, 'ocr') : join(app.getAppPath(), 'resources/ocr', process.platform + '-' + process.arch)
    const controller = new BackendController({ dataDir: source, ocrRoot }), messages = []
    const manager = createLibraryManager({ profile: join(profile, 'recovered-profile'), controller, run: runMaintenance })
    // Parent directory must exist before committing its selected library.
    await require('node:fs/promises').mkdir(join(profile, 'recovered-profile'), { recursive: true })
    let startupError
    try { await controller.start() } catch (error) { startupError = error }
    await controller.stop()
    if (!startupError) throw new Error('Future library was unexpectedly opened')
    const responses = [3, 1, 1, 0]
    try {
      const opened = await recoverStartup({ error: startupError, controller, manager, run: runMaintenance, dialog: {
        async showMessageBox(options) { messages.push(options); return { response: responses.shift() ?? 0 } },
        async showOpenDialog() { return { canceled: false, filePaths: [backup] } },
      } })
      const { port, token } = controller.connection
      const response = await fetch('http://127.0.0.1:' + port + '/api/topics/' + id, { headers: { origin: 'app://classifier', 'x-classifier-instance': token } })
      const read = await response.json()
      return { packaged: app.isPackaged, opened, status: response.status, title: read.title, originalManifestIntact: await readFile(join(source, 'library-manifest.json'), 'utf8') === manifest, originalTaskState: JSON.parse(await readFile(join(source, 'runs', jobId + '.json'), 'utf8')).status, selected: await selectedLibrary(join(profile, 'recovered-profile')), current: controller.dataDir, cutoffExplained: messages.some(item => item.detail?.includes('备份时点：') && item.detail?.includes('不会合并')), runtime: controller.info.versions }
    } finally { await controller.stop() }
  }, desktop.profile)
  expect(verification.opened).toBe(true); expect(verification.status).toBe(200); expect(verification.title).toBe('compatible snapshot')
  expect(verification.originalManifestIntact).toBe(true); expect(verification.originalTaskState).toBe('running'); expect(verification.selected).toBe(verification.current); expect(verification.cutoffExplained).toBe(true)
  await writeFile(testInfo.outputPath('startup-compatibility.json'), JSON.stringify(verification, null, 2) + '\n')
})

test('D1 rebuild menu migrates the chosen pre-upgrade snapshot and preserves newer current edits', async ({ desktop }) => {
  const { application, page, profile } = desktop
  const topic = await page.evaluate(async () => (await fetch('/api/topics', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '准备失败前的备份时点', question: '重新准备迁移' }) })).json())
  await application.evaluate(({ dialog }, profile) => {
    globalThis.preparationMessages = []; globalThis.preparationChoice = profile
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [globalThis.preparationChoice] })
    dialog.showMessageBox = async (_window, options) => { globalThis.preparationMessages.push(options); return { response: options.buttons?.includes('继续') ? 1 : 0 } }
  }, profile)
  const click = label => application.evaluate(({ Menu }, label) => Menu.getApplicationMenu().items.find(item => item.label === '资料库').submenu.items.find(item => item.label === label).click(), label)
  await click('创建目录备份…')
  await expect.poll(() => application.evaluate(() => globalThis.preparationMessages.find(item => item.message === '备份已完成并通过校验')?.detail)).toBeTruthy()
  const backup = await application.evaluate(() => globalThis.preparationMessages.find(item => item.message === '备份已完成并通过校验').detail)
  await page.evaluate(async id => fetch('/api/topics/' + id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '准备失败之后的新修改' }) }), topic.id)
  await application.evaluate((_electron, backup) => { globalThis.preparationChoice = backup }, backup)
  const opened = application.waitForEvent('window'); await click('从升级前备份重新准备迁移…')
  const migrated = await opened
  await expect(migrated.locator('#topic-cards')).toContainText('准备失败前的备份时点')
  await expect.poll(() => application.evaluate(() => globalThis.preparationMessages.some(item => item.message === '已从升级前备份重建并打开迁移库'))).toBe(true)
  expect(JSON.parse(await readFile(join(profile, 'data/topics', topic.id + '.json'), 'utf8')).title).toBe('准备失败之后的新修改')
  const detail = await application.evaluate(() => globalThis.preparationMessages.find(item => item.message === '已从升级前备份重建并打开迁移库').detail)
  const safety = detail.split('切换前备份：')[1]
  expect(JSON.parse(await readFile(join(safety, 'topics', topic.id + '.json'), 'utf8')).title).toBe('准备失败之后的新修改')
  expect(await application.evaluate(() => globalThis.preparationMessages.filter(item => item.type === 'error'))).toEqual([])
})
