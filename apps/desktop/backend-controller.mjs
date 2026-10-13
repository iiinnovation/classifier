import { utilityProcess } from 'electron'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'

export class BackendController extends EventEmitter {
  constructor({ dataDir, ocrRoot }) { super(); this.dataDir = dataDir; this.ocrRoot = ocrRoot; this.child = null; this.connection = null }
  async start() {
    if (this.child) throw new Error('Backend is already running.')
    const token = randomBytes(32).toString('hex')
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith('CLASSIFIER_') || ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'].includes(key)) delete env[key]
    const child = utilityProcess.fork(fileURLToPath(new URL('./backend.mjs', import.meta.url)), [], { env, serviceName: 'Classifier Backend', stdio: 'pipe' })
    this.child = child
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', () => {})
    return new Promise((resolve, reject) => {
      let ready = false
      const timer = setTimeout(() => { child.kill(); reject(new Error('本地服务启动超过 30 秒。')) }, 30000)
      child.on('message', data => {
        if (data?.type === 'booted') child.postMessage({ type: 'start', token, dataDir: this.dataDir, ocrRoot: this.ocrRoot })
        if (data?.type === 'startup-error') { clearTimeout(timer); reject(new Error(data.message)) }
        if (data?.type === 'ready' && !ready) {
          ready = true; clearTimeout(timer)
          this.connection = { port: data.port, token }
          this.info = { pid: data.pid, port: data.port, versions: data.versions }
          this.emit('ready', this.info); resolve(this.info)
        }
      })
      child.once('exit', code => {
        clearTimeout(timer)
        if (this.child === child) { this.child = null; this.connection = null }
        if (!ready) reject(new Error(`本地服务提前退出（${code}）。`))
        this.emit('stopped', code)
      })
    })
  }
  async stop() {
    const child = this.child
    if (!child) return
    await new Promise(resolve => {
      const timer = setTimeout(() => child.kill(), 15000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
      child.postMessage({ type: 'stop' })
    })
  }
}
