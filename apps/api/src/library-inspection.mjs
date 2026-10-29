import { readdir, lstat, readFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { acquireDataLock } from './data-lock.mjs'
import { storageLayout, storageManifestName, recordBuckets } from './storage-layout.mjs'
import { requireId } from './store.mjs'
import { readFileOperation, validateFileOperation } from './file-operations.mjs'
import { decodeRecord } from './record-integrity.mjs'
import { validateImportOperation } from './sqlite-imports.mjs'
import { checkDatabaseVersion } from './sqlite-deletions.mjs'

// Offline inspection takes directory ownership but never opens the writable
// business store (which would mark unfinished tasks as interrupted).
export async function inspectLibrary(directory) {
  if (!(await lstat(directory)).isDirectory()) throw new Error('请选择实际资料库目录。')
  const owner = await acquireDataLock(directory)
  try {
    const root = owner.root, issues = [], documents = new Map()
    const result = { storage: null, records: 0, originals: 0, quarantinedRecords: 0, fileOperations: { pending: 0, failed: 0, done: 0 }, importOperations: { pending: 0, done: 0, aborted: 0 }, issueCount: 0, issues, truncated: false }
    function issue(code, path, message, severity = 'error') {
      result.issueCount++
      if (issues.length < 1000) issues.push({ code, path, severity, message })
      else result.truncated = true
    }
    async function info(path) {
      try { return await lstat(join(root, path)) }
      catch (error) { if (error.code === 'ENOENT') return null; throw error }
    }
    function record(bucket, id, bytes, path) {
      try {
        const value = decodeRecord(bucket, id, bytes)
        result.records++
        if (bucket === 'documents') documents.set(requireId(id), value)
      } catch { issue('invalid-record', path, '记录无法解析或身份字段无效；请保留原文件，从备份核对。') }
    }
    const manifest = await info(storageManifestName), database = await info('library.sqlite')
    if (manifest && !manifest.isFile() || database && !database.isFile()) {
      issue('unsafe-path', 'library-manifest.json / library.sqlite', '清单或数据库不是普通文件，未读取。')
      return result
    }
    let layout
    try { layout = await storageLayout(root) }
    catch { issue('invalid-layout', storageManifestName, '格式不兼容、清单损坏或迁移未完成；请核对版本及迁移进度。'); return result }
    result.storage = layout.storage
    if (layout.storage === 'sqlite') {
      for (const path of ['library.sqlite', 'library.sqlite-wal', 'library.sqlite-shm', 'library.sqlite-journal']) {
        const entry = await info(path)
        if (entry && !entry.isFile()) { issue('unsafe-path', path, '数据库路径不是普通文件，未打开数据库。'); return result }
      }
      if (!database) { issue('missing-database', 'library.sqlite', '数据库文件缺失，请从备份恢复。'); return result }
      let db
      try {
        db = new DatabaseSync(join(root, 'library.sqlite'), { readOnly: true })
        if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Invalid database')
        try { checkDatabaseVersion(db) } catch {
          issue('unsupported-database', 'library.sqlite', '数据库版本不受支持，请使用兼容版本。'); return result
        }
        try {
          for (const operation of db.prepare('SELECT * FROM file_operations').all()) {
            try { validateFileOperation({ ...operation, documentId: operation.document_id, expectedSha256: operation.expected_sha256 }) }
            catch { issue('invalid-file-operation', 'library.sqlite:file_operations', '文件操作日志身份或路径无效，未执行恢复。') }
            if (['pending', 'done', 'failed'].includes(operation.state)) result.fileOperations[operation.state]++
            else issue('invalid-file-operation', 'library.sqlite:file_operations', '文件操作日志状态无效。')
            if (operation.state === 'pending') issue('pending-file-operation', 'library.sqlite:file_operations', '文件操作尚未确认完成，将在服务启动时尝试恢复。')
            if (operation.state === 'failed') {
              if (operation.error === 'SUPERSEDED_BY_RECOVERY') issue('superseded-file-operation', 'library.sqlite:file_operations', '旧文件操作已由所选恢复版本替代，不再重放；原始日志保留在原库及保全副本。', 'info')
              else issue('failed-file-operation', 'library.sqlite:file_operations', `文件操作失败：${operation.error || '未知原因'}。`)
            }
          }
        } catch (error) { if (!/no such table/i.test(error.message)) throw error }
        try {
          for (const operation of db.prepare('SELECT * FROM import_operations').iterate()) {
            try { validateImportOperation(operation); result.importOperations[operation.state]++ }
            catch { issue('invalid-import-operation', 'library.sqlite:import_operations', '导入待办身份或路径无效，未执行自动清理。'); continue }
            if (operation.state === 'pending' || operation.error) issue('pending-import-operation', 'library.sqlite:import_operations', operation.error ? '导入原文件待办未能安全清理，请保留原件并核对。' : '发现未提交的导入原文件，服务启动时会按身份和哈希核对。', operation.state === 'done' ? 'warning' : 'error')
          }
        } catch (error) { if (!/no such table/i.test(error.message)) throw error }
        for (const row of db.prepare('SELECT bucket,id,body FROM records').iterate()) record(row.bucket, row.id, row.body, `${row.bucket}/${row.id}`)
      } catch { issue('invalid-database', 'library.sqlite', '数据库无法读取或完整性校验失败，请保留当前库并恢复到新目录。') }
      finally { db?.close() }
    } else {
      for (const bucket of recordBuckets) {
        const entry = await info(bucket)
        if (!entry) continue
        if (!entry.isDirectory()) { issue('unsafe-path', bucket, '记录目录类型无效，未读取。'); continue }
        for (const name of (await readdir(join(root, bucket))).sort()) {
          const path = `${bucket}/${name}`, entry = await info(path)
          if (!entry?.isFile()) { issue('unsafe-path', path, '非普通记录文件，未读取。'); continue }
          if (name.endsWith('.tmp')) { issue('interrupted-write', path, '发现未提交的临时文件，请与备份核对后选择恢复。'); continue }
          if (!name.endsWith('.json')) { issue('ignored-file', path, '非记录文件，保留但不载入资料库。', 'info'); continue }
          if (entry.size > 32 * 1024 ** 2) { issue('record-too-large', path, '记录超过检查大小上限，尚未验证。'); continue }
          record(bucket, name.slice(0, -5), await readFile(join(root, path), 'utf8'), path)
        }
      }
    }
    const operationDirectory = await info('.file-operations')
    if (operationDirectory) {
      if (!operationDirectory.isDirectory()) issue('unsafe-path', '.file-operations', '文件操作日志目录类型无效。')
      else for (const name of await readdir(join(root, '.file-operations'))) {
        if (!name.endsWith('.json')) { issue('ignored-file', `.file-operations/${name}`, '非日志文件，保留但不载入。', 'info'); continue }
        try {
          const operation = await readFileOperation(join(root, '.file-operations'), name), state = operation.state
          if (!['pending', 'done', 'failed'].includes(state)) issue('invalid-file-operation', `.file-operations/${name}`, '文件操作日志状态无效。')
          else {
            result.fileOperations[state]++
            if (state === 'pending') issue('pending-file-operation', `.file-operations/${name}`, '文件操作尚未确认完成，将在服务启动时尝试恢复。')
            if (state === 'failed') {
              if (operation.error === 'SUPERSEDED_BY_RECOVERY') issue('superseded-file-operation', `.file-operations/${name}`, '旧文件操作已由所选恢复版本替代，不再重放；原始日志保留在原库及保全副本。', 'info')
              else issue('failed-file-operation', `.file-operations/${name}`, `文件操作失败：${operation.error || '未知原因'}。`)
            }
          }
        } catch { issue('invalid-file-operation', `.file-operations/${name}`, '文件操作日志损坏、身份或路径无效，保留且未执行恢复。') }
      }
    }
    const quarantine = await info('quarantine')
    if (quarantine && !quarantine.isDirectory()) issue('unsafe-path', 'quarantine', '隔离区不是实际目录，未读取。')
    else if (quarantine) {
      const records = await info('quarantine/records')
      if (records && !records.isDirectory()) issue('unsafe-path', 'quarantine/records', '隔离记录目录类型无效。')
      else if (records) for (const name of await readdir(join(root, 'quarantine/records'))) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
        const path = 'quarantine/records/' + name
        try {
          const entry = await info(path)
          if (!entry?.isFile() || entry.size > 64 * 1024) throw new Error()
          const metadata = JSON.parse(await readFile(join(root, path), 'utf8'))
          if (metadata.version !== 1 || metadata.faultId !== name.slice(0, -5) || metadata.rawPath !== 'quarantine/records/' + metadata.faultId + '.bin' || !/^[a-f0-9]{64}$/.test(metadata.sha256)) throw new Error()
          const raw = await info(metadata.rawPath)
          if (!raw?.isFile() || raw.size !== metadata.bytes || raw.size > 32 * 1024 ** 2) throw new Error()
          const digest = createHash('sha256')
          for await (const chunk of createReadStream(join(root, metadata.rawPath))) digest.update(chunk)
          if (digest.digest('hex') !== metadata.sha256) throw new Error()
          result.quarantinedRecords++
        } catch { issue('invalid-quarantine', path, '隔离副本缺失、损坏或无法安全校验；原记录仍需保留并核对。') }
      }
    }
    const originals = await info('originals')
    if (originals && !originals.isDirectory()) { issue('unsafe-path', 'originals', '原文件目录类型无效，未读取。'); return result }
    for (const [id, document] of documents) {
      const path = `originals/${id}`, entry = await info(path)
      if (!entry) { issue('missing-original', path, '文献记录存在，但原文件缺失。'); continue }
      if (!entry.isFile()) { issue('unsafe-path', path, '原文件不是普通文件，未读取。'); continue }
      result.originals++
      if (document.source?.sha256) {
        const digest = createHash('sha256')
        for await (const chunk of createReadStream(join(root, path))) digest.update(chunk)
        if (digest.digest('hex') !== document.source.sha256) issue('original-mismatch', path, '原文件与记录中的校验值不一致，请从备份核对。')
      }
    }
    if (originals) for (const name of (await readdir(join(root, 'originals'))).sort()) {
      if (!documents.has(name)) issue('unmatched-original', `originals/${name}`, '未匹配到有效文献记录；可能与损坏记录有关，请勿直接删除。', 'warning')
    }
    return result
  } finally { owner.release() }
}
