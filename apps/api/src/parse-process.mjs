import { Worker } from 'node:worker_threads'

// A Node worker keeps PDF.js in its supported Node context even when this
// executable comes from Electron. The surrounding process bounds native RSS.
let worker, cancelled = false, pending = 0, exited = false
function disconnectWhenFlushed() { if (exited && !pending && process.connected) process.disconnect() }
function forward(value) {
  if (!process.connected) return
  pending++
  process.send(value, () => { pending--; disconnectWhenFlushed() })
}
process.on('message', message => {
  if (message.type === 'start' && !worker) {
    worker = new Worker(new URL('./parse-worker.mjs', import.meta.url), { workerData: message.workerData })
    worker.on('message', forward)
    worker.on('error', error => forward({ type: 'error', error: error.message }))
    worker.once('exit', code => { process.exitCode = code; exited = true; disconnectWhenFlushed() })
    if (cancelled) worker.postMessage({ type: 'cancel' })
  }
  if (message.type === 'cancel') { cancelled = true; worker?.postMessage({ type: 'cancel' }) }
  if (message.type === 'vision-result') worker?.postMessage(message)
})
process.on('disconnect', () => {
  cancelled = true; worker?.postMessage({ type: 'cancel' })
  // Parent death must not leave a parser running indefinitely.
  const timer = setTimeout(() => process.exit(1), 5000)
  timer.unref()
})
