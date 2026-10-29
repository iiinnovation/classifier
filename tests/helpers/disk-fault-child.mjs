// Test-only fault runner. The optional application root loads the exact packaged
// production modules; no fault switch is exposed by the application itself.
import fs from 'node:fs/promises'
import nativeFs from 'node:fs'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { DatabaseSync } from 'node:sqlite'

const [inputRoot, scenario, application = fileURLToPath(new URL('../..', import.meta.url))] = process.argv.slice(2)
const root = await fs.realpath(inputRoot)
const moduleAt = name => import(pathToFileURL(join(application, 'apps/api/src', name + '.mjs')).href)
const { createStore } = await moduleAt('store')
const { initializeDatabase } = await moduleAt('sqlite-store')
const maintenance = await moduleAt('storage-maintenance')
const zip = await moduleAt('storage-zip')
const recovery = await moduleAt('library-recovery')
const { inspectLibrary } = await moduleAt('library-inspection')
const original = { open: fs.open, copyFile: fs.copyFile, writeFile: fs.writeFile, rename: fs.rename, link: fs.link, unlink: fs.unlink, createWriteStream: nativeFs.createWriteStream, exec: DatabaseSync.prototype.exec }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const exists = async path => { try { await fs.lstat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
const serialize = error => ({ code: error.code, errcode: error.errcode, message: error.message, publishedDestination: error.publishedDestination })
let reached = 0, observedError, limited
function reset() {
  for (const name of ['open', 'copyFile', 'writeFile', 'rename', 'link', 'unlink']) fs[name] = original[name]
  nativeFs.createWriteStream = original.createWriteStream
  DatabaseSync.prototype.exec = original.exec
  syncBuiltinESMExports()
  if (limited?.isOpen) original.exec.call(limited, 'PRAGMA max_page_count=1073741823')
}
function diskError(code) { reached++; return Object.assign(new Error('test disk fault: ' + code), { code }) }
async function fails(work, check) {
  let caught
  try { await work() } catch (error) { caught = error; observedError = serialize(error) }
  finally { reset() }
  assert.ok(reached, 'the intended production fault boundary must be reached')
  assert.ok(caught, 'fault must reject, not report success')
  check(caught)
}
function limitDatabase() {
  DatabaseSync.prototype.exec = function(sql, ...args) {
    if (!limited && /BEGIN IMMEDIATE/.test(sql)) {
      const pages = this.prepare('PRAGMA page_count').get().page_count
      original.exec.call(this, 'PRAGMA max_page_count=' + pages)
      limited = this; reached++
    }
    return original.exec.call(this, sql, ...args)
  }
}
const source = join(root, 'source'), target = join(root, 'target'), backup = join(root, 'backup')
const createdAt = new Date().toISOString(), bytes = Buffer.from('Disk failure original; do not lose this evidence.')
const document = { id: randomUUID(), title: 'Evidence', createdAt, sections: [], references: [], source: { sha256: digest(bytes), byteLength: bytes.length } }
const topic = { id: randomUUID(), title: 'Research', createdAt, documents: [{ documentId: document.id }] }
const note = { id: randomUUID(), documentId: document.id, topicId: topic.id, createdAt, content: 'Saved user text', evidence: [], history: [{ content: 'Earlier version', evidence: [] }] }
await fs.mkdir(root, { recursive: true })
async function seed(storage = 'json') {
  if (storage === 'sqlite') {
    await fs.mkdir(source); initializeDatabase(join(source, 'library.sqlite')).close()
    await fs.writeFile(join(source, 'library-manifest.json'), JSON.stringify({ formatVersion: 1, storage: 'sqlite', state: 'ready' }))
  }
  const store = await createStore(source)
  await store.saveOriginal(document.id, bytes)
  for (const [bucket, value] of [['documents', document], ['topics', topic], ['notes', note]]) await store.write(bucket, value)
  return store
}
async function assertLibrary(directory) {
  const store = await createStore(directory)
  try {
    assert.deepEqual(await store.read('documents', document.id), document)
    assert.deepEqual(await store.read('topics', topic.id), topic)
    assert.deepEqual(await store.read('notes', note.id), note)
    assert.deepEqual(await store.original(document.id), bytes)
  } finally { store.close?.() }
}
async function tree(directory) {
  const result = {}
  async function visit(folder = '') {
    for (const name of (await fs.readdir(join(directory, folder))).sort()) {
      if (name.startsWith('.classifier-lock')) continue
      const relative = join(folder, name), path = join(directory, relative), info = await fs.lstat(path)
      if (info.isDirectory()) await visit(relative)
      else result[relative] = digest(await fs.readFile(path))
    }
  }
  await visit(); return result
}

try {
  if (scenario === 'sqlite-update-full') {
    const store = await seed('sqlite')
    try {
      limitDatabase()
      await fails(() => store.update('notes', note.id, value => ({ ...value, content: 'x'.repeat(1024 * 1024) })), error => assert.equal(error.errcode, 13, 'preserve the real SQLITE_FULL error'))
      assert.deepEqual(await store.read('notes', note.id), note)
      await store.update('notes', note.id, value => ({ ...value, content: 'Retry after freeing space' }))
      assert.equal((await store.read('notes', note.id)).content, 'Retry after freeing space')
      await store.write('notes', note)
    } finally { store.close() }
    await assertLibrary(source)
  } else if (scenario === 'migration-batch-full' || scenario === 'migration-prepare-full') {
    const store = await seed()
    if (scenario === 'migration-batch-full') { note.content = 'evidence '.repeat(128 * 1024); await store.write('notes', note) }
    store.close?.()
    let prepared
    if (scenario === 'migration-batch-full') prepared = await maintenance.prepareMigration(source, target, backup)
    limitDatabase()
    await fails(() => prepared ? maintenance.resumeMigration(prepared.stage) : maintenance.prepareMigration(source, target, backup), error => assert.equal(error.errcode, 13, 'automatic rollback must not mask SQLITE_FULL'))
    await assertLibrary(source); await maintenance.verifyBackup(backup)
    assert.equal(await exists(target), false)
    if (prepared) {
      const status = await maintenance.migrationStatus(prepared.stage)
      assert.equal(status.completedRecords, 0); assert.equal(status.completedFiles, 0)
    } else prepared = await maintenance.prepareMigrationFromBackup(backup, target)
    await maintenance.resumeMigration(prepared.stage); await maintenance.resumeMigration(prepared.stage)
    await assertLibrary(target)
  } else if (scenario.startsWith('migration:')) {
    const store = await seed(); store.close?.()
    const prepared = await maintenance.prepareMigration(source, target, backup)
    const before = await tree(source), snapshot = await tree(backup), boundary = scenario.split(':')[1]
    let published = false, ready = false
    fs.copyFile = async (from, to, ...args) => {
      if (boundary === 'copy' && to.includes('/migration-work/')) { await original.writeFile(to, bytes.subarray(0, 7)); throw diskError('ENOSPC') }
      return original.copyFile(from, to, ...args)
    }
    fs.writeFile = async (path, value, ...args) => {
      if (boundary === 'ready-marker' && String(path).startsWith(join(target, 'library-manifest.json.'))) { await original.writeFile(path, String(value).slice(0, 7)); throw diskError('ENOSPC') }
      return original.writeFile(path, value, ...args)
    }
    fs.rename = async (from, to) => {
      if (boundary === 'file-publish' && to === join(prepared.stage, 'originals', document.id)) throw diskError('EACCES')
      const result = await original.rename(from, to)
      if (to === target) published = true
      if (to === join(target, 'library-manifest.json')) ready = true
      return result
    }
    fs.open = async (...args) => {
      const handle = await original.open(...args)
      if (boundary === 'file-sync' && String(args[0]).includes('/migration-work/') && (await handle.stat()).isFile() ||
        boundary === 'directory-sync' && published && args[0] === dirname(target) ||
        boundary === 'ready-sync' && ready && args[0] === target) handle.sync = async () => { throw diskError('EIO') }
      return handle
    }
    syncBuiltinESMExports()
    await fails(() => maintenance.resumeMigration(prepared.stage), error => assert.equal(error.code, ['copy', 'ready-marker'].includes(boundary) ? 'ENOSPC' : boundary === 'file-publish' ? 'EACCES' : 'EIO'))
    assert.deepEqual(await tree(source), before); assert.deepEqual(await tree(backup), snapshot)
    const status = await maintenance.migrationStatus(prepared.stage)
    assert.equal(status.completedRecords, 3)
    assert.equal(status.completedFiles, ['copy', 'file-sync', 'file-publish'].includes(boundary) ? 0 : 1)
    if (boundary === 'ready-sync') {
      // A ready marker can be visible although its directory sync failed. A
      // repeated resume must re-establish durability before returning success.
      let synced = false
      fs.open = async (...args) => {
        const handle = await original.open(...args), sync = handle.sync.bind(handle)
        if (args[0] === target) handle.sync = async () => { synced = true; return sync() }
        return handle
      }
      syncBuiltinESMExports()
      try { await maintenance.resumeMigration(prepared.stage); assert.ok(synced, 'retry must synchronize the visible ready marker') } finally { reset() }
    } else await maintenance.resumeMigration(prepared.stage)
    await maintenance.resumeMigration(prepared.stage); await assertLibrary(target)
  } else if (scenario === 'recovery-full') {
    const store = await seed('sqlite'); note.content = 'restored evidence '.repeat(64 * 1024)
    await store.write('notes', note); store.close()
    await maintenance.backupLibrary(source, backup)
    const db = new DatabaseSync(join(source, 'library.sqlite'))
    db.prepare("UPDATE records SET body='{}' WHERE bucket='notes' AND id=?").run(note.id)
    db.exec('VACUUM'); db.close()
    const plan = await recovery.previewLibraryRecovery(source, backup)
    // Opening a WAL database read-only can create shared-memory sidecars. Take
    // the baseline after preview has opened it, before any recovery writes.
    const before = await tree(source), snapshot = await tree(backup)
    const options = { revision: plan.revision, selections: [plan.items.find(item => item.target === 'notes/' + note.id).choices[0].key] }
    limitDatabase()
    await fails(() => recovery.recoverLibrary(source, backup, target, join(root, 'preserved'), options), error => assert.equal(error.errcode, 13))
    assert.equal(await exists(target), false); assert.deepEqual(await tree(source), before); assert.deepEqual(await tree(backup), snapshot)
    assert.ok(await exists(join(root, 'preserved', 'preservation-manifest.json')))
    await recovery.recoverLibrary(source, backup, target, join(root, 'preserved-retry'), options)
    await assertLibrary(target)
  } else if (scenario === 'quarantine-full') {
    const store = await seed(); store.close?.()
    const path = join(source, 'notes', note.id + '.json'), broken = '{damaged private record'
    await fs.writeFile(path, broken)
    fs.open = async (...args) => {
      const handle = await original.open(...args)
      if (String(args[0]).includes('/quarantine/records/')) {
        const write = handle.writeFile.bind(handle)
        handle.writeFile = async value => { await write(String(value).slice(0, 7)); throw diskError('ENOSPC') }
      }
      return handle
    }
    syncBuiltinESMExports()
    let reopened
    try {
      reopened = await createStore(source)
      const health = await reopened.health()
      assert.ok(reached); assert.equal(health.issueCount, 1); assert.equal(health.issues[0].preserved, false)
      assert.ok(health.issues[0].preservationError)
      assert.deepEqual(await reopened.document(document.id), document)
      await assert.rejects(reopened.read('notes', note.id), { code: 'RECORD_CORRUPT' })
    } finally { reset() }
    assert.equal(await fs.readFile(path, 'utf8'), broken)
    const health = await reopened.health(); assert.equal(health.issues[0].preserved, true)
    assert.equal(await fs.readFile(join(source, health.issues[0].quarantinePath), 'utf8'), broken)
    assert.equal(await fs.readFile(path, 'utf8'), broken)
    reopened.close?.()
  } else if (scenario.startsWith('import-')) {
    const store = await seed('sqlite')
    const imported = { ...document, id: randomUUID(), title: scenario === 'import-full' ? 'x'.repeat(1024 * 1024) : 'New import' }
    const job = { id: randomUUID(), createdAt, status: 'running', topicId: topic.id }
    await store.write('imports', job)
    if (scenario === 'import-full') limitDatabase()
    else if (scenario === 'import-short-write') fs.open = async (...args) => {
      const handle = await original.open(...args)
      if (String(args[0]).includes('/.import-')) {
        const write = handle.writeFile.bind(handle)
        handle.writeFile = async value => { await write(value.subarray(0, 7)); throw diskError('ENOSPC') }
      }
      return handle
    }
    else if (scenario === 'import-sync') fs.open = async (...args) => {
      const handle = await original.open(...args)
      if (String(args[0]) === join(source, 'originals')) handle.sync = async () => { throw diskError('EIO') }
      return handle
    }
    else if (scenario === 'import-cleanup') fs.unlink = async path => {
      if (String(path).includes('/.import-')) throw diskError('EACCES')
      return original.unlink(path)
    }
    else throw new Error('Unknown import scenario')
    syncBuiltinESMExports()
    try {
      const commit = () => store.commitImport(imported, bytes, { topicId: topic.id, job })
      if (scenario === 'import-cleanup') { await commit(); reset(); assert.ok(reached) }
      else await fails(commit, error => scenario === 'import-full' ? assert.equal(error.errcode, 13) : assert.equal(error.code, scenario === 'import-short-write' ? 'ENOSPC' : 'EIO'))
      assert.deepEqual(await store.read('notes', note.id), note)
    } finally { reset(); store.close() }
    for (let attempt = 0; attempt < 2; attempt++) {
      const reopened = await createStore(source)
      try {
        const completed = scenario === 'import-cleanup'
        assert.equal(Boolean(await reopened.read('documents', imported.id)), completed)
        assert.equal((await reopened.read('imports', job.id)).status, completed ? 'completed' : 'interrupted')
        assert.equal((await reopened.read('topics', topic.id)).documents.length, completed ? 2 : 1)
        assert.deepEqual(await reopened.original(document.id), bytes)
        if (completed) assert.deepEqual(await reopened.original(imported.id), bytes)
        else await assert.rejects(reopened.original(imported.id), { code: 'ENOENT' })
      } finally { reopened.close() }
    }
    if (scenario === 'import-short-write') {
      const names = (await fs.readdir(join(source, 'originals'))).filter(name => name.startsWith('.import-'))
      assert.equal(names.length, 1); assert.deepEqual(await fs.readFile(join(source, 'originals', names[0])), bytes.subarray(0, 7))
      assert.ok((await inspectLibrary(source)).issues.some(issue => issue.code === 'pending-import-operation'))
    } else assert.deepEqual((await inspectLibrary(source)).issues, [])
    await maintenance.backupLibrary(source, backup); await maintenance.restoreLibrary(backup, target)
    const copy = await createStore(target)
    try { assert.equal((await copy.read('imports', job.id)).status, scenario === 'import-cleanup' ? 'completed' : 'interrupted') } finally { copy.close() }
  } else {
    const store = await seed(); store.close?.()
    const [operation, boundary] = scenario.split(':')
    let run, verify
    if (operation === 'backup') { run = destination => maintenance.backupLibrary(source, destination); verify = destination => maintenance.verifyBackup(destination) }
    else if (operation === 'preserve') { run = destination => recovery.preserveLibrary(source, destination); verify = destination => fs.readFile(join(destination, 'preservation-manifest.json')) }
    else if (operation === 'zip-backup') { run = destination => zip.backupZipLibrary(source, destination); verify = destination => zip.verifyZipBackup(destination) }
    else if (operation === 'restore') { await maintenance.backupLibrary(source, backup); run = destination => maintenance.restoreLibrary(backup, destination); verify = assertLibrary }
    else if (operation === 'zip-restore') { await zip.backupZipLibrary(source, backup); run = destination => zip.restoreZipLibrary(backup, destination); verify = assertLibrary }
    else throw new Error('Unknown disk fault scenario: ' + scenario)
    const before = await tree(source), snapshot = await exists(backup) ? (await fs.lstat(backup)).isDirectory() ? await tree(backup) : digest(await fs.readFile(backup)) : null
    let published = false
    const matches = path => String(path).startsWith(target + '.partial-')
    fs.rename = async (from, to) => {
      if (to === target && boundary === 'publish') throw diskError('EACCES')
      const result = await original.rename(from, to); if (to === target) published = true; return result
    }
    fs.link = async (from, to) => {
      if (to === target && boundary === 'publish') throw diskError('EACCES')
      const result = await original.link(from, to); if (to === target) published = true; return result
    }
    fs.copyFile = async (from, to, ...args) => {
      if (boundary === 'copy' && matches(to)) { await original.writeFile(to, (await fs.readFile(from)).subarray(0, 7)); throw diskError('ENOSPC') }
      return original.copyFile(from, to, ...args)
    }
    fs.writeFile = async (path, value, ...args) => {
      if (boundary === 'manifest' && matches(path) && String(path).includes('manifest.json')) { await original.writeFile(path, String(value).slice(0, 7)); throw diskError('ENOSPC') }
      return original.writeFile(path, value, ...args)
    }
    fs.open = async (...args) => {
      const handle = await original.open(...args)
      if (boundary === 'directory-sync' && published && args[0] === dirname(target) || boundary === 'file-sync' && matches(args[0]) && (await handle.stat()).isFile()) handle.sync = async () => { throw diskError('EIO') }
      return handle
    }
    nativeFs.createWriteStream = (path, options) => {
      const stream = original.createWriteStream(path, options)
      if (boundary === 'stream' && matches(path)) {
        const write = stream._write.bind(stream)
        stream._write = (chunk, encoding, callback) => write(chunk.subarray(0, 7), encoding, error => callback(error || diskError('ENOSPC')))
        // Buffered ZIP chunks can be batched into writev without calling
        // _write. Fault both paths so scheduling cannot bypass this boundary.
        stream._writev = (chunks, callback) => stream._write(chunks[0].chunk, chunks[0].encoding, callback)
      }
      return stream
    }
    syncBuiltinESMExports()
    await fails(() => run(target), error => {
      assert.equal(error.code, ['copy', 'manifest', 'stream'].includes(boundary) ? 'ENOSPC' : boundary === 'publish' ? 'EACCES' : 'EIO')
      if (boundary === 'directory-sync') {
        assert.equal(error.publishedDestination, target, 'report the actual copy after rename/link succeeded')
        assert.ok(error.message.includes(target)); assert.match(error.message, /同步|持久化/)
      }
    })
    assert.deepEqual(await tree(source), before, 'source bytes must not change')
    if (snapshot) assert.deepEqual((await fs.lstat(backup)).isDirectory() ? await tree(backup) : digest(await fs.readFile(backup)), snapshot, 'backup bytes must not change')
    assert.equal(await exists(target), boundary === 'directory-sync')
    if (boundary === 'directory-sync') { await verify(target); await assert.rejects(run(target), /已存在/) }
    else assert.ok((await fs.readdir(root)).some(name => name.startsWith('target.partial-')), 'retain failed partial output')
    const retry = join(root, 'retry'); await run(retry); await verify(retry); await assertLibrary(source)
  }
  const result = { scenario, reached, passed: true, error: observedError, runtime: process.versions, platform: process.platform, arch: process.arch }
  await fs.writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2))
  if (process.parentPort) { process.parentPort.postMessage({ type: 'completed', result }); process.parentPort.on('message', () => process.exit(0)) }
} finally { reset() }
