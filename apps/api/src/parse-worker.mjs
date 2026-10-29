import { parentPort, workerData } from 'node:worker_threads'
import { parseDocument } from './parser.mjs'
import { clearAllCache } from '@napi-rs/canvas'
const controller = new AbortController()
const visionRequests = new Map()
let visionRequestId = 0
function recognizeVision(png) {
  controller.signal.throwIfAborted()
  const id = ++visionRequestId, pending = Promise.withResolvers()
  visionRequests.set(id, pending)
  parentPort.postMessage({ type: 'vision', id, png })
  return pending.promise
}
parentPort.on('message', message => {
  if (message.type === 'cancel') {
    controller.abort(new Error('解析已取消'))
    for (const pending of visionRequests.values()) pending.reject(controller.signal.reason)
    visionRequests.clear()
  }
  if (message.type === 'vision-result') {
    const pending = visionRequests.get(message.id)
    visionRequests.delete(message.id)
    if (message.error) pending?.reject(new Error(message.error))
    else pending?.resolve(message.blocks)
  }
})
try {
  const parsed = await parseDocument(workerData.fileName, Buffer.from(workerData.bytes), workerData.contentType, {
    mode: workerData.mode,
    ...(workerData.remoteVision ? { recognizeVision } : { visionConfig: workerData.visionConfig }),
    signal: controller.signal,
    onProgress: async progress => parentPort.postMessage({ type: 'progress', progress }),
  })
  parentPort.postMessage({ type: 'result', parsed })
} catch (error) { parentPort.postMessage({ type: 'error', error: error.message }) }
finally { clearAllCache(); parentPort.close() }
