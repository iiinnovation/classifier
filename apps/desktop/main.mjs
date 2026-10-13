import { app, protocol, session, dialog, Menu } from 'electron'
import { join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { BackendController } from './backend-controller.mjs'
import { createProtocolBridge } from './bridge.mjs'
import { createMainWindow, applicationUrl } from './window.mjs'

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }])
app.setName('Classifier')
const profile = process.argv.find(argument => argument.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length)
if (profile) { mkdirSync(resolve(profile), { recursive: true }); app.setPath('userData', resolve(profile)) }
let window, controller, quitting = false
const locked = app.requestSingleInstanceLock()
if (!locked) app.quit()
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus() } })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', event => {
    if (quitting) return
    event.preventDefault(); quitting = true
    void controller?.stop().finally(() => app.quit())
    if (!controller) app.quit()
  })
  void app.whenReady().then(async () => {
    if (quitting) return
    Menu.setApplicationMenu(Menu.buildFromTemplate([...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []), { role: 'editMenu' }, { role: 'windowMenu' }]))
    const ocrRoot = app.isPackaged ? join(process.resourcesPath, 'ocr') : join(app.getAppPath(), 'resources', 'ocr', `${process.platform}-${process.arch}`)
    controller = new BackendController({ dataDir: join(app.getPath('userData'), 'data'), ocrRoot })
    controller.on('stopped', () => {
      if (!quitting && window && !window.isDestroyed()) void dialog.showMessageBox(window, { type: 'error', title: '工作台服务已断开', message: '本地服务意外退出。已保存资料仍保留，请关闭应用后重新打开。' }).catch(() => {})
    })
    const bridge = createProtocolBridge({ backend: () => controller.connection, onError: event => console.error('Desktop request:', JSON.stringify(event)) })
    session.defaultSession.protocol.handle('app', bridge)
    await controller.start()
    if (quitting) return
    window = createMainWindow({ session: session.defaultSession })
    await window.loadURL(applicationUrl)
  }).catch(error => { if (!quitting) { dialog.showErrorBox('Classifier 启动失败', error.message); app.quit() } })
}
