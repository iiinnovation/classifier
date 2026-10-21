// S0 experiment only; never imported by the application or packaged for users.
import { DatabaseSync } from 'node:sqlite'
import { mkdir, writeFile, readFile, unlink, copyFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'

const [root, action, stopAt = ''] = process.argv.slice(2)
// Utility processes retain the parent channel. Exit only after the parent has
// received the result, avoiding both a live handle and a truncated message.
if (process.parentPort) process.parentPort.on('message', ({ data }) => { if (data?.type === 'finish') process.exit(process.exitCode || 0) })
const send = value => process.parentPort ? process.parentPort.postMessage(value) : process.send?.(value)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const exists = async path => { try { await access(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
const originalPath = join(root, 'originals', 'document-1')
let db
async function checkpoint(stage) {
  if (stopAt !== stage) return
  send({ type: 'checkpoint', stage })
  await new Promise(() => { setInterval(() => {}, 1000) })
}
function open() {
  db = new DatabaseSync(join(root, 'library.sqlite'))
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 150; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
}
const get = (bucket, id) => { const row = db.prepare('SELECT body FROM records WHERE bucket = ? AND id = ?').get(bucket, id); return row ? JSON.parse(row.body) : null }
const put = (bucket, record) => db.prepare('INSERT INTO records(bucket,id,body) VALUES(?,?,?) ON CONFLICT(bucket,id) DO UPDATE SET body=excluded.body').run(bucket, record.id, JSON.stringify(record))
async function seed() {
  await mkdir(join(root, 'originals'), { recursive: true })
  open()
  db.exec("CREATE TABLE records(bucket TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),PRIMARY KEY(bucket,id)); CREATE TABLE operations(id TEXT PRIMARY KEY,document_id TEXT NOT NULL); CREATE TABLE file_operations(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','done')),error TEXT); CREATE TABLE write_pressure(bytes BLOB);")
  const bytes = Buffer.from('S0 original research document; fixture only.')
  await writeFile(originalPath, bytes, { mode: 0o600 })
  await writeFile(join(root, 'originals', 'shared-2'), 'Unrelated shared original', { mode: 0o600 })
  db.exec('BEGIN IMMEDIATE')
  put('documents', { id: 'document-1', title: 'Shared source', status: 'available', sha256: hash(bytes), schemaVersion: 2, references: [{ id: 'ref-1', text: 'Retained evidence', page: 1 }] })
  put('documents', { id: 'shared-2', status: 'available', sha256: hash(Buffer.from('Unrelated shared original')) })
  for (let i = 1; i <= 3; i++) put('topics', { id: 'topic-' + i, documentIds: ['document-1', 'shared-2'] })
  for (const bucket of ['notes', 'comparisons', 'reports']) put(bucket, { id: bucket + '-1', documentId: 'document-1', evidence: { text: 'Retained evidence', page: 1, fingerprint: 'unchanged-parse-identity' }, history: [{ version: 1, text: 'Historical evidence' }] })
  put('imports', { id: 'import-1', documentId: 'document-1', status: 'queued' })
  db.exec('COMMIT')
  return inspect()
}
async function inspect() {
  return {
    document: get('documents', 'document-1'), topics: [1, 2, 3].map(i => get('topics', 'topic-' + i)),
    snapshots: ['notes', 'comparisons', 'reports'].map(bucket => get(bucket, bucket + '-1')),
    task: get('imports', 'import-1'), originalExists: await exists(originalPath), sharedOriginalExists: await exists(join(root, 'originals', 'shared-2')),
    fileOperations: db.prepare('SELECT * FROM file_operations ORDER BY id').all(),
    operationCount: db.prepare('SELECT count(*) AS count FROM operations').get().count,
    integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
    journalMode: db.prepare('PRAGMA journal_mode').get().journal_mode,
  }
}
async function drain(failUnlink = false) {
  for (const operation of db.prepare("SELECT * FROM file_operations WHERE state='pending'").all()) {
    await checkpoint('before-unlink')
    try {
      if (failUnlink) throw Object.assign(new Error('Injected original-file permission failure'), { code: 'EACCES' })
      await unlink(join(root, 'originals', operation.document_id))
    } catch (error) {
      if (error.code !== 'ENOENT') { db.prepare('UPDATE file_operations SET error=? WHERE id=?').run(error.code || 'UNKNOWN', operation.id); continue }
    }
    await checkpoint('after-unlink')
    db.prepare("UPDATE file_operations SET state='done',error=NULL WHERE id=?").run(operation.id)
  }
}
async function removeDocument({ full = false, failUnlink = false } = {}) {
  if (full) { const pages = db.prepare('PRAGMA page_count').get().page_count; db.exec('PRAGMA max_page_count=' + pages) }
  try {
    db.exec('BEGIN IMMEDIATE')
    if (!db.prepare('SELECT id FROM operations WHERE id=?').get('delete-document-1')) {
      const document = get('documents', 'document-1')
      put('documents', { id: document.id, title: document.title, status: 'deleted' })
      for (let i = 1; i <= 3; i++) { const topic = get('topics', 'topic-' + i); topic.documentIds = topic.documentIds.filter(id => id !== document.id); put('topics', topic) }
      put('imports', { ...get('imports', 'import-1'), status: 'cancelled', reason: 'source-deleted' })
      db.prepare('INSERT INTO operations VALUES(?,?)').run('delete-document-1', document.id)
      db.prepare('INSERT INTO file_operations VALUES(?,?,?,NULL)').run('unlink-document-1', document.id, 'pending')
    }
    await checkpoint('before-commit')
    if (full) db.exec('INSERT INTO write_pressure VALUES(zeroblob(1048576))')
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    if (full) { assert.match(error.message, /full/i); return { error: { code: error.code, message: error.message }, state: await inspect() } }
    throw error
  }
  await checkpoint('after-commit')
  await drain(failUnlink)
  return inspect()
}
async function backupAndRestore() {
  // Exclusive application ownership must quiesce ALL metadata and file writers
  // throughout this snapshot. SQLite's backup alone cannot lock the originals.
  const destination = join(root, 'backup'), restored = join(root, 'restored')
  await mkdir(join(destination, 'originals'), { recursive: true })
  db.exec('PRAGMA wal_checkpoint(FULL)')
  db.prepare('VACUUM INTO ?').run(join(destination, 'library.sqlite'))
  const records = db.prepare("SELECT body FROM records WHERE bucket='documents'").all().map(row => JSON.parse(row.body))
  const files = []
  for (const record of records.filter(record => record.status === 'available')) {
    const bytes = await readFile(join(root, 'originals', record.id))
    assert.equal(hash(bytes), record.sha256)
    await copyFile(join(root, 'originals', record.id), join(destination, 'originals', record.id))
    files.push({ id: record.id, sha256: hash(bytes), bytes: bytes.length })
  }
  const manifest = { formatVersion: 1, databaseSha256: hash(await readFile(join(destination, 'library.sqlite'))), files }
  await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest))
  await removeDocument()
  await mkdir(join(restored, 'originals'), { recursive: true })
  assert.equal(hash(await readFile(join(destination, 'library.sqlite'))), manifest.databaseSha256)
  await copyFile(join(destination, 'library.sqlite'), join(restored, 'library.sqlite'))
  for (const file of files) {
    const bytes = await readFile(join(destination, 'originals', file.id)); assert.equal(hash(bytes), file.sha256)
    await copyFile(join(destination, 'originals', file.id), join(restored, 'originals', file.id))
  }
  const restoredDb = new DatabaseSync(join(restored, 'library.sqlite'))
  try {
    assert.equal(restoredDb.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    const restoredDoc = JSON.parse(restoredDb.prepare("SELECT body FROM records WHERE bucket='documents' AND id='document-1'").get().body)
    assert.equal(restoredDoc.status, 'available')
    assert.equal(hash(await readFile(join(restored, 'originals', restoredDoc.id))), restoredDoc.sha256)
    for (let i = 1; i <= 3; i++) assert.ok(JSON.parse(restoredDb.prepare("SELECT body FROM records WHERE bucket='topics' AND id=?").get('topic-' + i).body).documentIds.includes(restoredDoc.id))
    return { restored: true, liveDeleted: get('documents', 'document-1').status === 'deleted', files: files.length, integrity: 'ok', manifest }
  } finally { restoredDb.close() }
}
async function run() {
  if (action === 'seed') return seed()
  open()
  if (action === 'inspect') return inspect()
  if (action === 'delete') return removeDocument()
  if (action === 'full') return removeDocument({ full: true })
  if (action === 'file-error') return removeDocument({ failUnlink: true })
  if (action === 'recover') { await drain(); return inspect() }
  if (action === 'backup') return backupAndRestore()
  if (action === 'hold') { db.exec('BEGIN IMMEDIATE'); await checkpoint('locked'); throw new Error('Expected hold checkpoint') }
  if (action === 'contend') {
    try { db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK'); return { blocked: false } }
    catch (error) { return { blocked: /locked|busy/i.test(error.message), message: error.message, code: error.code } }
  }
  throw new Error('Unknown S0 probe action: ' + action)
}
try {
  const result = await run()
  const runtime = { node: process.versions.node, electron: process.versions.electron, sqlite: db.prepare('SELECT sqlite_version() AS version').get().version, platform: process.platform, arch: process.arch }
  db.close(); db = null
  send({ type: 'result', result, runtime })
} catch (error) { send({ type: 'error', message: error.stack }); process.exitCode = 1 }
finally { db?.close(); if (process.disconnect) process.disconnect() }
