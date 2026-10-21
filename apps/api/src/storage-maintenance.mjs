// Explicit offline operations only. The application never migrates on startup.
import { mkdir, readdir, lstat, readFile, writeFile, copyFile, realpath, rename, access, open } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join, resolve, dirname, basename, relative, isAbsolute } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { acquireDataLock } from './data-lock.mjs'
import { storageLayout, storageManifestName, recordBuckets } from './storage-layout.mjs'
import { initializeDatabase } from './sqlite-store.mjs'
import { requireId } from './store.mjs'

const limits = { files: 200000, bytes: 20 * 1024 ** 3 }
const directories = [...recordBuckets, 'originals', 'quarantine']
const allowed = path => !isAbsolute(path) && !path.includes('\\') && !path.split('/').some(part => !part || part === '.' || part === '..') && (['library.sqlite', storageManifestName].includes(path) || directories.includes(path.split('/')[0]))
async function hash(path) { const digest = createHash('sha256'); for await (const chunk of createReadStream(path)) digest.update(chunk); return digest.digest('hex') }
async function exists(path) { try { await access(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
async function durable(path) { const file = await open(path, 'r'); try { await file.sync() } finally { await file.close() } }
async function publish(stage, target) {
  // Children and their directory entries are durable before the final sibling
  // rename. Failed staging directories remain inspectable and are never opened.
  const pending = [stage]
  for (let i = 0; i < pending.length; i++) for (const name of await readdir(pending[i])) {
    const path = join(pending[i], name); if ((await lstat(path)).isDirectory()) pending.push(path)
  }
  for (const directory of pending.reverse()) await durable(directory)
  if (await exists(target)) throw new Error('目标目录已存在，未覆盖现有资料。')
  await rename(stage, target); await durable(dirname(target))
}
async function stageFor(destination, source) {
  const parent = await realpath(dirname(resolve(destination)))
  const target = join(parent, basename(destination)), from = await realpath(source)
  const rel = relative(from, target)
  if (rel === '' || (!rel.startsWith('..' + '/') && rel !== '..' && !isAbsolute(rel))) throw new Error('备份或恢复目标必须位于来源目录之外。')
  if (await exists(target)) throw new Error('目标目录已存在；请指定新目录以保留现有资料。')
  const stage = target + '.partial-' + randomUUID()
  await mkdir(stage, { mode: 0o700 })
  return { stage, target }
}
async function filesUnder(root, folder = '') {
  const output = []
  for (const name of await readdir(join(root, folder))) {
    const path = folder ? folder + '/' + name : name
    const info = await lstat(join(root, path))
    if (info.isSymbolicLink()) throw new Error('资料目录包含符号链接，未执行复制：' + path)
    if (info.isDirectory()) output.push(...await filesUnder(root, path))
    else if (info.isFile()) output.push({ path, size: info.size })
    else throw new Error('资料目录包含不支持的文件类型：' + path)
  }
  return output
}
async function snapshotFiles(root, layout) {
  let files = []
  for (const folder of directories) {
    if (layout.storage === 'sqlite' && recordBuckets.includes(folder)) continue
    if (await exists(join(root, folder))) {
      if (!(await lstat(join(root, folder))).isDirectory()) throw new Error('资料目录类型无效：' + folder)
      files.push(...await filesUnder(root, folder))
    }
  }
  if (layout.storage === 'sqlite') files.push({ path: storageManifestName, size: (await lstat(join(root, storageManifestName))).size })
  return files
}
async function copyVerified(source, destination, files) {
  const output = [], seen = new Set()
  let bytes = 0
  if (files.length > limits.files) throw new Error('备份文件数量超限。')
  for (const file of files) {
    if (!allowed(file.path) || seen.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error('备份文件清单无效。')
    seen.add(file.path); bytes += file.size
    if (bytes > limits.bytes) throw new Error('备份展开大小超过 20 GiB 限制。')
    const sourcePath = join(source, file.path), destinationPath = join(destination, file.path)
    // Verify each path component before copying; a parent symlink is also rejected.
    let current = source
    for (const component of file.path.split('/')) { current = join(current, component); if ((await lstat(current)).isSymbolicLink()) throw new Error('备份中不允许符号链接。') }
    const info = await lstat(sourcePath)
    if (!info.isFile() || info.size !== file.size) throw new Error('备份文件大小不匹配：' + file.path)
    const digest = await hash(sourcePath)
    if (file.sha256 && digest !== file.sha256) throw new Error('备份校验失败：' + file.path)
    await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 })
    await copyFile(sourcePath, destinationPath, 1)
    if (await hash(destinationPath) !== digest) throw new Error('复制校验失败：' + file.path)
    await durable(destinationPath)
    output.push({ path: file.path, size: info.size, sha256: digest })
  }
  return output
}
async function backupLocked(root, destination) {
  const layout = await storageLayout(root), { stage, target } = await stageFor(destination, root)
  try {
    const files = await copyVerified(root, stage, await snapshotFiles(root, layout))
    if (layout.storage === 'sqlite') {
      const db = new DatabaseSync(join(root, 'library.sqlite'), { readOnly: true })
      try {
        if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('数据库完整性检查失败，未生成普通备份。')
        db.prepare('VACUUM INTO ?').run(join(stage, 'library.sqlite'))
      } finally { db.close() }
      const path = join(stage, 'library.sqlite'); await durable(path)
      files.push({ path: 'library.sqlite', size: (await lstat(path)).size, sha256: await hash(path) })
    }
    const manifest = { backupVersion: 1, formatVersion: layout.formatVersion, storage: layout.storage, createdAt: new Date().toISOString(), files }
    await writeFile(join(stage, 'backup-manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 })
    await durable(join(stage, 'backup-manifest.json'))
    // Verify the published bytes, not merely successful copy return values.
    await verifyBackup(stage)
    await publish(stage, target)
    return { destination: target, manifest }
  } catch (error) { error.message += '；未发布的完整/部分副本保留于 ' + stage; throw error }
}
export async function backupLibrary(root, destination) {
  if (!(await lstat(root)).isDirectory()) throw new Error('来源必须是现有资料目录。')
  const owner = await acquireDataLock(root)
  try { return await backupLocked(owner.root, destination) } finally { owner.release() }
}
export async function verifyBackup(root) {
  const manifestPath = join(root, 'backup-manifest.json')
  if ((await lstat(manifestPath)).isSymbolicLink() || (await lstat(manifestPath)).size > 32 * 1024 ** 2) throw new Error('备份清单无效或超限。')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.backupVersion !== 1 || !Array.isArray(manifest.files) || manifest.files.length > limits.files || !['json', 'sqlite'].includes(manifest.storage) || manifest.formatVersion !== (manifest.storage === 'json' ? 0 : 1)) throw new Error('不支持的备份格式。')
  let bytes = 0
  const names = new Set()
  for (const file of manifest.files) {
    if (!allowed(file.path) || names.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('无效的备份文件清单。')
    names.add(file.path); bytes += file.size
    if (bytes > limits.bytes) throw new Error('备份展开大小超过 20 GiB 限制。')
    let current = root
    for (const component of file.path.split('/')) { current = join(current, component); if ((await lstat(current)).isSymbolicLink()) throw new Error('备份中不允许符号链接。') }
    const info = await lstat(current)
    if (!info.isFile() || info.size !== file.size || await hash(current) !== file.sha256) throw new Error('备份校验失败：' + file.path)
  }
  if (manifest.storage === 'sqlite') {
    if (!names.has('library.sqlite') || !names.has(storageManifestName)) throw new Error('备份缺少数据库或版本清单。')
    await storageLayout(root)
    const db = new DatabaseSync(join(root, 'library.sqlite'), { readOnly: true })
    try {
      if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || db.prepare('PRAGMA user_version').get().user_version !== 1) throw new Error('备份数据库完整性或版本校验失败。')
      const files = new Map(manifest.files.map(file => [file.path, file]))
      for (const row of db.prepare("SELECT id,body FROM records WHERE bucket='documents'").all()) {
        const document = JSON.parse(row.body), original = files.get('originals/' + requireId(row.id))
        if (!original || (document.source?.sha256 && original.sha256 !== document.source.sha256)) throw new Error('备份原文件与数据库不一致：' + row.id)
      }
    } finally { db.close() }
  }
  return manifest
}
export async function restoreLibrary(backup, destination) {
  const manifest = await verifyBackup(backup), { stage, target } = await stageFor(destination, backup)
  try {
    await copyVerified(backup, stage, manifest.files)
    const layout = await storageLayout(stage)
    if (layout.storage !== manifest.storage) throw new Error('恢复格式与备份声明不一致。')
    await publish(stage, target)
    return { destination: target, storage: layout.storage, files: manifest.files.length }
  } catch (error) { error.message += '；恢复暂存目录保留于 ' + stage; throw error }
}
const migrationStateName = 'migration-state.json'
const migrationBatchSize = 100
async function writeDurableJson(root, name, value) {
  const temporary = join(root, name + '.' + randomUUID() + '.tmp')
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' })
  await durable(temporary)
  await rename(temporary, join(root, name)); await durable(root)
}
async function migrationRecords(backup, manifest) {
  const records = [], identities = new Set()
  for (const file of manifest.files.filter(file => recordBuckets.includes(file.path.split('/')[0])).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    if (!file.path.endsWith('.json') || file.path.split('/').length !== 2) {
      if (file.path.endsWith('.tmp')) throw new Error('发现中断写入或非标准记录，保留备份后停止迁移：' + file.path)
      continue
    }
    const bytes = await readFile(join(backup, file.path))
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('迁移备份在读取时发生变化：' + file.path)
    const value = JSON.parse(bytes), id = requireId(basename(file.path, '.json')), bucket = file.path.split('/')[0], key = bucket + '/' + id
    if (requireId(value.id) !== id || typeof value.createdAt !== 'string' || identities.has(key)) throw new Error('记录身份、时间或唯一性无效：' + file.path)
    identities.add(key); records.push({ bucket, id, value, body: JSON.stringify(value) })
  }
  const documents = new Map(records.filter(row => row.bucket === 'documents').map(row => [row.id, row.value]))
  const topics = new Set(records.filter(row => row.bucket === 'topics').map(row => row.id))
  for (const row of records) {
    if (row.value.documentId && !documents.has(requireId(row.value.documentId))) throw new Error('记录引用缺失文献：' + row.id)
    if (row.value.topicId && !topics.has(requireId(row.value.topicId))) throw new Error('记录引用缺失主题：' + row.id)
    if (row.bucket === 'topics') for (const link of row.value.documents || []) if (!documents.has(requireId(link.documentId))) throw new Error('主题引用缺失文献：' + row.id)
  }
  const originals = new Map(manifest.files.map(file => [file.path, file]))
  for (const [id, document] of documents) {
    const original = originals.get('originals/' + id)
    if (!original || (document.source?.sha256 && document.source.sha256 !== original.sha256)) throw new Error('原文件缺失或哈希不匹配：' + id)
  }
  return records
}
const migrationFiles = manifest => manifest.files.filter(file => ['originals', 'quarantine'].includes(file.path.split('/')[0])).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
const migrationIdentity = state => JSON.stringify(state)
function initializeMigrationProgress(db, state) {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec('CREATE TABLE migration_progress(singleton INTEGER PRIMARY KEY CHECK(singleton=1), identity TEXT NOT NULL, next_record INTEGER NOT NULL, next_file INTEGER NOT NULL)')
    db.prepare('INSERT INTO migration_progress VALUES(1,?,0,0)').run(migrationIdentity(state))
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}
async function migrationDirectory(input) {
  let path = resolve(input)
  try { if (!(await lstat(path)).isDirectory()) throw new Error('迁移目录必须是实际目录，不能是符号链接。') }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    // A crash after publication moved the stage. The descriptor must still
    // match this exact old path before the new directory may be resumed.
    const match = path.match(/^(.*)\.partial-([a-f0-9-]{36})$/)
    if (!match) throw error
    requireId(match[2]); path = match[1]
    if (!(await lstat(path)).isDirectory()) throw error
  }
  return realpath(path)
}
async function readMigration(root, requested) {
  const path = join(root, migrationStateName), info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error('迁移进度清单类型或大小无效。')
  const state = JSON.parse(await readFile(path, 'utf8'))
  if (state.migrationVersion !== 1 || typeof state.id !== 'string' || requireId(state.id) !== state.id || typeof state.backup !== 'string' || typeof state.source !== 'string' || typeof state.target !== 'string' || typeof state.stage !== 'string' || !/^[a-f0-9]{64}$/.test(state.backupSha256) || !Number.isSafeInteger(state.records) || state.records < 0 || !Number.isSafeInteger(state.files) || state.files < 0) throw new Error('迁移进度清单无效或版本不支持。')
  const requestedPath = join(await realpath(dirname(resolve(requested))), basename(resolve(requested)))
  if (state.stage !== state.target + '.partial-' + state.id || ![state.stage, state.target].includes(root) || ![state.stage, state.target].includes(requestedPath) || dirname(state.target) !== await realpath(dirname(state.target))) throw new Error('迁移目录与进度清单不匹配。')
  return state
}
function migrationProgress(db, state) {
  if (db.prepare('PRAGMA user_version').get().user_version !== 1 || db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('迁移数据库完整性或版本检查失败。')
  const progress = db.prepare('SELECT * FROM migration_progress WHERE singleton=1').get()
  if (!progress || progress.identity !== migrationIdentity(state) || !Number.isSafeInteger(progress.next_record) || progress.next_record < 0 || progress.next_record > state.records || !Number.isSafeInteger(progress.next_file) || progress.next_file < 0 || progress.next_file > state.files || (progress.next_file && progress.next_record !== state.records)) throw new Error('迁移进度与数据库身份不一致。')
  return progress
}
async function safeMigrationDatabase(root) {
  for (const name of ['library.sqlite', 'library.sqlite-wal', 'library.sqlite-shm']) {
    try { const info = await lstat(join(root, name)); if (!info.isFile() || info.isSymbolicLink()) throw new Error('迁移数据库路径无效：' + name) }
    catch (error) { if (error.code !== 'ENOENT' || name === 'library.sqlite') throw error }
  }
}
async function migrationFileMatches(root, file) {
  let current = root
  for (const component of file.path.split('/')) {
    current = join(current, component)
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('迁移目标包含符号链接。') }
    catch (error) { if (error.code === 'ENOENT') return false; throw error }
  }
  const info = await lstat(current)
  if (!info.isFile() || info.size !== file.size || await hash(current) !== file.sha256) throw new Error('迁移目标文件与备份不一致，已保留现场：' + file.path)
  return true
}
function migrationResult(state, completed = false) {
  return { destination: state.target, backup: state.backup, records: state.records, storage: 'sqlite', sourcePreserved: true, migrationId: state.id, snapshotCreatedAt: state.snapshotCreatedAt, alreadyCompleted: completed }
}
async function readMigrationLayout(root, state) {
  const path = join(root, storageManifestName), info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error('迁移版本清单路径无效。')
  const layout = JSON.parse(await readFile(path, 'utf8'))
  if (layout.migrationId !== state.id || layout.formatVersion !== 1 || layout.recordVersion !== 1 || layout.storage !== 'sqlite' || !['migrating', 'ready'].includes(layout.state)) throw new Error('迁移版本清单与批次身份不一致。')
  return layout
}

export async function prepareMigration(root, destination, backupDestination) {
  if (!(await lstat(root)).isDirectory()) throw new Error('来源必须是现有资料目录。')
  const owner = await acquireDataLock(root)
  try {
    if ((await storageLayout(owner.root)).storage !== 'json') throw new Error('来源不是旧 JSON 资料库。')
    const backup = await backupLocked(owner.root, backupDestination)
    const manifest = await verifyBackup(backup.destination)
    const records = await migrationRecords(backup.destination, manifest), files = migrationFiles(manifest)
    const { stage, target } = await stageFor(destination, owner.root)
    const state = { migrationVersion: 1, id: stage.slice(-36), source: owner.root, backup: backup.destination, backupSha256: await hash(join(backup.destination, 'backup-manifest.json')), stage, target, createdAt: new Date().toISOString(), snapshotCreatedAt: manifest.createdAt, records: records.length, files: files.length }
    let db
    try {
      await writeDurableJson(stage, storageManifestName, { formatVersion: 1, storage: 'sqlite', state: 'migrating', recordVersion: 1, migrationId: state.id })
      await writeDurableJson(stage, migrationStateName, state)
      db = initializeDatabase(join(stage, 'library.sqlite'))
      initializeMigrationProgress(db, state)
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); db = null
      await durable(join(stage, 'library.sqlite')); await durable(stage)
      return { stage, destination: target, backup: backup.destination, migrationId: state.id, records: records.length, files: files.length, phase: 'prepared' }
    } catch (error) { db?.close(); error.message += '；迁移准备未完成，来源与备份保留，暂存目录为 ' + stage; throw error }
  } finally { owner.release() }
}

export async function migrationStatus(directory) {
  const root = await migrationDirectory(directory), state = await readMigration(root, directory)
  await safeMigrationDatabase(root)
  const db = new DatabaseSync(join(root, 'library.sqlite'), { readOnly: true })
  try {
    const progress = migrationProgress(db, state), manifest = await readMigrationLayout(root, state)
    return { ...migrationResult(state), directory: root, phase: manifest.state === 'ready' ? 'complete' : root === state.target ? 'published' : progress.next_record < state.records ? 'records' : 'files', completedRecords: progress.next_record, totalRecords: state.records, completedFiles: progress.next_file, totalFiles: state.files }
  } finally { db.close() }
}

export async function resumeMigration(directory, { onProgress = async () => {} } = {}) {
  const root = await migrationDirectory(directory), owner = await acquireDataLock(root)
  let db, currentRoot = root
  try {
    const state = await readMigration(root, directory)
    const layout = await readMigrationLayout(root, state)
    await safeMigrationDatabase(root)
    if (layout.state === 'ready') {
      if (root !== state.target) throw new Error('完成标记出现在未发布目录，已停止操作。')
      const check = new DatabaseSync(join(root, 'library.sqlite'), { readOnly: true })
      try {
        const progress = migrationProgress(check, state)
        if (progress.next_record !== state.records || progress.next_file !== state.files) throw new Error('迁移完成标记与提交进度不一致。')
      } finally { check.close() }
      return migrationResult(state, true)
    }
    if (root !== state.target && await exists(state.target)) throw new Error('迁移目标目录已存在，未覆盖现有资料。')
    if (await hash(join(state.backup, 'backup-manifest.json')) !== state.backupSha256) throw new Error('迁移备份清单已变化，未继续迁移。')
    const manifest = await verifyBackup(state.backup)
    if (manifest.storage !== 'json') throw new Error('迁移快照不是 JSON 格式。')
    const records = await migrationRecords(state.backup, manifest), files = migrationFiles(manifest)
    if (records.length !== state.records || files.length !== state.files) throw new Error('迁移快照数量与进度不一致。')
    db = new DatabaseSync(join(root, 'library.sqlite'))
    db.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=0;')
    const progress = migrationProgress(db, state)
    if (db.prepare('SELECT count(*) AS count FROM records').get().count !== progress.next_record) throw new Error('迁移记录数量与已提交进度不一致。')
    const read = db.prepare('SELECT body,generation FROM records WHERE bucket=? AND id=?')
    for (const row of records.slice(0, progress.next_record)) {
      const current = read.get(row.bucket, row.id)
      if (current?.body !== row.body || current.generation !== 1) throw new Error('已迁移记录被修改，未继续迁移：' + row.id)
    }
    for (const file of files.slice(0, progress.next_file)) if (!await migrationFileMatches(root, file)) throw new Error('已提交的迁移文件缺失：' + file.path)
    const emit = phase => onProgress({ phase, migrationId: state.id, directory: currentRoot, destination: state.target, completedRecords: progress.next_record, totalRecords: records.length, completedFiles: progress.next_file, totalFiles: files.length })
    await emit('validated')
    const insert = db.prepare('INSERT INTO records(bucket,id,body) VALUES(?,?,?)')
    while (progress.next_record < records.length) {
      const end = Math.min(records.length, progress.next_record + migrationBatchSize)
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const row of records.slice(progress.next_record, end)) insert.run(row.bucket, row.id, row.body)
        db.prepare('UPDATE migration_progress SET next_record=? WHERE singleton=1').run(end)
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
      progress.next_record = end; await emit('records')
    }
    for (let i = progress.next_file; i < files.length; i++) {
      const file = files[i]
      if (!await migrationFileMatches(root, file)) {
        // Failed copies stay in their own work directory. Only a completely
        // hashed and synced file is renamed into the eventual library.
        const work = join(root, 'migration-work')
        await mkdir(work, { recursive: true, mode: 0o700 })
        if (!(await lstat(work)).isDirectory()) throw new Error('迁移工作目录类型无效。')
        const attempt = join(work, randomUUID()); await mkdir(attempt, { mode: 0o700 })
        await copyVerified(state.backup, attempt, [file])
        const target = join(root, file.path)
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        await rename(join(attempt, file.path), target); await durable(dirname(target))
      }
      await emit('file-published')
      db.prepare('UPDATE migration_progress SET next_file=? WHERE singleton=1').run(i + 1)
      progress.next_file = i + 1; await emit('files')
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); db = null
    await durable(join(root, 'library.sqlite'))
    await emit('publishing')
    if (root !== state.target) { await publish(root, state.target); currentRoot = state.target }
    await emit('published')
    // The target remains explicitly unreadable until this final durable marker.
    await writeDurableJson(currentRoot, storageManifestName, { formatVersion: 1, storage: 'sqlite', state: 'ready', recordVersion: 1, migratedAt: state.createdAt, migrationId: state.id, sourceBackup: state.backup, records: records.length })
    await emit('complete')
    return migrationResult(state)
  } catch (error) { error.message += '；来源和备份保留，可检查迁移目录 ' + currentRoot; throw error }
  finally { try { db?.close() } finally { owner.release() } }
}

export async function migrateLibrary(root, destination, backupDestination, options = {}) {
  const prepared = await prepareMigration(root, destination, backupDestination)
  await options.onProgress?.(prepared)
  return resumeMigration(prepared.stage, options)
}
