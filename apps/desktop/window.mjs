import { BrowserWindow } from 'electron'
import { isApplicationUrl, applicationUrl } from './bridge.mjs'
import { fileURLToPath } from 'node:url'

export function createMainWindow({ session, show = true, sessionId = 'primary' } = {}) {
  const window = new BrowserWindow({ width: 1440, height: 1000, minWidth: 390, minHeight: 600, show, backgroundColor: '#f7f9f5', title: 'Classifier',
    webPreferences: { session, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false, preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)), additionalArguments: [`--classifier-session=${sessionId}`] },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => { if (!isApplicationUrl(url)) event.preventDefault() })
  window.webContents.on('will-redirect', (event, url) => { if (!isApplicationUrl(url)) event.preventDefault() })
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  window.webContents.session.setPermissionCheckHandler(() => false)
  return window
}
export { applicationUrl }
