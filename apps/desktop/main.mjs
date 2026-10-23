import { app, protocol, session, dialog, Menu } from 'electron'
import { join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { BackendController } from './backend-controller.mjs'
import { createProtocolBridge } from './bridge.mjs'
import { createMainWindow, applicationUrl } from './window.mjs'
import { selectedLibrary, libraryScope, createLibraryManager } from './library-manager.mjs'
import { runMaintenance } from './maintenance-process.mjs'
import { libraryMenu } from './library-menu.mjs'

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }])
app.setName('Classifier')
const profile = process.argv.find(argument => argument.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length)
if (profile) { mkdirSync(resolve(profile), { recursive: true }); app.setPath('userData', resolve(profile)) }
let window, controller, manager, maintenanceMenu, quitting = false, maintaining = false, shownDirectory
const locked = app.requestSingleInstanceLock()
if (!locked) app.quit()
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus() } })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', event => {
    if (quitting) return
    event.preventDefault(); quitting = true
    void (async () => { await maintenanceMenu?.idle(); await manager?.idle(); await controller?.stop() })().finally(() => app.quit())
  })
  void app.whenReady().then(async () => {
    if (quitting) return
    const profileRoot = app.getPath('userData')
    const ocrRoot = app.isPackaged ? join(process.resourcesPath, 'ocr') : join(app.getAppPath(), 'resources', 'ocr', `${process.platform}-${process.arch}`)
    controller = new BackendController({ dataDir: await selectedLibrary(profileRoot), ocrRoot })
    controller.on('stopped', () => {
      if (!quitting && !maintaining && window && !window.isDestroyed()) void dialog.showMessageBox(window, { type: 'error', title: '工作台服务已断开', message: '本地服务意外退出。已保存资料仍保留，请关闭应用后重新打开。' }).catch(() => {})
    })
    const bridge = createProtocolBridge({ backend: () => !maintaining && shownDirectory === controller.dataDir ? controller.connection : null, onError: event => console.error('Desktop request:', JSON.stringify(event)) })
    session.defaultSession.protocol.handle('app', bridge)
    manager = createLibraryManager({ profile: profileRoot, controller, run: runMaintenance, onBusy: value => {
      maintaining = value
      if (window && !window.isDestroyed()) { window.setEnabled(!value); window.setTitle(value ? 'Classifier · 正在维护资料库，请等待…' : 'Classifier'); window.setProgressBar(value ? 2 : -1) }
    }, onProgress: progress => {
      if (!maintaining || !window || window.isDestroyed()) return
      const phases = { preparing: '正在检查并备份', prepared: '迁移已准备', 'safety-backup': '正在备份当前资料库', validated: '已校验迁移批次', records: '正在迁移记录', 'file-published': '正在迁移原文件', files: '正在迁移原文件', publishing: '正在发布资料库', published: '正在完成迁移', complete: '迁移完成' }
      const total = (progress.totalRecords || 0) + (progress.totalFiles || 0)
      const done = (progress.completedRecords || 0) + (progress.completedFiles || 0)
      window.setTitle(`Classifier · ${phases[progress.phase] || '正在迁移'}${total ? ` · ${done}/${total}` : ''}`)
      window.setProgressBar(progress.phase === 'complete' ? 1 : total ? done / total : 2)
    } })
    async function showLibrary() {
      if (quitting || !controller.connection) return
      if (window && shownDirectory === controller.dataDir) { await window.loadURL(applicationUrl); return }
      const previous = window
      const next = createMainWindow({ session: session.defaultSession, show: false, libraryId: libraryScope(profileRoot, controller.dataDir) })
      // Retire the old renderer before exposing the new backend to the bridge.
      // The new window exists first, so window-all-closed cannot quit the app.
      window = next; previous?.destroy(); shownDirectory = controller.dataDir
      await next.loadURL(applicationUrl)
      next.show()
    }
    maintenanceMenu = libraryMenu({ dialog, manager, currentDirectory: () => controller.dataDir, getWindow: () => window, migrationHome: join(profileRoot, 'libraries'), closing: () => quitting,
      afterOperation: showLibrary,
      async saveChecklist(result) {
        const choice = await dialog.showSaveDialog(window, { title: '保存检查清单', defaultPath: 'Classifier-library-check.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
        if (!choice.canceled && choice.filePath) await writeFile(choice.filePath, JSON.stringify(result, null, 2), { mode: 0o600 })
      },
    })
    Menu.setApplicationMenu(Menu.buildFromTemplate([...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []), maintenanceMenu.template, { role: 'editMenu' }, { role: 'windowMenu' }]))
    await controller.start()
    if (quitting) return
    await showLibrary()
  }).catch(async error => {
    if (quitting) return
    await controller?.stop()
    if (controller) {
      const choice = await dialog.showMessageBox({ type: 'error', title: 'Classifier 启动失败', message: error.message,
        detail: '可检查当前资料库并保存问题清单。检查不会删除或修复研究资料。', buttons: ['退出', '检查并保存清单…'], defaultId: 0, cancelId: 0 })
      if (choice.response === 1) {
        try {
          const result = await runMaintenance('inspect', { source: controller.dataDir })
          const destination = await dialog.showSaveDialog({ title: '保存资料库检查清单', defaultPath: 'Classifier-library-check.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
          if (!destination.canceled && destination.filePath) await writeFile(destination.filePath, JSON.stringify(result, null, 2), { mode: 0o600 })
        } catch (inspectionError) { dialog.showErrorBox('资料库检查未完成', inspectionError.message) }
      }
    } else dialog.showErrorBox('Classifier 启动失败', error.message)
    app.quit()
  })
}
