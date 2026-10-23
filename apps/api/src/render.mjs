import { Worker } from 'node:worker_threads'

// PDF.js treats Electron utility processes as browser contexts. A Node worker
// provides the same supported runtime used for import parsing, and keeps page
// rasterization off the API event loop.
export function pageImageInWorker(bytes, page, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return }
    const worker = new Worker(new URL('./page-worker.mjs', import.meta.url), { workerData: { bytes, page } })
    let finished = false
    async function finish(error, png) {
      if (finished) return
      finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
      await worker.terminate()
      if (error) reject(error)
      else resolve(Buffer.from(png))
    }
    const abort = () => { void finish(signal.reason || new Error('页图请求已取消')) }
    const timer = setTimeout(() => { void finish(new Error('页图渲染超过 30 秒')) }, 30000)
    signal?.addEventListener('abort', abort, { once: true })
    worker.on('message', message => { void finish(message.error ? new Error(message.error) : null, message.png) })
    worker.on('error', error => { void finish(error) })
    worker.on('exit', code => { if (!finished) void finish(new Error(`页图进程提前退出（${code}）`)) })
  })
}
