import { createApp } from '../api/src/server.mjs'
import { createSettingsProvider } from '../api/src/settings.mjs'
import { once } from 'node:events'
import { join } from 'node:path'
import { access } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { HttpError } from '../api/src/http.mjs'
import { createPersistentSettingsProvider } from './persistent-settings-provider.mjs'

if (!process.parentPort) throw new Error('Desktop backend requires a private parent channel.')
let server, started = false, stopping = false
const settingRequests = new Map()
function requestSetting(action, value) {
  const id = randomUUID(), pending = Promise.withResolvers()
  settingRequests.set(id, pending)
  process.parentPort.postMessage({ type: 'model-settings-request', id, action, ...value })
  return pending.promise
}
process.parentPort.on('message', async ({ data }) => {
  if (data?.type === 'model-settings-result') {
    const pending = settingRequests.get(data.id); settingRequests.delete(data.id)
    if (data.error) pending?.reject(new HttpError(data.status || 503, data.error))
    else pending?.resolve(data.value)
  }
  if (data?.type === 'start' && !started) {
    started = true
    try {
      const executable = join(data.ocrRoot, 'bin', process.platform === 'win32' ? 'tesseract.exe' : 'tesseract')
      await access(executable)
      process.env.CLASSIFIER_TESSERACT = executable
      process.env.TESSDATA_PREFIX = join(data.ocrRoot, 'tessdata')
      process.env.CLASSIFIER_OCR_LANGS = 'chi_sim+eng'
      const settingsProvider = data.modelSettings ? createPersistentSettingsProvider(data.modelSettings, requestSetting) : createSettingsProvider()
      server = await createApp({ dataDir: data.dataDir, managedBackupDir: data.managedBackupDir, desktopToken: data.token, settingsProvider })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      process.parentPort.postMessage({ type: 'ready', port: server.address().port, pid: process.pid, versions: { node: process.versions.node, electron: process.versions.electron } })
    } catch (error) {
      process.parentPort.postMessage({ type: 'startup-error', message: `本地服务启动失败：${error.message}` })
      process.exitCode = 1
      setTimeout(() => process.exit(1), 50)
    }
  }
  if (data?.type === 'stop' && !stopping) {
    stopping = true
    try { await server?.shutdown() }
    finally { process.parentPort.postMessage({ type: 'stopped' }); process.exit(0) }
  }
})
process.parentPort.postMessage({ type: 'booted' })
