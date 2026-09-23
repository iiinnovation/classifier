import { parentPort, workerData } from 'node:worker_threads'
import { parseDocument } from './parser.mjs'
const controller = new AbortController()
parentPort.on('message', message => { if (message.type === 'cancel') controller.abort(new Error('解析已取消')) })
try {
  const parsed = await parseDocument(workerData.fileName, Buffer.from(workerData.bytes), workerData.contentType, {
    mode: workerData.mode,
    signal: controller.signal,
    onProgress: async progress => parentPort.postMessage({ type: 'progress', progress }),
  })
  parentPort.postMessage({ type: 'result', parsed })
} catch (error) { parentPort.postMessage({ type: 'error', error: error.message }) }
