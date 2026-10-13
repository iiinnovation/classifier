// Test-only entrypoint: excluded from packaged application files.
import { app, protocol, session } from 'electron'
import { createProtocolBridge } from '../../apps/desktop/bridge.mjs'
import { createMainWindow } from '../../apps/desktop/window.mjs'

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }])
app.setPath('userData', process.argv[2])
let backend = null
const windows = new Set()
void app.whenReady().then(() => {
  const downloads = []
  session.defaultSession.protocol.handle('app', createProtocolBridge({ backend: () => backend, fetchImpl: async (url, options, request) => {
    const control = backend.control
    const response = await fetch(`http://127.0.0.1:${control.port}/bridge`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-control': control.token }, body: JSON.stringify({ url, method: options.method, headers: options.headers, body: options.body ? options.body.toString('base64') : null, page: request.headers.get('x-classifier-test-page') }), signal: options.signal })
    const value = await response.json()
    if (!response.ok || value.aborted) throw new Error(value.error || 'Test network abort')
    return new Response([204, 205, 304].includes(value.status) ? null : Buffer.from(value.body, 'base64'), { status: value.status, headers: value.headers })
  } }))
  session.defaultSession.on('will-download', (_event, item) => {
    item.once('done', (_event, state) => downloads.push({ filename: item.getFilename(), path: item.getSavePath(), state }))
  })
  function createWindow(sessionId) {
    const window = createMainWindow({ session: session.defaultSession, sessionId })
    windows.add(window)
    window.on('closed', () => windows.delete(window))
    void window.loadURL('about:blank')
    return window
  }
  globalThis.classifierTest = {
    configure(value) { backend = value },
    createWindow,
    downloads,
  }
  createWindow('primary')
  app.on('window-all-closed', () => app.quit())
})
