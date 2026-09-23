import { Worker } from 'node:worker_threads'
import { randomUUID, createHash } from 'node:crypto'
import { basename } from 'node:path'
import { HttpError } from './http.mjs'

export function parseInWorker(upload, { mode = 'auto', signal, onProgress = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./parse-worker.mjs', import.meta.url), { workerData: { ...upload, mode } })
    let done = false
    const finish = (error, value) => {
      if (done) return
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
      if (error) {
        worker.postMessage({ type: 'cancel' })
        const grace = setTimeout(() => { void worker.terminate() }, 1500)
        worker.once('message', message => { if (message.type === 'error' || message.type === 'result') { clearTimeout(grace); void worker.terminate() } })
        worker.once('exit', () => clearTimeout(grace))
      } else void worker.terminate()
      error ? reject(error) : resolve(value)
    }
    const abort = () => finish(signal.reason || new Error('解析已取消'))
    const timer = setTimeout(() => finish(new Error('解析超过 15 分钟，请拆分文档后重试')), 15 * 60_000)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    worker.on('message', message => {
      if (done) return
      if (message.type === 'progress') onProgress(message.progress)
      if (message.type === 'result') finish(null, message.parsed)
      if (message.type === 'error') finish(new Error(message.error))
    })
    worker.on('error', error => finish(error))
    worker.on('exit', () => { if (!done) finish(new Error('解析进程提前退出')) })
  })
}

export function createImports(store) {
  const active = new Map()
  const tasks = new Set()
  async function start(upload, mode = 'auto') {
    if (active.size >= 2) throw new HttpError(429, '当前正在解析两份文档，请稍后重试。')
    const job = { id: randomUUID(), status: 'queued', fileName: basename(upload.fileName.replaceAll('\\', '/')).slice(0, 200), mode, createdAt: new Date().toISOString() }
    const controller = new AbortController()
    active.set(job.id, controller)
    try { await store.write('imports', job) } catch (error) { active.delete(job.id); throw error }
    const initial = structuredClone(job)
    const task = execute(job, upload, controller)
    tasks.add(task)
    void task.finally(() => tasks.delete(task)).catch(error => console.error('Import persistence failed:', error.message))
    return initial
  }
  async function execute(job, upload, controller) {
    let pending = Promise.resolve()
    const persist = () => {
      const snapshot = structuredClone(job)
      pending = pending.then(() => store.write('imports', snapshot))
      pending.catch(() => {})
      return pending
    }
    try {
      job.status = 'running'; await persist()
      const parsed = await parseInWorker(upload, { mode: job.mode, signal: controller.signal, onProgress: progress => { job.progress = progress; void persist() } })
      controller.signal.throwIfAborted()
      const document = { id: randomUUID(), schemaVersion: 2, fileName: job.fileName, ...parsed,
        source: { kind: 'upload', sha256: createHash('sha256').update(upload.bytes).digest('hex'), byteLength: upload.bytes.length }, createdAt: new Date().toISOString() }
      await store.saveOriginal(document.id, upload.bytes)
      await store.write('documents', document)
      job.documentId = document.id; job.status = 'completed'
    } catch (error) { job.status = controller.signal.aborted ? 'cancelled' : 'failed'; job.error = error.message }
    finally {
      job.finishedAt = new Date().toISOString()
      try { await pending.catch(() => {}); await store.write('imports', job) } finally { active.delete(job.id) }
    }
  }
  return { start, cancel(id) { const controller = active.get(id); controller?.abort(new Error('已取消文档解析')); return Boolean(controller) },
    async stop() { for (const controller of active.values()) controller.abort(new Error('服务正在关闭')); await Promise.allSettled([...tasks]) } }
}
