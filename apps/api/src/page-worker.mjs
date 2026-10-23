import { parentPort, workerData } from 'node:worker_threads'
import { pageImage } from './pdf.mjs'

try {
  const png = Uint8Array.from(await pageImage(Buffer.from(workerData.bytes), workerData.page))
  parentPort.postMessage({ png }, [png.buffer])
} catch (error) { parentPort.postMessage({ error: error.message }) }
