import { pathToFileURL } from 'node:url'
const [directory, stopAt, modulePath] = process.argv.slice(2)
const { resumeMigration } = await import(modulePath ? pathToFileURL(modulePath).href : '../../apps/api/src/storage-maintenance.mjs')
const send = value => process.parentPort ? process.parentPort.postMessage(value) : process.send?.(value)
process.parentPort?.on('message', event => { if (event.data?.type === 'finish') process.exit(process.exitCode || 0) })
try {
  const result = await resumeMigration(directory, { onProgress: async progress => {
    if (progress.phase === stopAt) {
      send({ type: 'checkpoint', progress })
      // The parent forcibly terminates this real migration process here.
      await new Promise(() => { setInterval(() => {}, 1000) })
    }
  } })
  send({ type: 'result', result })
} catch (error) { send({ type: 'error', message: error.message }); process.exitCode = 1 }
finally { process.disconnect?.() }
