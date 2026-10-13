import { createApp } from '../api/src/server.mjs'
import { createSettingsProvider } from '../api/src/settings.mjs'
import { once } from 'node:events'
import { join } from 'node:path'
import { access } from 'node:fs/promises'

if (!process.parentPort) throw new Error('Desktop backend requires a private parent channel.')
let server, started = false, stopping = false
process.parentPort.on('message', async ({ data }) => {
  if (data?.type === 'start' && !started) {
    started = true
    try {
      const executable = join(data.ocrRoot, 'bin', process.platform === 'win32' ? 'tesseract.exe' : 'tesseract')
      await access(executable)
      process.env.CLASSIFIER_TESSERACT = executable
      process.env.TESSDATA_PREFIX = join(data.ocrRoot, 'tessdata')
      process.env.CLASSIFIER_OCR_LANGS = 'chi_sim+eng'
      server = await createApp({ dataDir: data.dataDir, desktopToken: data.token, settingsProvider: createSettingsProvider() })
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
