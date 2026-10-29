import { mkdir, readdir, lstat, readFile, writeFile, copyFile, rename, mkdtemp, rm } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { acquireDataLock } from './data-lock.mjs'
import { requireId } from './store.mjs'
import { storageLayout, recordBuckets } from './storage-layout.mjs'
import { decodeRecord, recordDigest, recordSizeLimit } from './record-integrity.mjs'
import { evidenceVersion } from './evidence.mjs'
import { backupLimits, allowedBackupPath, verifyBackup, restoreLibrary, durable, stageFor, publish } from './storage-maintenance.mjs'
import { restoreZipLibrary } from './storage-zip.mjs'
import { readFileOperation, validateFileOperation } from './file-operations.mjs'
import { checkDatabaseVersion } from './sqlite-deletions.mjs'

const rootFiles = ['library-manifest.json', 'library.sqlite', 'library.sqlite-wal', 'library.sqlite-shm', 'library.sqlite-journal']
const folders = [...recordBuckets, 'originals', 'quarantine', '.file-operations']
const hash = async path => { const digest = createHash('sha256'); for await (const chunk of createReadStream(path)) digest.update(chunk); return digest.digest('hex') }
async function info(path) { try { return await lstat(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
async function safeFile(root, path) {
  if (!allowedBackupPath(path) && !rootFiles.includes(path)) throw new Error('恢复路径无效。')
  let current = root
  for (const part of path.split('/')) {
    current = join(current, part)
    const entry = await info(current)
    if (!entry) return null
    if (entry.isSymbolicLink()) throw new Error('资料包含符号链接，未执行恢复。')
  }
  const entry = await lstat(current)
  if (!entry.isFile()) throw new Error('恢复来源不是普通文件。')
  return entry
}
async function fileState(root, path) { const entry = await safeFile(root, path); return entry ? { sha256: await hash(join(root, path)), size: entry.size } : { sha256: null, size: 0 } }
async function copyChecked(source, destination, file) {
  const entry = await safeFile(source, file.path)
  if (!entry || entry.size !== file.size || await hash(join(source, file.path)) !== file.sha256) throw new Error('资料在恢复过程中发生变化，请重新预览。')
  const target = join(destination, file.path)
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  await copyFile(join(source, file.path), target, 1)
  if (await hash(target) !== file.sha256) throw new Error('保全副本校验失败。')
  await durable(target)
}
async function syncedBytes(path, bytes) {
  const temporary = path + '.' + randomUUID() + '.tmp'
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
  await durable(temporary); await rename(temporary, path); await durable(dirname(path))
}
const syncedJson = (path, value) => syncedBytes(path, JSON.stringify(value, null, 2))

// A preservation copy is deliberately not an ordinary verified backup: missing
// originals or corrupt database pages must be copied as evidence, not blessed.
export async function preserveLocked(root, destination) {
  const { stage, target } = await stageFor(destination, root), files = []
  let bytes = 0
  async function collect(path) {
    const entry = await info(join(root, path))
    if (!entry) return
    if (entry.isSymbolicLink()) throw new Error('保全不跟随符号链接，请先核对不安全路径。')
    if (entry.isDirectory()) { for (const name of (await readdir(join(root, path))).sort()) await collect(path + '/' + name); return }
    if (!entry.isFile()) throw new Error('保全来源含不支持的文件类型。')
    bytes += entry.size
    if (files.length >= backupLimits.files || bytes > backupLimits.bytes) throw new Error('保全文件数量或大小超限。')
    files.push({ path, size: entry.size, sha256: await hash(join(root, path)) })
  }
  try {
    for (const path of [...folders, ...rootFiles]) await collect(path)
    for (const file of files) await copyChecked(root, stage, file)
    const manifest = { preservationVersion: 1, createdAt: new Date().toISOString(), verifiedFilesOnly: true, databaseIntegrityNotGuaranteed: true, files }
    await syncedJson(join(stage, 'preservation-manifest.json'), manifest)
    await publish(stage, target)
    return { destination: target, manifest }
  } catch (error) { if (!error.publishedDestination) error.message += '；来源保留，保全暂存目录为 ' + stage; throw error }
}
export async function preserveLibrary(source, destination) {
  if (!(await lstat(source)).isDirectory()) throw new Error('请选择实际资料库目录。')
  const owner = await acquireDataLock(source)
  try { return await preserveLocked(owner.root, destination) } finally { owner.release() }
}

function database(root, readOnly = true) {
  const db = new DatabaseSync(join(root, 'library.sqlite'), { readOnly })
  try {
    checkDatabaseVersion(db)
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('数据库完整性或版本不受支持。请保全原始资料，再从完整备份恢复；不尝试跳过损坏数据库页。')
    return db
  } catch (error) { db.close(); throw error }
}
async function indexLibrary(root) {
  const layout = await storageLayout(root), records = new Map(), temporary = [], blocked = []
  function add(bucket, id, bytes, path, temp = false) {
    const descriptor = { bucket, id, path, sha256: recordDigest(bytes) }
    try {
      const value = decodeRecord(bucket, id, bytes)
      Object.assign(descriptor, { valid: true, savedAt: value.updatedAt || value.createdAt, revision: value.revision ?? null })
      if (bucket === 'documents') Object.assign(descriptor, { evidenceVersion: evidenceVersion(value), originalHash: value.source?.sha256 || null })
    } catch { descriptor.valid = false }
    if (temp) { if (descriptor.valid) temporary.push(descriptor); else blocked.push(path) }
    else records.set(bucket + '/' + id, descriptor)
  }
  if (layout.storage === 'sqlite') {
    for (const path of rootFiles.filter(path => path.startsWith('library.sqlite'))) await safeFile(root, path)
    const db = database(root)
    try {
      for (const row of db.prepare('SELECT bucket,id,body FROM records ORDER BY bucket,id').iterate()) {
        try { if (!recordBuckets.includes(row.bucket) || requireId(row.id) !== row.id) throw new Error() }
        catch { blocked.push(`${row.bucket}/${row.id}`); continue }
        add(row.bucket, row.id, row.body, `${row.bucket}/${row.id}`)
      }
    } finally { db.close() }
  } else for (const bucket of recordBuckets) {
    const folder = await info(join(root, bucket))
    if (!folder) continue
    if (!folder.isDirectory()) throw new Error('记录目录不安全，未读取：' + bucket)
    for (const name of (await readdir(join(root, bucket))).sort()) {
      const temp = name.endsWith('.tmp'), match = temp ? name.match(/^([a-f0-9-]{36})\.json\..+\.tmp$/i) : name.match(/^([a-f0-9-]{36})\.json$/i)
      if (!match) { if (temp || name.endsWith('.json')) blocked.push(`${bucket}/${name}`); continue }
      const id = requireId(match[1]), path = `${bucket}/${name}`, entry = await safeFile(root, path)
      if (!entry) continue
      if (entry.size > recordSizeLimit) { if (temp) blocked.push(path); else records.set(bucket + '/' + id, { bucket, id, path, valid: false, sha256: await hash(join(root, path)) }); continue }
      add(bucket, id, await readFile(join(root, path)), path, temp)
    }
  }
  if (records.size + temporary.length > backupLimits.files) throw new Error('恢复记录数量超限。')
  return { storage: layout.storage, records, temporary, blocked }
}
async function withBackup(source, format, work) {
  if (!['directory', 'zip'].includes(format)) throw new Error('不支持的备份格式。')
  const workspace = await mkdtemp(join(tmpdir(), 'classifier-repair-backup-'))
  try {
    const root = join(workspace, 'backup')
    if (format === 'zip') await restoreZipLibrary(source, root)
    else {
      if (!(await lstat(source)).isDirectory()) throw new Error('请选择实际备份目录。')
      const manifest = await verifyBackup(source)
      await restoreLibrary(source, root)
      await syncedJson(join(root, 'backup-manifest.json'), manifest)
    }
    return await work(root, await verifyBackup(root))
  } finally { await rm(workspace, { recursive: true, force: true }) }
}

const compatibility = manifest => ({ version: 1, revision: recordDigest(JSON.stringify(manifest)), storage: manifest.storage, formatVersion: manifest.formatVersion, snapshotCreatedAt: manifest.createdAt, files: manifest.files.length })
export async function backupCompatibility(backup, { format = 'directory' } = {}) {
  return withBackup(backup, format, async (root, manifest) => {
    const { inspectLibrary } = await import('./library-inspection.mjs')
    const check = await inspectLibrary(root)
    if (check.truncated || check.issues.some(issue => issue.severity === 'error')) throw new Error('备份可校验，但研究资料检查未通过，请先核对或选择其他备份。')
    return compatibility(manifest)
  })
}

// This path deliberately never opens the old business store: it is also used
// when an older compatible application refuses a newer library format.
export async function restoreUnavailableLibrary(source, backup, destination, preservation, { format = 'directory', revision } = {}) {
  if (!(await lstat(source)).isDirectory()) throw new Error('原资料库目录不存在，未改用空目录。')
  const owner = await acquireDataLock(source)
  let preserved
  try {
    return await withBackup(backup, format, async (snapshot, manifest) => {
      if (!revision || compatibility(manifest).revision !== revision) throw new Error('备份在确认后发生变化，请重新选择并核对备份时点。')
      const { inspectLibrary } = await import('./library-inspection.mjs')
      const check = await inspectLibrary(snapshot)
      if (check.truncated || check.issues.some(issue => issue.severity === 'error')) throw new Error('兼容备份检查未通过，未切换资料库。')
      preserved = await preserveLocked(owner.root, preservation)
      const result = await restoreLibrary(snapshot, destination)
      return { ...result, preservation: preserved.destination, snapshotCreatedAt: manifest.createdAt }
    })
  } catch (error) { error.message += '；原资料库完整保留' + (preserved ? '，原件保全副本为 ' + preserved.destination : ''); throw error }
  finally { owner.release() }
}

async function planLocked(root, backupRoot, manifest) {
  const current = await indexLibrary(root), backup = await indexLibrary(backupRoot), items = [], operations = new Map()
  const files = new Map(manifest.files.map(file => [file.path, file]))
  const states = new Map(), state = async id => {
    if (!states.has(id)) states.set(id, await fileState(root, 'originals/' + id))
    return states.get(id)
  }
  function choice(item, from, candidate, original = null) {
    const key = recordDigest(JSON.stringify([item.target, item.currentSha256, from, candidate.path, candidate.sha256, original?.sha256 || null]))
    item.choices.push({ key, from, savedAt: candidate.savedAt || manifest.createdAt, revision: candidate.revision ?? null, includesOriginal: Boolean(original) })
    operations.set(key, { ...item, candidate, original, from })
  }
  const targets = new Map([...current.records].filter(([, value]) => !value.valid))
  for (const temp of current.temporary) if (!targets.has(temp.bucket + '/' + temp.id)) targets.set(temp.bucket + '/' + temp.id, current.records.get(temp.bucket + '/' + temp.id) || { bucket: temp.bucket, id: temp.id, sha256: null, path: `${temp.bucket}/${temp.id}.json` })
  for (const [target, broken] of targets) {
    const item = { target, type: 'record', bucket: broken.bucket, id: broken.id, currentSha256: broken.sha256, currentPath: broken.path, currentReadable: Boolean(broken.valid), choices: [] }
    const candidates = [...(broken.valid ? [] : [{ from: 'backup', descriptor: backup.records.get(target) }]), ...current.temporary.filter(temp => temp.bucket + '/' + temp.id === target).map(descriptor => ({ from: 'temporary', descriptor }))]
    for (const { from, descriptor } of candidates) {
      if (!descriptor?.valid) continue
      let original = null
      if (broken.bucket === 'documents') {
        const file = files.get('originals/' + broken.id), originalState = await state(broken.id)
        if (from === 'backup') {
          if (!file || descriptor.originalHash && descriptor.originalHash !== file.sha256) continue
          original = file
        } else if (!originalState.sha256 || descriptor.originalHash && descriptor.originalHash !== originalState.sha256) {
          if (!file || !descriptor.originalHash || descriptor.originalHash !== file.sha256) continue
          original = file
        }
        item.currentOriginalSha256 = originalState.sha256
      }
      choice(item, from, descriptor, original)
    }
    items.push(item)
  }
  for (const [target, descriptor] of current.records) if (descriptor.valid && descriptor.bucket === 'documents') {
    const original = await state(descriptor.id)
    if (original.sha256 && (!descriptor.originalHash || descriptor.originalHash === original.sha256)) continue
    const file = files.get('originals/' + descriptor.id), backupDocument = backup.records.get(target)
    const item = { target: 'originals/' + descriptor.id, type: 'original', bucket: 'documents', id: descriptor.id, currentSha256: original.sha256, documentSha256: descriptor.sha256, choices: [] }
    if (file && (descriptor.originalHash ? descriptor.originalHash === file.sha256 : backupDocument?.valid && backupDocument.evidenceVersion === descriptor.evidenceVersion)) choice(item, 'backup', file, file)
    items.push(item)
  }
  items.sort((a, b) => a.target.localeCompare(b.target))
  const backupFingerprint = recordDigest(JSON.stringify(manifest))
  const revision = recordDigest(JSON.stringify([backupFingerprint, items]))
  return { public: { version: 1, revision, storage: current.storage, snapshotCreatedAt: manifest.createdAt, items: items.slice(0, 1000), itemCount: items.length, blockedCount: current.blocked.length, truncated: items.length > 1000 }, operations, current }
}
export async function previewLibraryRecovery(source, backup, { format = 'directory' } = {}) {
  const owner = await acquireDataLock(source)
  try { return await withBackup(backup, format, async (root, manifest) => ({ ...(await planLocked(owner.root, root, manifest)).public, format, selections: [] })) }
  finally { owner.release() }
}

async function candidateBytes(root, storage, candidate) {
  let bytes
  if (storage === 'sqlite') {
    const db = database(root)
    try { bytes = db.prepare('SELECT body FROM records WHERE bucket=? AND id=?').get(candidate.bucket, candidate.id)?.body }
    finally { db.close() }
  } else { await safeFile(root, candidate.path); bytes = await readFile(join(root, candidate.path)) }
  if (bytes === undefined || recordDigest(bytes) !== candidate.sha256) throw new Error('恢复候选已变化，请重新预览。')
  decodeRecord(candidate.bucket, candidate.id, bytes)
  return bytes
}
async function supersedeFileOperations(root, db, ids) {
  const superseded = [], recoveredAt = new Date().toISOString()
  if (db) {
    let rows
    try { rows = db.prepare("SELECT * FROM file_operations WHERE state IN ('pending','failed')").all() }
    catch (error) { if (/no such table/i.test(error.message)) return superseded; throw error }
    for (const row of rows) {
      try { validateFileOperation({ ...row, documentId: row.document_id, expectedSha256: row.expected_sha256 }) }
      catch { continue }
      if (!ids.has(row.document_id)) continue
      db.prepare("UPDATE file_operations SET state='failed',error='SUPERSEDED_BY_RECOVERY',recovered_at=? WHERE id=?").run(recoveredAt, row.id)
      superseded.push(row.id)
    }
  } else {
    const directory = join(root, '.file-operations'), entry = await info(directory)
    if (!entry) return superseded
    if (!entry.isDirectory()) throw new Error('文件操作日志目录不安全。')
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.json')) continue
      let operation
      try { operation = await readFileOperation(directory, name) } catch { continue }
      if (!['pending', 'failed'].includes(operation.state) || !ids.has(operation.documentId)) continue
      await syncedJson(join(directory, name), { ...operation, state: 'failed', error: 'SUPERSEDED_BY_RECOVERY', recoveredAt })
      superseded.push(operation.id)
    }
  }
  return superseded
}
export async function recoverLibrary(source, backup, destination, preservation, { format = 'directory', revision, selections = [] } = {}) {
  if (!Array.isArray(selections) || !selections.length || selections.length > 1000 || new Set(selections).size !== selections.length || selections.some(key => !/^[a-f0-9]{64}$/.test(key))) throw new Error('请选择有效的恢复项目。')
  const owner = await acquireDataLock(source)
  let stage, preservedDirectory
  try {
    return await withBackup(backup, format, async (backupRoot, manifest) => {
      const plan = await planLocked(owner.root, backupRoot, manifest)
      if (revision !== plan.public.revision) throw new Error('资料或备份在预览后发生变化，请重新预览。')
      const operations = selections.map(key => plan.operations.get(key))
      if (operations.some(operation => !operation) || new Set(operations.map(operation => operation.target)).size !== operations.length) throw new Error('不能恢复未知项目或为同一记录选择两个版本。')
      const preserved = await preserveLocked(owner.root, preservation)
      preservedDirectory = preserved.destination
      const prepared = await stageFor(destination, owner.root); stage = prepared.stage
      for (const file of preserved.manifest.files) await copyChecked(preserved.destination, stage, file)
      if ((await planLocked(stage, backupRoot, manifest)).public.revision !== revision) throw new Error('保全期间资料发生变化，请重新预览。')
      const archive = `quarantine/recovery/${randomUUID()}`
      await mkdir(join(stage, archive), { recursive: true, mode: 0o700 })
      let db, superseded
      try {
        if (plan.current.storage === 'sqlite') { db = database(stage, false); db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE') }
        for (const operation of operations) {
          if (operation.type === 'record') {
            const bytes = await candidateBytes(operation.from === 'backup' ? backupRoot : owner.root, operation.from === 'backup' ? (await storageLayout(backupRoot)).storage : 'json', operation.candidate)
            if (db) db.prepare('INSERT INTO records(bucket,id,body) VALUES(?,?,?) ON CONFLICT(bucket,id) DO UPDATE SET body=excluded.body,generation=records.generation+1').run(operation.bucket, operation.id, bytes.toString())
            else await syncedBytes(join(stage, operation.bucket, operation.id + '.json'), bytes)
            if (operation.from === 'temporary') {
              const target = join(stage, archive, 'temporary', operation.bucket, operation.candidate.path.split('/').at(-1) + '.bin')
              await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await rename(join(stage, operation.candidate.path), target)
            }
          }
          if (operation.original) {
            const file = operation.original, target = join(stage, file.path), temporary = target + '.' + randomUUID() + '.tmp'
            await mkdir(dirname(target), { recursive: true, mode: 0o700 })
            await safeFile(backupRoot, file.path); await copyFile(join(backupRoot, file.path), temporary, 1)
            if (await hash(temporary) !== file.sha256) throw new Error('原文件候选校验失败。')
            await durable(temporary); await rename(temporary, target); await durable(dirname(target))
          }
        }
        const restoredDocuments = new Set(operations.filter(operation => operation.type === 'original' || operation.bucket === 'documents').map(operation => operation.id))
        superseded = await supersedeFileOperations(stage, db, restoredDocuments)
        if (db) { db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); db = null; await durable(join(stage, 'library.sqlite')) }
      } catch (error) { if (db) { try { db.exec('ROLLBACK') } catch { /* SQLITE_FULL may roll back automatically. */ } finally { db.close() } }; throw error }
      const report = { recoveryVersion: 1, createdAt: new Date().toISOString(), snapshotCreatedAt: manifest.createdAt, preservation: preserved.destination, supersededFileOperations: superseded, selections: operations.map(operation => ({ target: operation.target, from: operation.from, beforeSha256: operation.currentSha256, restoredSha256: operation.candidate.sha256, includesOriginal: Boolean(operation.original) })) }
      await syncedJson(join(stage, archive, 'report.json'), report)
      // Re-index without starting business storage: unfinished jobs are not
      // mutated during validation, and remaining bad records stay isolated.
      const checked = await indexLibrary(stage)
      for (const operation of operations) if (operation.type === 'record' && !checked.records.get(operation.target)?.valid) throw new Error('恢复后的记录校验未通过。')
      await publish(stage, prepared.target)
      return { destination: prepared.target, preservation: preserved.destination, restored: operations.length, supersededFileOperations: superseded.length, remainingDamagedRecords: [...checked.records.values()].filter(record => !record.valid).length, report: archive + '/report.json' }
    })
  } catch (error) { error.message += '；原资料库保留' + (preservedDirectory ? '，原件保全副本为 ' + preservedDirectory : '') + (stage && !error.publishedDestination ? '，恢复暂存目录为 ' + stage : ''); throw error }
  finally { owner.release() }
}
