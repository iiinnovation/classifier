import { executeMaintenance } from './maintenance-operations.mjs'

let started = false
process.parentPort.on('message', async ({ data }) => {
  if (started) return
  started = true
  try {
    const result = await executeMaintenance(data.command, data, {
      onProgress: progress => process.parentPort.postMessage({ type: 'progress', progress }),
    })
    process.parentPort.postMessage({ ok: true, result })
  } catch (error) { process.parentPort.postMessage({ ok: false, error: error.message }) }
  finally { process.parentPort.postMessage({ type: 'finished' }) }
})
process.parentPort.postMessage({ type: 'ready' })
