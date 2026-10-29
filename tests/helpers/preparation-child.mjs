const [source, destination, backup, stopAt] = process.argv.slice(2)
const { prepareMigration } = await import('../../apps/api/src/storage-maintenance.mjs')
try {
  await prepareMigration(source, destination, backup, { onProgress: async progress => {
    if (progress.phase === stopAt) {
      process.send({ type: 'checkpoint', progress })
      await new Promise(() => { setInterval(() => {}, 1000) })
    }
  } })
  process.send({ type: 'unexpected-completion' })
} catch (error) { process.send({ type: 'error', message: error.message }) }
finally { process.disconnect?.() }
