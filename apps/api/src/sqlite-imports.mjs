import { open, lstat, link, unlink } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { requireId } from './store.mjs'
import { decodeRecord } from './record-integrity.mjs'
import { HttpError } from './http.mjs'

export const importOperationsSchema = "CREATE TABLE IF NOT EXISTS import_operations(id TEXT PRIMARY KEY,document_id TEXT NOT NULL UNIQUE,job_id TEXT,temporary_path TEXT NOT NULL,path TEXT NOT NULL,expected_sha256 TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','done','aborted')),error TEXT,created_at TEXT NOT NULL,completed_at TEXT);"
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const now = () => new Date().toISOString()
const unsafe = () => new Error('导入文件待办的身份或路径无效，原文件保留。')

export function validateImportOperation(operation) {
  if (!operation || requireId(operation.id) !== operation.id || requireId(operation.document_id) !== operation.document_id ||
    operation.job_id !== null && requireId(operation.job_id) !== operation.job_id ||
    operation.path !== `originals/${operation.document_id}` || operation.temporary_path !== `originals/.import-${operation.id}.tmp` ||
    !/^[a-f0-9]{64}$/.test(operation.expected_sha256) || !['pending', 'done', 'aborted'].includes(operation.state)) throw unsafe()
}

export function createSqliteImports({ db, root, row, write, deletionMarker = () => null }) {
  async function directory() {
    if (!(await lstat(join(root, 'originals'))).isDirectory()) throw unsafe()
  }
  async function file(path) {
    await directory()
    try {
      const info = await lstat(join(root, path))
      if (!info.isFile()) throw unsafe()
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(join(root, path))) hash.update(chunk)
      return { sha256: hash.digest('hex'), ino: info.ino, dev: info.dev }
    } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }
  async function syncDirectory() {
    if (process.platform === 'win32') return
    const handle = await open(join(root, 'originals'), 'r')
    try { await handle.sync() } finally { await handle.close() }
  }
  async function removeMatching(path, expected) {
    const current = await file(path)
    if (!current) return
    if (current.sha256 !== expected) throw new Error('导入待办文件哈希不符，未删除；请保留并核对。')
    await unlink(join(root, path)); await syncDirectory()
  }
  async function settle(operation) {
    validateImportOperation(operation)
    const document = row('documents', operation.document_id)
    if (operation.state === 'done') {
      if (!document && deletionMarker('documents', operation.document_id)) {
        await removeMatching(operation.temporary_path, operation.expected_sha256)
        db.prepare('UPDATE import_operations SET error=NULL WHERE id=?').run(operation.id)
        return
      }
      if (!document) throw new Error('导入完成标记与文献记录不一致，文件保留。')
      const value = decodeRecord('documents', operation.document_id, document.body), original = await file(operation.path)
      if (!original || original.sha256 !== operation.expected_sha256 || value.source?.sha256 !== operation.expected_sha256) throw new Error('已提交导入的原文件不匹配，文件保留。')
      await removeMatching(operation.temporary_path, operation.expected_sha256)
    } else if (operation.state === 'pending') {
      // The transaction commits the record and done marker together. A pending
      // intent must therefore never erase a file owned by any document record.
      if (document) throw new Error('未提交导入与已有文献冲突，原文件保留。')
      const original = await file(operation.path), temporary = await file(operation.temporary_path)
      if ([original, temporary].some(value => value && value.sha256 !== operation.expected_sha256) ||
        original && (!temporary || original.ino !== temporary.ino || original.dev !== temporary.dev)) throw new Error('未提交导入的哈希或链接身份不一致，原文件与暂存文件保留。')
      await removeMatching(operation.path, operation.expected_sha256)
      await removeMatching(operation.temporary_path, operation.expected_sha256)
      db.prepare("UPDATE import_operations SET state='aborted',error=NULL,completed_at=? WHERE id=?").run(now(), operation.id)
    }
    db.prepare('UPDATE import_operations SET error=NULL WHERE id=?').run(operation.id)
  }
  async function recover() {
    for (const operation of db.prepare("SELECT * FROM import_operations WHERE state='pending' OR (state='done' AND error IS NOT NULL)").all()) {
      try { await settle(operation) }
      catch (error) { db.prepare('UPDATE import_operations SET error=? WHERE id=?').run(error.code || error.message, operation.id) }
    }
    // A crash after COMMIT but before temporary-file cleanup leaves a done
    // intent without an error. Reconcile those temp files too, without changing
    // the completed task or restoring any older version of its topic.
    for (const operation of db.prepare("SELECT * FROM import_operations WHERE state='done' AND error IS NULL").all()) {
      try {
        validateImportOperation(operation)
        if (await file(operation.temporary_path)) await settle(operation)
      } catch (error) { db.prepare('UPDATE import_operations SET error=? WHERE id=?').run(error.code || error.message, operation.id) }
    }
  }
  async function commitImport(document, bytes, { topicId = null, job = null, signal, onCommitting = () => {} } = {}) {
    const id = requireId(document.id), jobId = job ? requireId(job.id) : null
    if (deletionMarker('documents', id)) throw new HttpError(410, '原文已删除，不能通过重试旧导入重新写回。')
    topicId = topicId ? requireId(topicId) : null
    const expected = digest(bytes)
    if (document.id !== id || document.source?.sha256 !== expected || document.source?.byteLength !== bytes.length) throw new HttpError(422, '导入原文件与文献校验信息不一致。')
    decodeRecord('documents', id, JSON.stringify(document))
    if (row('documents', id)) throw new HttpError(409, '文献 ID 已存在，未覆盖现有资料。')
    signal?.throwIfAborted()
    await directory()
    if (await file(`originals/${id}`)) throw new HttpError(409, '原文件 ID 已存在，未覆盖现有文件。')
    const operation = { id: randomUUID(), document_id: id, job_id: jobId, path: `originals/${id}`, expected_sha256: expected, state: 'pending', created_at: now() }
    operation.temporary_path = `originals/.import-${operation.id}.tmp`
    db.prepare('INSERT INTO import_operations(id,document_id,job_id,temporary_path,path,expected_sha256,state,created_at) VALUES(?,?,?,?,?,?,?,?)').run(operation.id, id, jobId, operation.temporary_path, operation.path, expected, 'pending', operation.created_at)
    let committed = false, targetConflict = false
    try {
      const handle = await open(join(root, operation.temporary_path), 'wx', 0o600)
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
      signal?.throwIfAborted()
      // link is an exclusive publication: an existing original is never
      // overwritten. Both names reference already-synced bytes on this volume.
      try { await link(join(root, operation.temporary_path), join(root, operation.path)) }
      catch (error) { targetConflict = error.code === 'EEXIST'; throw error }
      await syncDirectory()
      signal?.throwIfAborted()
      onCommitting()
      db.exec('BEGIN IMMEDIATE')
      try {
        if (row('documents', id)) throw new HttpError(409, '文献记录在导入期间已出现，未覆盖。')
        let topic
        if (topicId) {
          const existing = row('topics', topicId)
          if (!existing) throw new HttpError(409, '导入主题已不可用，未提交文献。')
          topic = decodeRecord('topics', topicId, existing.body)
          if (!Array.isArray(topic.documents)) throw new HttpError(409, '导入主题关联信息损坏。')
        }
        let currentJob
        if (jobId) {
          const existing = row('imports', jobId)
          if (!existing) throw new HttpError(409, '导入任务记录已不可用。')
          currentJob = decodeRecord('imports', jobId, existing.body)
          if (!['queued', 'running'].includes(currentJob.status) || (currentJob.topicId || null) !== topicId) throw new HttpError(409, '导入任务状态已变化，未提交文献。')
        }
        write('documents', document)
        if (topic) {
          const time = now()
          write('topics', { ...topic, updatedAt: time, documents: [...topic.documents.filter(link => link.documentId !== id), { documentId: id, selection: 'pending', readingStatus: 'unread', relevance: '', reason: '', addedAt: time, updatedAt: time }] })
        }
        if (currentJob) write('imports', { ...currentJob, documentId: id, status: 'completed', finishedAt: now() })
        db.prepare("UPDATE import_operations SET state='done',completed_at=? WHERE id=?").run(now(), operation.id)
        db.exec('COMMIT'); committed = true
      } catch (error) {
        try { db.exec('ROLLBACK') } catch { /* Some SQLite I/O failures already end the transaction. */ }
        // Never turn an acknowledged durable commit into a failed import just
        // because a later boundary reported an error. The marker and task share
        // the same transaction, so its persisted state decides the outcome.
        const current = db.prepare('SELECT state FROM import_operations WHERE id=?').get(operation.id)
        if (db.isTransaction !== true && current?.state === 'done') committed = true
        else throw error
      }
    } catch (error) {
      if (!committed) {
        try {
          if (targetConflict) {
            await removeMatching(operation.temporary_path, expected)
            db.prepare("UPDATE import_operations SET state='aborted',error='TARGET_EXISTS',completed_at=? WHERE id=?").run(now(), operation.id)
          } else await settle(operation)
        }
        catch (cleanup) { db.prepare('UPDATE import_operations SET error=? WHERE id=?').run(cleanup.code || cleanup.message, operation.id); error.message += '；未提交原文件待清理，重启时将按哈希重新核对。' }
      }
      throw error
    }
    try { await removeMatching(operation.temporary_path, expected) }
    catch (error) { try { db.prepare('UPDATE import_operations SET error=? WHERE id=?').run(error.code || error.message, operation.id) } catch { /* The metadata commit already succeeded; startup checks every done intent. */ } }
    return { documentId: id, completed: true, operationId: operation.id }
  }
  return { commitImport, recover }
}
