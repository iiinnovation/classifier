import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { HttpError } from './http.mjs'
import { recordBuckets } from './storage-layout.mjs'
import { decodeRecord } from './record-integrity.mjs'
import { requireId } from './store.mjs'

export const deletionSchema = `
CREATE TABLE IF NOT EXISTS deletion_operations(
 id TEXT PRIMARY KEY,target_bucket TEXT NOT NULL,target_id TEXT NOT NULL,
 preview_revision TEXT NOT NULL,result TEXT NOT NULL CHECK(json_valid(result)),
 file_operation_id TEXT,state TEXT NOT NULL CHECK(state IN ('committed','done')),
 created_at TEXT NOT NULL,completed_at TEXT);
CREATE TABLE IF NOT EXISTS record_deletions(
 bucket TEXT NOT NULL,id TEXT NOT NULL,operation_id TEXT NOT NULL REFERENCES deletion_operations(id),
 deleted_at TEXT NOT NULL,PRIMARY KEY(bucket,id));`
const now = () => new Date().toISOString()
export const deletionRevision = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function deletionConfirmationRevision(data) {
  return deletionRevision(Object.fromEntries(recordBuckets.map(bucket => [bucket, ['runs', 'imports'].includes(bucket) ? data[bucket].map(value => {
    const { status, events, result, error, finishedAt, progress, ...identity } = value
    return identity
  }) : data[bucket]])))
}

// Version 2 is committed with the first deletion, so pre-D2 binaries refuse
// this library before task recovery or writes. Merely opening v1 keeps v1.
export function checkDatabaseVersion(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version
  if (![1, 2].includes(version)) throw new Error('资料库数据库版本不受支持，已停止写入。')
  if (version === 2) {
    const invalid = db.prepare(`SELECT d.id FROM record_deletions d
      LEFT JOIN deletion_operations o ON o.id=d.operation_id
      LEFT JOIN records r ON r.bucket=d.bucket AND r.id=d.id
      WHERE o.id IS NULL OR r.id IS NOT NULL LIMIT 1`).get()
    if (invalid) throw new Error('删除标记与资料记录不一致，已停止写入。')
    const operations = new Map()
    for (const operation of db.prepare('SELECT * FROM deletion_operations').iterate()) {
      const result = JSON.parse(operation.result)
      if (requireId(operation.id) !== operation.id || requireId(operation.target_id) !== operation.target_id || !['documents', 'topics', 'notes', 'comparisons', 'reports'].includes(operation.target_bucket) || result.operationId !== operation.id || result.target?.id?.toLowerCase() !== operation.target_id || result.target?.bucket !== operation.target_bucket || !Array.isArray(result.recordIds)) throw new Error('删除操作回执损坏，已停止写入。')
      operations.set(operation.id, new Set(result.recordIds.map(value => `${value.bucket}/${requireId(value.id)}`)))
    }
    for (const marker of db.prepare('SELECT * FROM record_deletions').iterate()) {
      const key = `${marker.bucket}/${marker.id}`
      if (!recordBuckets.includes(marker.bucket) || requireId(marker.id) !== marker.id || !operations.get(marker.operation_id)?.delete(key)) throw new Error('删除标记与操作回执不一致，已停止写入。')
    }
    if ([...operations.values()].some(value => value.size)) throw new Error('删除操作的记录标记缺失，已停止写入。')
  }
  return version
}

export function createSqliteDeletions({ db, root, row, write }) {
  function marker(bucket, id) {
    if (!recordBuckets.includes(bucket)) throw new HttpError(400, '无效的记录类型。')
    return db.prepare('SELECT operation_id AS operationId,deleted_at AS deletedAt FROM record_deletions WHERE bucket=? AND id=?').get(bucket, requireId(id)) || null
  }
  function receipt(operationId, bucket, id, revision) {
    const operation = db.prepare('SELECT * FROM deletion_operations WHERE id=?').get(requireId(operationId))
    if (!operation) return null
    if (operation.target_bucket !== bucket || operation.target_id !== requireId(id) || operation.preview_revision !== revision) throw new HttpError(409, '删除请求 ID 已用于其他影响范围。')
    const file = operation.file_operation_id && db.prepare('SELECT state,error FROM file_operations WHERE id=?').get(operation.file_operation_id)
    return { ...JSON.parse(operation.result), completed: operation.state === 'done', filePending: Boolean(file && file.state !== 'done'), ...(file?.error ? { fileError: file.error } : {}) }
  }
  async function fingerprint(id) {
    const folder = join(root, 'originals')
    if (!(await lstat(folder)).isDirectory()) throw new Error('原文件目录不安全，未执行删除。')
    const path = join(folder, requireId(id))
    let handle
    try {
      const entry = await lstat(path)
      if (!entry.isFile() || entry.size > 32 * 1024 ** 2) throw new Error('原文件类型或大小不安全，未执行删除。')
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      const before = await handle.stat()
      if (!before.isFile()) throw new Error('原文件不是普通文件，未执行删除。')
      const hash = createHash('sha256')
      if (before.size) for await (const bytes of handle.createReadStream({ autoClose: false, start: 0, end: before.size - 1 })) hash.update(bytes)
      const after = await handle.stat(), current = await lstat(path)
      if (!current.isFile() || before.dev !== current.dev || before.ino !== current.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new HttpError(409, '原文件在核对时发生变化，未执行删除。')
      return { sha256: hash.digest('hex'), ino: current.ino, dev: current.dev }
    } catch (error) { if (error.code === 'ENOENT') return null; throw error }
    finally { await handle?.close() }
  }
  async function syncDirectory() {
    if (process.platform === 'win32') return
    const handle = await open(join(root, 'originals'), 'r')
    try { await handle.sync() } finally { await handle.close() }
  }
  async function settle(operationId) {
    const operation = db.prepare('SELECT * FROM deletion_operations WHERE id=?').get(operationId)
    if (!operation || operation.state === 'done') return
    if (operation.file_operation_id) {
      const file = db.prepare('SELECT * FROM file_operations WHERE id=?').get(operation.file_operation_id)
      if (!file || file.operation !== 'remove' || file.document_id !== operation.target_id || file.path !== `originals/${requireId(operation.target_id)}` || marker('documents', operation.target_id)?.operationId !== operation.id || row('documents', operation.target_id)) throw new Error('删除文件待办与标记不一致，原文件保留。')
      if (file.state !== 'done') {
        try {
          const current = await fingerprint(file.document_id)
          if (current) {
            if (!file.expected_sha256 || current.sha256 !== file.expected_sha256) throw new Error('原文件与删除时的哈希不符，文件保留，请核对。')
            const entry = await lstat(join(root, file.path))
            if (!entry.isFile() || current.ino !== entry.ino || current.dev !== entry.dev) throw new Error('原文件身份已变化，文件保留。')
            await unlink(join(root, file.path))
          }
          await syncDirectory()
          db.prepare("UPDATE file_operations SET state='done',error=NULL,completed_at=?,recovered_at=? WHERE id=?").run(now(), now(), file.id)
        } catch (error) {
          db.prepare("UPDATE file_operations SET state='failed',error=? WHERE id=?").run(error.code || 'DELETE_FILE_UNVERIFIED', file.id)
          return
        }
      }
    }
    db.prepare("UPDATE deletion_operations SET state='done',completed_at=? WHERE id=?").run(now(), operation.id)
  }
  async function recover() {
    for (const operation of db.prepare("SELECT id FROM deletion_operations WHERE state='committed'").all()) await settle(operation.id)
  }
  async function commit(preview, operationId) {
    operationId = requireId(operationId)
    const repeated = receipt(operationId, preview.target.bucket, preview.target.id, preview.confirmedRevision || preview.revision)
    if (repeated) { await settle(operationId); return receipt(operationId, preview.target.bucket, preview.target.id, preview.confirmedRevision || preview.revision) }
    let original = null
    if (preview.target.bucket === 'documents') {
      original = await fingerprint(preview.target.id)
      const document = row('documents', preview.target.id)
      if (document) {
        const value = decodeRecord('documents', preview.target.id, document.body)
        if (original && value.source?.sha256 && original.sha256 !== value.source.sha256) throw new HttpError(409, '原文件校验值与文献不一致，未删除；请先检查资料库。')
      }
    }
    const fileId = preview.target.bucket === 'documents' ? randomUUID() : null
    const result = { operationId, target: preview.target, recordIds: [...preview.removes, ...preview.tasks.filter(task => task.removesRecord)].map(value => ({ bucket: value.bucket, id: requireId(value.id) })), deletedRecords: preview.removes.length, deletedTasks: preview.tasks.filter(task => task.removesRecord).length, detachedLinks: preview.links.length, retainedResearch: preview.preserves.research.length, policy: preview.policy }
    let committed = false
    db.exec('BEGIN IMMEDIATE')
    try {
      if (db.prepare('SELECT bucket FROM records WHERE bucket NOT IN (?,?,?,?,?,?,?) LIMIT 1').get(...recordBuckets)) throw new HttpError(409, '资料库包含未知类型记录，删除范围不完整，未执行删除。')
      const snapshot = Object.fromEntries(recordBuckets.map(bucket => [bucket, db.prepare('SELECT id,body FROM records WHERE bucket=?').all(bucket).map(value => decodeRecord(bucket, value.id, value.body)).sort((a, b) => a.id.localeCompare(b.id))]))
      if (deletionConfirmationRevision(snapshot) !== preview.revision) throw new HttpError(409, '资料已变化，请刷新删除影响范围后重新确认。')
      if (!preview.complete || preview.tasks.some(task => task.active)) throw new HttpError(409, '影响范围不完整或相关任务尚未结束，未执行删除。')
      for (const task of preview.tasks) if (snapshot[task.bucket].some(value => value.id.toLowerCase() === task.id.toLowerCase() && ['queued', 'running'].includes(value.status))) throw new HttpError(409, '相关任务仍在运行，未执行删除。')
      db.prepare('INSERT INTO deletion_operations(id,target_bucket,target_id,preview_revision,result,file_operation_id,state,created_at) VALUES(?,?,?,?,?,?,?,?)').run(operationId, preview.target.bucket, requireId(preview.target.id), preview.confirmedRevision || preview.revision, JSON.stringify(result), fileId, 'committed', now())
      const removed = [...preview.removes, ...preview.tasks.filter(task => task.removesRecord)]
      const selected = new Set(removed.map(value => `${value.bucket}/${requireId(value.id)}`))
      for (const target of removed) {
        db.prepare('INSERT INTO record_deletions(bucket,id,operation_id,deleted_at) VALUES(?,?,?,?)').run(target.bucket, requireId(target.id), operationId, now())
        db.prepare('DELETE FROM records WHERE bucket=? AND id=?').run(target.bucket, requireId(target.id))
      }
      for (const topicId of new Set(preview.links.map(link => requireId(link.topicId)))) {
        if (selected.has(`topics/${topicId}`)) continue
        const current = row('topics', topicId)
        if (!current) throw new HttpError(409, '研究主题已变化，未执行删除。')
        const topic = decodeRecord('topics', topicId, current.body)
        write('topics', { ...topic, documents: topic.documents.filter(link => !selected.has(`documents/${requireId(link.documentId)}`)), updatedAt: now() })
      }
      if (fileId) db.prepare('INSERT INTO file_operations(id,operation,document_id,path,expected_sha256,state,created_at) VALUES(?,?,?,?,?,?,?)').run(fileId, 'remove', requireId(preview.target.id), `originals/${requireId(preview.target.id)}`, original?.sha256 || null, 'pending', now())
      db.exec('PRAGMA user_version=2; COMMIT'); committed = true
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* SQLite may have already ended a failed transaction. */ }
      if (db.isTransaction !== true && receipt(operationId, preview.target.bucket, preview.target.id, preview.confirmedRevision || preview.revision)) committed = true
      else throw error
    }
    if (committed) {
      try { await settle(operationId) } catch { /* Durable receipt remains retryable after a file/journal failure. */ }
      return receipt(operationId, preview.target.bucket, preview.target.id, preview.confirmedRevision || preview.revision)
    }
  }
  function issues() {
    return db.prepare(`SELECT f.document_id FROM deletion_operations o JOIN file_operations f ON f.id=o.file_operation_id WHERE o.state='committed' AND f.state!='done'`).all().map(value => ({ path: `originals/${value.document_id}`, reason: 'DELETION_FILE_PENDING', message: '研究记录已删除，原文件清理尚未完成，请检查文件权限及删除待办。' }))
  }
  return { marker, receipt, commit, recover, issues, ownsFileOperation: id => Boolean(db.prepare('SELECT id FROM deletion_operations WHERE file_operation_id=?').get(id)) }
}
