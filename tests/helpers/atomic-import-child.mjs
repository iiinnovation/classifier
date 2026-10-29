import fs from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

const [directory, parameters, phase, storePath] = process.argv.slice(2)
const { createStore } = await import(storePath ? pathToFileURL(storePath).href : '../../apps/api/src/store.mjs')
const store = await createStore(directory)
const value = JSON.parse(await fs.readFile(parameters, 'utf8'))
await store.write('imports', value.job)
const controller = new AbortController()
const die = () => { writeFileSync(parameters + '.checkpoint', phase, { flag: 'wx', mode: 0o600 }); process.kill(process.pid, 'SIGKILL') }
const prepare = DatabaseSync.prototype.prepare, exec = DatabaseSync.prototype.exec, open = fs.open, link = fs.link
DatabaseSync.prototype.prepare = function(sql, ...args) {
  const statement = prepare.call(this, sql, ...args)
  if (phase === 'intent' && sql.startsWith('INSERT INTO import_operations')) {
    const run = statement.run
    statement.run = function(...values) { const result = run.apply(this, values); die(); return result }
  }
  return statement
}
DatabaseSync.prototype.exec = function(sql, ...args) {
  if (phase === 'before-commit' && sql === 'COMMIT') die()
  const result = exec.call(this, sql, ...args)
  if (phase === 'after-commit' && sql === 'COMMIT') die()
  if (phase === 'commit-ack-error' && sql === 'COMMIT') throw Object.assign(new Error('injected error after durable COMMIT'), { code: 'EIO' })
  return result
}
fs.open = async (...args) => {
  const handle = await open(...args)
  if (['stage-synced', 'cancel-stage'].includes(phase) && String(args[0]).includes('/.import-')) {
    const sync = handle.sync.bind(handle)
    handle.sync = async () => { await sync(); if (phase === 'cancel-stage') controller.abort(new Error('cancel staged import')); else die() }
  }
  return handle
}
fs.link = async (...args) => {
  if (phase === 'publish-error') throw Object.assign(new Error('injected publish I/O failure'), { code: 'EIO' })
  const result = await link(...args); if (phase === 'file-published') die(); return result
}
syncBuiltinESMExports()
try {
  await store.commitImport(value.document, Buffer.from(value.bytes), { topicId: value.topicId, job: value.job, signal: controller.signal })
  if (['publish-error', 'cancel-stage'].includes(phase)) throw new Error('expected failure did not occur')
} catch (error) {
  if (phase === 'publish-error' ? error.code !== 'EIO' : phase === 'cancel-stage' ? !controller.signal.aborted : true) throw error
}
store.close()
process.parentPort?.postMessage({ type: 'completed' })
