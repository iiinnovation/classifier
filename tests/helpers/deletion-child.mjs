// Faults are applied only by this external test runner, including when it loads
// packaged production modules. The application exposes no fault controls.
import fs from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const [directory, parameters, phase, application] = process.argv.slice(2)
process.parentPort?.on('message', ({ data }) => { if (data?.type === 'finish') process.exit(0) })
const moduleAt = name => import(application ? pathToFileURL(join(application, 'apps/api/src', name + '.mjs')).href : new URL(`../../apps/api/src/${name}.mjs`, import.meta.url).href)
const { createStore } = await moduleAt('store')
const { deletionPreview } = await moduleAt('deletion-preview')
const { acquireDataLock } = await moduleAt('data-lock')
const owner = await acquireDataLock(directory), store = await createStore(directory)
const value = JSON.parse(await fs.readFile(parameters, 'utf8'))
const preview = await deletionPreview(store, { bucket: 'documents', id: value.documentId })
const exec = DatabaseSync.prototype.exec, unlink = fs.unlink, open = fs.open
let limited, reached = false
const die = () => { writeFileSync(parameters + '.checkpoint', phase, { flag: 'wx' }); process.kill(process.pid, 'SIGKILL') }
DatabaseSync.prototype.exec = function(sql, ...args) {
  if (/user_version=2; COMMIT/.test(sql)) {
    reached = true
    if (phase === 'before-commit') die()
    if (phase === 'sqlite-full') {
      const pages = this.prepare('PRAGMA page_count').get().page_count
      exec.call(this, 'PRAGMA max_page_count=' + pages); limited = this
      this.prepare('INSERT INTO deletion_operations(id,target_bucket,target_id,preview_revision,result,state,created_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(), 'documents', value.documentId, '0'.repeat(64), JSON.stringify({ padding: 'x'.repeat(8 * 1024 ** 2) }), 'committed', new Date().toISOString())
    }
    const result = exec.call(this, sql, ...args)
    if (phase === 'after-commit') die()
    if (phase === 'commit-ack-error') throw Object.assign(new Error('test error after durable deletion commit'), { code: 'EIO' })
    return result
  }
  return exec.call(this, sql, ...args)
}
fs.unlink = async (...args) => {
  if (String(args[0]) === join(directory, 'originals', value.documentId)) {
    reached = true
    if (phase === 'before-unlink') die()
    if (phase === 'unlink-denied') throw Object.assign(new Error('test unlink denied'), { code: 'EACCES' })
    const result = await unlink(...args)
    if (phase === 'after-unlink') die()
    return result
  }
  return unlink(...args)
}
fs.open = async (...args) => {
  const handle = await open(...args)
  if (phase === 'directory-sync-error' && String(args[0]) === join(directory, 'originals')) {
    reached = true
    handle.sync = async () => { throw Object.assign(new Error('test directory sync failure'), { code: 'EIO' }) }
  }
  return handle
}
syncBuiltinESMExports()
try {
  let result, error
  try { result = await store.commitDeletion(preview, value.operationId) }
  catch (failure) { error = { code: failure.code, errcode: failure.errcode, message: failure.message } }
  if (!reached) throw new Error('Deletion fault boundary was not reached')
  if (phase === 'sqlite-full' && error?.errcode !== 13) throw new Error('Expected actual SQLITE_FULL')
  const report = { result, error, reached, confirmedRevision: preview.revision }
  console.log(JSON.stringify(report))
  process.parentPort?.postMessage({ type: 'completed', report })
} finally {
  DatabaseSync.prototype.exec = exec; fs.unlink = unlink; fs.open = open; syncBuiltinESMExports()
  if (limited?.isOpen) exec.call(limited, 'PRAGMA max_page_count=1073741823')
  store.close(); owner.release()
}
