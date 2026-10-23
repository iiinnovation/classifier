import { DatabaseSync } from 'node:sqlite'
import { readFile, writeFile, rename, unlink, mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { requireId } from './store.mjs'
import { recordBuckets } from './storage-layout.mjs'
import { HttpError } from './http.mjs'
import { fileOperationPath } from './file-operations.mjs'

// An additive table within the existing v1 record format. Legacy v1 libraries
// remain readable and receive the journal before any file operation is replayed.
const fileOperationsSchema = "CREATE TABLE IF NOT EXISTS file_operations(id TEXT PRIMARY KEY,operation TEXT NOT NULL,document_id TEXT NOT NULL,path TEXT NOT NULL,expected_sha256 TEXT,state TEXT NOT NULL CHECK(state IN ('pending','done','failed')),error TEXT,created_at TEXT NOT NULL,completed_at TEXT,recovered_at TEXT);"

export function initializeDatabase(path) {
  const db = new DatabaseSync(path)
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; CREATE TABLE records(bucket TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),generation INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(bucket,id)); " + fileOperationsSchema + " PRAGMA user_version=1;")
  return db
}

export async function createSqliteStore(root) {
  const path = join(root, 'library.sqlite')
  // Verify read-only first: corruption or a newer schema must not trigger writes.
  const check = new DatabaseSync(path, { readOnly: true })
  try {
    if (check.prepare('PRAGMA user_version').get().user_version !== 1 || check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('资料库数据库版本不兼容或完整性检查失败，已停止写入。')
  } finally { check.close() }
  const db = new DatabaseSync(path)
  try { db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;' + fileOperationsSchema); await mkdir(join(root, 'originals'), { recursive: true }) }
  catch (error) { db.close(); throw error }
  const validate = (bucket, id) => {
    if (!recordBuckets.includes(bucket)) throw new HttpError(400, '无效的记录类型。')
    return requireId(id)
  }
  function row(bucket, id) { return db.prepare('SELECT body,generation FROM records WHERE bucket=? AND id=?').get(bucket, validate(bucket, id)) }
  async function read(bucket, id) { const current = row(bucket, id); return current ? JSON.parse(current.body) : null }
  function write(bucket, record) {
    const id = validate(bucket, record.id)
    db.prepare('INSERT INTO records(bucket,id,body) VALUES(?,?,?) ON CONFLICT(bucket,id) DO UPDATE SET body=excluded.body,generation=records.generation+1').run(bucket, id, JSON.stringify(record))
    return record
  }
  async function list(bucket) {
    if (!recordBuckets.includes(bucket)) throw new HttpError(400, '无效的记录类型。')
    return db.prepare('SELECT body FROM records WHERE bucket=?').all(bucket).map(value => JSON.parse(value.body)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  const updates = new Map()
  async function update(bucket, id, change, { allowCreate = false } = {}) {
    id = validate(bucket, id)
    const key = bucket + '/' + id
    const task = (updates.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
      const before = row(bucket, id)
      if (!before && !allowCreate) throw new HttpError(404, '未找到记录。')
      const next = await change(before ? JSON.parse(before.body) : null)
      if (requireId(next.id) !== id) throw new HttpError(400, '记录 ID 不可修改。')
      // Async business callbacks finish before BEGIN; CAS protects a direct write
      // that happened while awaiting evidence or other records.
      db.exec('BEGIN IMMEDIATE')
      try {
        const current = row(bucket, id)
        if (current?.generation !== before?.generation) throw new HttpError(409, '记录已更新，请载入最新版本后重试。')
        write(bucket, next)
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
      return next
    })
    updates.set(key, task)
    try { return await task } finally { if (updates.get(key) === task) updates.delete(key) }
  }
  let closed = false
  const store = {
    read, write, list, update,
    async document(id) { const value = await read('documents', id); if (!value) throw new HttpError(404, '未找到文档。'); return value },
    async original(id) { return readFile(join(root, 'originals', requireId(id))) },
    async saveOriginal(id, bytes) {
      id = requireId(id); const operation = { id: randomUUID(), operation: 'write', documentId: id, path: `originals/${id}`, expectedSha256: createHash('sha256').update(bytes).digest('hex'), state: 'pending', createdAt: new Date().toISOString() }
      db.prepare('INSERT INTO file_operations(id,operation,document_id,path,expected_sha256,state,created_at) VALUES(?,?,?,?,?,?,?)').run(operation.id, operation.operation, id, operation.path, operation.expectedSha256, operation.state, operation.createdAt)
      try {
        const target = await fileOperationPath(root, operation), temporary = target + '.' + randomUUID() + '.tmp'
        await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' }); const handle = await open(temporary, 'r+'); try { await handle.sync() } finally { await handle.close() }; await rename(temporary, target)
        db.prepare('UPDATE file_operations SET state=\'done\',completed_at=? WHERE id=?').run(new Date().toISOString(), operation.id)
      } catch (error) { db.prepare('UPDATE file_operations SET state=\'failed\',error=? WHERE id=?').run(error.code || error.message, operation.id); throw error }
    },
    async removeOriginal(id) {
      id = requireId(id); const operation = { id: randomUUID(), operation: 'remove', documentId: id, path: `originals/${id}`, state: 'pending', createdAt: new Date().toISOString() }
      db.prepare('INSERT INTO file_operations(id,operation,document_id,path,state,created_at) VALUES(?,?,?,?,?,?)').run(operation.id, operation.operation, id, operation.path, operation.state, operation.createdAt)
      try { await unlink(await fileOperationPath(root, operation)); db.prepare('UPDATE file_operations SET state=\'done\',completed_at=? WHERE id=?').run(new Date().toISOString(), operation.id) }
      catch (error) { if (error.code === 'ENOENT') db.prepare('UPDATE file_operations SET state=\'done\',completed_at=? WHERE id=?').run(new Date().toISOString(), operation.id); else { db.prepare('UPDATE file_operations SET state=\'failed\',error=? WHERE id=?').run(error.code || error.message, operation.id); throw error } }
    },
    close() { if (!closed) { db.close(); closed = true } },
  }
  try {
    for (const operation of db.prepare("SELECT * FROM file_operations WHERE state='pending'").all()) {
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
