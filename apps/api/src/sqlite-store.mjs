import { DatabaseSync } from 'node:sqlite'
import { readFile, writeFile, rename, unlink, mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { requireId } from './store.mjs'
import { recordBuckets } from './storage-layout.mjs'
import { HttpError } from './http.mjs'
import { fileOperationPath } from './file-operations.mjs'
import { createRecordIntegrity, decodeRecord, encodeRecord } from './record-integrity.mjs'
import { createSqliteImports, importOperationsSchema } from './sqlite-imports.mjs'
import { createSqliteDeletions, deletionSchema, checkDatabaseVersion } from './sqlite-deletions.mjs'

// An additive table within the existing v1 record format. Legacy v1 libraries
// remain readable and receive the journal before any file operation is replayed.
const fileOperationsSchema = "CREATE TABLE IF NOT EXISTS file_operations(id TEXT PRIMARY KEY,operation TEXT NOT NULL,document_id TEXT NOT NULL,path TEXT NOT NULL,expected_sha256 TEXT,state TEXT NOT NULL CHECK(state IN ('pending','done','failed')),error TEXT,created_at TEXT NOT NULL,completed_at TEXT,recovered_at TEXT);"

export function initializeDatabase(path) {
  const db = new DatabaseSync(path)
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; CREATE TABLE records(bucket TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),generation INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(bucket,id)); " + fileOperationsSchema + importOperationsSchema + " PRAGMA user_version=1;")
  return db
}

export async function createSqliteStore(root) {
  const path = join(root, 'library.sqlite')
  // Verify read-only first: corruption or a newer schema must not trigger writes.
  const check = new DatabaseSync(path, { readOnly: true })
  try {
    checkDatabaseVersion(check)
    if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('资料库数据库版本不兼容或完整性检查失败，已停止写入。')
  } finally { check.close() }
  const db = new DatabaseSync(path)
  try { db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;' + fileOperationsSchema + importOperationsSchema + deletionSchema); await mkdir(join(root, 'originals'), { recursive: true }) }
  catch (error) { db.close(); throw error }
  const integrity = createRecordIntegrity(root)
  const validate = (bucket, id) => {
    if (!recordBuckets.includes(bucket)) throw new HttpError(400, '无效的记录类型。')
    return requireId(id)
  }
  function row(bucket, id) { return db.prepare('SELECT body,generation FROM records WHERE bucket=? AND id=?').get(bucket, validate(bucket, id)) }
  async function read(bucket, id) { const current = row(bucket, id); return current ? integrity.parse(bucket, id, current.body, `${bucket}/${requireId(id)}`) : null }
  function write(bucket, record) {
    const id = validate(bucket, record.id)
    if (deletions.marker(bucket, id)) throw Object.assign(new HttpError(410, '记录已删除，不能由旧任务或草稿重新写回。'), { code: 'RECORD_DELETED' })
    const existing = row(bucket, id)
    if (existing) decodeRecord(bucket, id, existing.body)
    const bytes = encodeRecord(record)
    db.prepare('INSERT INTO records(bucket,id,body) VALUES(?,?,?) ON CONFLICT(bucket,id) DO UPDATE SET body=excluded.body,generation=records.generation+1').run(bucket, id, bytes)
    return record
  }
  async function list(bucket) {
    if (!recordBuckets.includes(bucket)) throw new HttpError(400, '无效的记录类型。')
    const values = []
    for (const value of db.prepare('SELECT id,body FROM records WHERE bucket=?').all(bucket)) {
      try { values.push(await integrity.parse(bucket, value.id, value.body, `${bucket}/${value.id}`)) }
      catch (error) { if (error.code !== 'RECORD_CORRUPT') throw error }
    }
    return values.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  const updates = new Map()
  async function update(bucket, id, change, { allowCreate = false } = {}) {
    id = validate(bucket, id)
    const key = bucket + '/' + id
    const task = (updates.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
      const before = row(bucket, id)
      if (!before && !allowCreate) throw new HttpError(404, '未找到记录。')
      const next = await change(before ? await integrity.parse(bucket, id, before.body, `${bucket}/${id}`) : null)
      if (requireId(next.id) !== id) throw new HttpError(400, '记录 ID 不可修改。')
      // Async business callbacks finish before BEGIN; CAS protects a direct write
      // that happened while awaiting evidence or other records.
      db.exec('BEGIN IMMEDIATE')
      try {
        const current = row(bucket, id)
        if (current?.generation !== before?.generation) throw new HttpError(409, '记录已更新，请载入最新版本后重试。')
        write(bucket, next)
        db.exec('COMMIT')
      } catch (error) {
        // SQLITE_FULL can roll back automatically. Keep the original disk error
        // instead of replacing it with "no transaction is active".
        try { db.exec('ROLLBACK') } catch { /* SQLite may already have ended the transaction. */ }
        throw error
      }
      return next
    })
    updates.set(key, task)
    try { return await task } finally { if (updates.get(key) === task) updates.delete(key) }
  }
  let closed = false
  const deletions = createSqliteDeletions({ db, root, row, write })
  const importCommitter = createSqliteImports({ db, root, row, write, deletionMarker: deletions.marker })
  const store = {
    read, write, list, update,
    deletion: deletions.marker, deletionReceipt: deletions.receipt, commitDeletion: deletions.commit,
    inspectRecordBodies(visit) { for (const value of db.prepare('SELECT bucket,id,body FROM records').iterate()) if (visit(value) === false) break },
    commitImport: importCommitter.commitImport,
    async health() {
      for (const bucket of recordBuckets) await list(bucket)
      const health = integrity.health(), pending = deletions.issues()
      const predicate = 'bucket NOT IN (?,?,?,?,?,?,?)'
      const unknownCount = db.prepare(`SELECT count(*) AS count FROM records WHERE ${predicate}`).get(...recordBuckets).count
      const unknown = db.prepare(`SELECT bucket,id FROM records WHERE ${predicate} LIMIT 1000`).all(...recordBuckets).map(value => ({ path: `${value.bucket}/${value.id}`, reason: 'UNKNOWN_RECORD_BUCKET', message: '资料库包含未知类型记录，删除范围无法完整核验，请先检查资料库。' }))
      const issueCount = health.issueCount + pending.length + unknownCount
      return { issueCount, issues: [...health.issues, ...pending, ...unknown].slice(0, 1000), truncated: health.truncated || issueCount > 1000 }
    },
    async document(id) { const value = await read('documents', id); if (!value) throw deletions.marker('documents', id) ? Object.assign(new HttpError(410, '原文已删除，已保存的引用摘录仍可查看。'), { code: 'RECORD_DELETED' }) : new HttpError(404, '未找到文档。'); return value },
    async original(id) { return readFile(join(root, 'originals', requireId(id))) },
    async saveOriginal(id, bytes) {
      if (deletions.marker('documents', id)) throw new HttpError(410, '原文已删除，不能重新写入原文件。')
      id = requireId(id); const operation = { id: randomUUID(), operation: 'write', documentId: id, path: `originals/${id}`, expectedSha256: createHash('sha256').update(bytes).digest('hex'), state: 'pending', createdAt: new Date().toISOString() }
      db.prepare('INSERT INTO file_operations(id,operation,document_id,path,expected_sha256,state,created_at) VALUES(?,?,?,?,?,?,?)').run(operation.id, operation.operation, id, operation.path, operation.expectedSha256, operation.state, operation.createdAt)
      try {
        const target = await fileOperationPath(root, operation), temporary = target + '.' + randomUUID() + '.tmp'
        await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' }); const handle = await open(temporary, 'r+'); try { await handle.sync() } finally { await handle.close() }; await rename(temporary, target)
        db.prepare('UPDATE file_operations SET state=\'done\',completed_at=? WHERE id=?').run(new Date().toISOString(), operation.id)
      } catch (error) { db.prepare('UPDATE file_operations SET state=\'failed\',error=? WHERE id=?').run(error.code || error.message, operation.id); throw error }
    },
    async removeOriginal(id) {
      if (deletions.marker('documents', id)) throw new HttpError(410, '原文已删除，由已核验的删除待办负责文件清理。')
      id = requireId(id); const operation = { id: randomUUID(), operation: 'remove', documentId: id, path: `originals/${id}`, state: 'pending', createdAt: new Date().toISOString() }
      db.prepare('INSERT INTO file_operations(id,operation,document_id,path,state,created_at) VALUES(?,?,?,?,?,?)').run(operation.id, operation.operation, id, operation.path, operation.state, operation.createdAt)
      try { await unlink(await fileOperationPath(root, operation)); db.prepare('UPDATE file_operations SET state=\'done\',completed_at=? WHERE id=?').run(new Date().toISOString(), operation.id) }
      catch (error) { if (error.code === 'ENOENT') db.prepare('UPDATE file_operations SET state=\'done\',completed_at=? WHERE id=?').run(new Date().toISOString(), operation.id); else { db.prepare('UPDATE file_operations SET state=\'failed\',error=? WHERE id=?').run(error.code || error.message, operation.id); throw error } }
    },
    close() { if (!closed) { db.close(); closed = true } },
  }
  try {
    for (const bucket of recordBuckets) await list(bucket)
    await deletions.recover()
    await importCommitter.recover()
    for (const operation of db.prepare("SELECT * FROM file_operations WHERE state='pending'").all()) {
      if (deletions.ownsFileOperation(operation.id)) continue
      try {
        const path = await fileOperationPath(root, { ...operation, documentId: operation.document_id, expectedSha256: operation.expected_sha256 })
        if (operation.operation === 'write') {
          const digest = createHash('sha256').update(await readFile(path)).digest('hex')
          if (digest === operation.expected_sha256) db.prepare('UPDATE file_operations SET state=\'done\',recovered_at=? WHERE id=?').run(new Date().toISOString(), operation.id)
          else db.prepare("UPDATE file_operations SET state='failed',error='INCOMPLETE_WRITE',recovered_at=? WHERE id=?").run(new Date().toISOString(), operation.id)
        } else {
          try { await unlink(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
          db.prepare('UPDATE file_operations SET state=\'done\',recovered_at=? WHERE id=?').run(new Date().toISOString(), operation.id)
        }
      } catch (error) { db.prepare('UPDATE file_operations SET state=\'failed\',error=?,recovered_at=? WHERE id=?').run(error.code || error.message, new Date().toISOString(), operation.id) }
    }
    for (const bucket of ['runs', 'imports']) for (const run of await list(bucket)) {
      if (['queued', 'running'].includes(run.status)) await write(bucket, { ...run, status: 'interrupted', error: '服务重启中断了本次任务，请重新提交。', finishedAt: new Date().toISOString() })
    }
  } catch (error) { store.close(); throw error }
  return store
}
