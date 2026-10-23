import { EventEmitter } from 'node:events'

// Adapt Node's child IPC to the utilityProcess parentPort contract, executing
// the production worker unchanged. Electron startup remains a separate gate.
process.parentPort = new EventEmitter()
process.parentPort.postMessage = message => process.send(message)
process.on('message', data => process.parentPort.emit('message', { data }))
await import('../../apps/desktop/maintenance-worker.mjs')
