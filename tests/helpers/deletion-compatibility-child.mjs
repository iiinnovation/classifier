import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
const [directory, application] = process.argv.slice(2)
process.parentPort.on('message', ({ data }) => { if (data?.type === 'finish') process.exit(0) })
const snapshot = () => {
  const db = new DatabaseSync(join(directory, 'library.sqlite'), { readOnly: true })
  try { return { version: db.prepare('PRAGMA user_version').get().user_version, records: db.prepare('SELECT bucket,id,body,generation FROM records ORDER BY bucket,id').all() } } finally { db.close() }
}
const before = snapshot()
if (before.version !== 2) throw new Error('Expected a library produced by actual D2 deletion')
const { createStore } = await import(pathToFileURL(join(application, 'apps/api/src/store.mjs')).href)
let refused
try { const store = await createStore(directory); store.close() } catch (error) { refused = error.message }
if (!refused || !/版本|兼容/.test(refused) || JSON.stringify(snapshot()) !== JSON.stringify(before)) throw new Error('Older production store did not refuse before writes')
process.parentPort.postMessage({ source: application, versions: process.versions, databaseVersion: before.version, oldVersionRefusedBeforeRecordAndTaskWrites: true, error: refused })
