import { Worker } from 'node:worker_threads'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { basename } from 'node:path'
import { HttpError } from './http.mjs'
import { environmentSettings } from './settings.mjs'
import { visionConfigured } from './vision.mjs'

export function parseInWorker(upload, { mode = 'auto', signal, onProgress = () => {}, visionConfig, isolate = Boolean(process.versions.electron) } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason || new Error('解析已取消')); return }
    const workerData = { ...upload, mode, visionConfig }
    // Desktop imports own large native allocations. A short-lived process
    // releases allocator arenas that can survive a worker thread's exit.
    const isolated = isolate
    const worker = isolated
      ? fork(fileURLToPath(new URL('./parse-process.mjs', import.meta.url)), [], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, execArgv: [], serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
      : new Worker(new URL('./parse-worker.mjs', import.meta.url), { workerData })
    const send = message => isolated ? worker.send(message, () => {}) : worker.postMessage(message)
    const terminate = () => isolated ? worker.kill('SIGKILL') : void worker.terminate()
    if (isolated) send({ type: 'start', workerData })
    let result, failure, received = false, stopping = false, grace
    const cancel = error => {
      if (stopping) return
      stopping = true; failure = error
      send({ type: 'cancel' })
      // Wait for parser finally blocks, OCR cleanup and the worker's natural
      // exit before releasing the import slot or reporting cancellation.
      grace = setTimeout(terminate, 5000)
    }
    const abort = () => cancel(signal.reason || new Error('解析已取消'))
    const timer = setTimeout(() => cancel(new Error('解析超过 15 分钟，请拆分文档后重试')), 15 * 60_000)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    worker.on('message', message => {
      if (stopping) return
      if (message.type === 'progress') onProgress(message.progress)
      if (message.type === 'result') { received = true; result = message.parsed }
      if (message.type === 'error') failure = new Error(message.error)
    })
    worker.on('error', error => { failure ||= error })
    // A failed fork emits error/close without exit. Close also waits for IPC.
    worker.once(isolated ? 'close' : 'exit', (code, exitSignal) => {
      clearTimeout(timer); clearTimeout(grace); signal?.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else if (code !== 0 || !received) reject(new Error(`解析进程提前退出（${exitSignal || code}）`))
      else resolve(result)
    })
  })
}

export function createImports(store, topics, settingsProvider = environmentSettings()) {
  const active = new Map()
  const tasks = new Set()
  const committing = new Set()
  let stopping = false
  async function start(upload, mode = 'auto') {
    if (stopping) throw new HttpError(503, '服务正在关闭。')
    const configuration = settingsProvider.read()
    if (mode === 'vision' && !visionConfigured(configuration.vision)) throw new HttpError(422, '尚未配置视觉模型。')
    const topicId = upload.topicId ? (await topics.get(upload.topicId)).id : null
    if (stopping) throw new HttpError(503, '服务正在关闭。')
    if (active.size >= 2) throw new HttpError(429, '当前正在解析两份文档，请稍后重试。')
    const job = { id: randomUUID(), status: 'queued', fileName: basename(upload.fileName.replaceAll('\\', '/')).slice(0, 200), topicId, mode, createdAt: new Date().toISOString() }
    const controller = new AbortController()
    active.set(job.id, controller)
    const finished = Promise.withResolvers()
    tasks.add(finished.promise)
    const release = () => { tasks.delete(finished.promise); finished.resolve() }
    try { await store.write('imports', job) } catch (error) { active.delete(job.id); release(); throw error }
    const initial = structuredClone(job)
    const task = execute(job, upload, controller, configuration)
    void task.finally(release).catch(error => console.error('Import persistence failed:', error.message))
    return initial
  }
  async function execute(job, upload, controller, configuration) {
    let pending = Promise.resolve()
    let savedDocumentId = null
    const persist = () => {
      const snapshot = structuredClone(job)
      pending = pending.then(() => store.write('imports', snapshot))
      pending.catch(() => {})
      return pending
    }
    try {
      job.status = 'running'; await persist()
      const parsed = await parseInWorker(upload, { mode: job.mode, visionConfig: configuration.vision, signal: controller.signal, onProgress: progress => { job.progress = progress; void persist() } })
      controller.signal.throwIfAborted()
      const document = { id: randomUUID(), schemaVersion: 2, fileName: job.fileName, ...parsed,
        source: { kind: 'upload', sha256: createHash('sha256').update(upload.bytes).digest('hex'), byteLength: upload.bytes.length }, createdAt: new Date().toISOString() }
      await store.saveOriginal(document.id, upload.bytes)
      savedDocumentId = document.id
      controller.signal.throwIfAborted()
      committing.add(job.id)
      await store.write('documents', document)
      job.documentId = document.id
      if (job.topicId) await topics.attach(job.topicId, document.id)
      job.status = 'completed'
    } catch (error) {
      job.status = controller.signal.aborted ? 'cancelled' : 'failed'; job.error = error.message
      if (savedDocumentId && !committing.has(job.id)) {
        try { await store.removeOriginal(savedDocumentId) }
        catch (cleanupError) { job.status = 'failed'; job.error = `${error.message}；原文件清理失败：${cleanupError.message}` }
      }
    }
    finally {
      job.finishedAt = new Date().toISOString()
      try { await pending.catch(() => {}); await store.write('imports', job) } finally { active.delete(job.id); committing.delete(job.id) }
    }
  }
  return { start, cancel(id) { const controller = active.get(id); if (!controller || committing.has(id)) return false; controller.abort(new Error('已取消文档解析')); return true },
    async stop() { stopping = true; for (const [id, controller] of active) if (!committing.has(id)) controller.abort(new Error('服务正在关闭')); await Promise.allSettled([...tasks]) } }
}
