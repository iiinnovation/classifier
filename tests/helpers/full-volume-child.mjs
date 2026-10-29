// No mocked filesystem calls or SQLite page limits: these scenarios exhaust a
// real, bounded APFS filesystem created by the parent test process.
import { mkdir, open, readFile, writeFile, readdir, stat, statfs, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import assert from 'node:assert/strict'

const [parameters, application] = process.argv.slice(2)
const volume = JSON.parse(await readFile(parameters, 'utf8'))
const moduleAt = name => import(pathToFileURL(join(application, 'apps/api/src', name + '.mjs')).href)
const { createStore } = await moduleAt('store')
const { initializeDatabase } = await moduleAt('sqlite-store')
const maintenance = await moduleAt('storage-maintenance')
const zip = await moduleAt('storage-zip')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const MiB = 1024 ** 2, maximum = 256 * MiB
const results = []
const space = async () => { const info = await statfs(volume.mount); return { freeBytes: info.bavail * info.bsize, capacityBytes: info.blocks * info.bsize } }
const diskError = error => error.code === 'ENOSPC' || error.code === 'ERR_SQLITE_ERROR' && (error.errcode & 255) === 13
const describe = error => ({ code: error.code, errcode: error.errcode, message: error.message })
async function fill(path, reserve = 0) {
  assert.equal((await stat(volume.mount)).dev, volume.device)
  assert.notEqual(volume.device, volume.hostDevice)
  const initial = await space(); assert.ok(initial.capacityBytes <= maximum)
  await mkdir(path)
  const bytes = randomBytes(MiB), reserved = join(path, 'reserve')
  if (reserve) {
    const handle = await open(reserved, 'wx')
    try { for (let offset = 0; offset < reserve; offset += MiB) await handle.writeFile(bytes.subarray(0, Math.min(MiB, reserve - offset))); await handle.sync() }
    finally { await handle.close() }
  }
  const handle = await open(join(path, 'bulk'), 'wx')
  let written = 0, failure = null
  try {
    while (written < maximum) {
      try {
        const value = await handle.write(bytes); written += value.bytesWritten
        if (!value.bytesWritten) throw new Error('The full-volume filler stopped making progress.')
        await handle.sync()
      } catch (error) { if (!diskError(error)) throw error; failure = describe(error); break }
    }
  } finally { await handle.close() }
  // APFS can reject growth of a large file while smaller allocations still
  // succeed. Exhaust those too, with bounded small files on the verified image.
  for (const size of [64 * 1024, 4096]) {
    let failed = false
    for (let i = 0; i < 4096 && written < maximum; i++) {
      let tail
      try {
        tail = await open(join(path, 'tail-' + size + '-' + i), 'wx')
        await tail.writeFile(bytes.subarray(0, size)); written += size; await tail.sync()
      } catch (error) { if (!diskError(error)) throw error; failure = describe(error); failed = true; break }
      finally { await tail?.close() }
    }
    assert.ok(failed, 'bounded small writes must reach ENOSPC')
  }
  assert.ok(written < maximum, 'never fill beyond the bounded filesystem capacity')
  assert.ok(failure, 'the filesystem must return a real ENOSPC')
  const exhausted = await space()
  if (reserve) await rm(reserved)
  return { initial, exhausted, after: await space(), reserveReleasedBytes: reserve, written, failure }
}
const release = filler => rm(filler, { recursive: true, force: true })
async function fixture(root, storage = 'json') {
  const createdAt = new Date().toISOString(), bytes = randomBytes(4 * MiB)
  const document = { id: randomUUID(), createdAt, title: 'Bounded volume evidence', sections: [], references: [], source: { sha256: digest(bytes), byteLength: bytes.length } }
  const topic = { id: randomUUID(), createdAt, title: 'Bounded research', documents: [{ documentId: document.id }] }
  const note = { id: randomUUID(), documentId: document.id, topicId: topic.id, createdAt, content: 'Keep saved text', evidence: [], history: [{ content: 'Keep earlier evidence', evidence: [] }] }
  if (storage === 'sqlite') {
    await mkdir(root, { recursive: true }); initializeDatabase(join(root, 'library.sqlite')).close()
    await writeFile(join(root, 'library-manifest.json'), JSON.stringify({ formatVersion: 1, storage: 'sqlite', state: 'ready' }))
  }
  const store = await createStore(root)
  await store.saveOriginal(document.id, bytes)
  for (const [bucket, value] of [['documents', document], ['topics', topic], ['notes', note]]) await store.write(bucket, value)
  return { store, document, topic, note, bytes }
}
async function check(directory, fixture) {
  const store = await createStore(directory)
  try {
    for (const [bucket, value] of [['documents', fixture.document], ['topics', fixture.topic], ['notes', fixture.note]]) assert.deepEqual(await store.read(bucket, value.id), value)
    assert.deepEqual(await store.original(fixture.document.id), fixture.bytes)
  } finally { store.close?.() }
}
async function rejected(work, label = '') {
  let failure
  try { await work() } catch (error) { failure = error }
  assert.ok(failure, 'a full filesystem must not report this operation as complete: ' + label + '; remaining=' + JSON.stringify(await space()))
  assert.ok(diskError(failure), JSON.stringify(describe(failure)))
  return describe(failure)
}
async function run(name, action) {
  const directory = join(volume.mount, name), outside = join(volume.root, name), filler = join(directory, 'filler')
  await mkdir(directory); await mkdir(outside)
  try {
    const result = { name, passed: true, ...await action({ directory, outside, filler }) }
    results.push(result); console.error('FULL_VOLUME ' + JSON.stringify(result))
  } catch (error) { error.message = name + ': ' + error.message; throw error }
  finally { await rm(directory, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
}

for (const storage of ['json', 'sqlite']) await run(storage + '-edit', async ({ directory, filler }) => {
  const source = join(directory, 'library'), f = await fixture(source, storage)
  try {
    const pressure = await fill(filler)
    const error = await rejected(() => f.store.update('notes', f.note.id, value => ({ ...value, content: 'x'.repeat(4 * MiB) })))
    assert.deepEqual(await f.store.read('notes', f.note.id), f.note)
    await release(filler)
    await f.store.update('notes', f.note.id, value => ({ ...value, content: 'Retry saved successfully' }))
    assert.equal((await f.store.read('notes', f.note.id)).content, 'Retry saved successfully')
    await f.store.write('notes', f.note)
    return { pressure, error, savedRecordPreserved: true, retrySucceeded: true }
  } finally { f.store.close?.(); await check(source, f) }
})

await run('sqlite-import', async ({ directory, filler }) => {
  const source = join(directory, 'library'), f = await fixture(source, 'sqlite')
  const imported = { ...f.document, id: randomUUID() }, job = { id: randomUUID(), topicId: f.topic.id, status: 'running', createdAt: new Date().toISOString() }
  let pressure, error
  try {
    await f.store.write('imports', job); pressure = await fill(filler)
    error = await rejected(() => f.store.commitImport(imported, f.bytes, { topicId: f.topic.id, job }))
    assert.equal(await f.store.read('documents', imported.id), null)
    assert.deepEqual(await f.store.read('topics', f.topic.id), f.topic)
    await release(filler)
  } finally { f.store.close() }
  const reopened = await createStore(source)
  try {
    assert.equal((await reopened.read('imports', job.id)).status, 'interrupted')
    const retry = { ...imported, id: randomUUID() }
    await reopened.commitImport(retry, f.bytes, { topicId: f.topic.id })
    assert.deepEqual(await reopened.original(retry.id), f.bytes)
    assert.equal((await reopened.read('topics', f.topic.id)).documents.length, 2)
    assert.deepEqual(await reopened.read('notes', f.note.id), f.note)
  } finally { reopened.close() }
  return { pressure, error, metadataRolledBack: true, restartAndRetrySucceeded: true }
})

for (const operation of ['backup', 'restore', 'zip-backup', 'zip-restore']) await run(operation, async ({ directory, outside, filler }) => {
  const source = join(outside, 'source'), f = await fixture(source); f.store.close?.()
  const backup = join(outside, 'backup'), destination = join(directory, 'target')
  let work, verify
  if (operation === 'backup') { work = () => maintenance.backupLibrary(source, destination); verify = () => maintenance.verifyBackup(destination) }
  else if (operation === 'restore') { await maintenance.backupLibrary(source, backup); work = () => maintenance.restoreLibrary(backup, destination); verify = () => check(destination, f) }
  else if (operation === 'zip-backup') { work = () => zip.backupZipLibrary(source, destination); verify = () => zip.verifyZipBackup(destination) }
  else { await zip.backupZipLibrary(source, backup); work = () => zip.restoreZipLibrary(backup, destination); verify = () => check(destination, f) }
  // Allow some metadata allocations but less than one original's payload. The
  // operation may fail before or during copying; both must preserve the source.
  const pressure = await fill(filler, MiB)
  const error = await rejected(work, JSON.stringify(pressure))
  await assert.rejects(stat(destination), { code: 'ENOENT' })
  await check(source, f)
  await release(filler); await work(); await verify(); await check(source, f)
  return { pressure, error, targetNotPublished: true, sourcePreserved: true, retrySucceeded: true }
})

await run('migration', async ({ directory, outside, filler }) => {
  const source = join(outside, 'source'), f = await fixture(source); f.store.close?.()
  const destination = join(directory, 'target'), backup = join(outside, 'backup')
  const prepared = await maintenance.prepareMigration(source, destination, backup)
  let pressure
  const error = await rejected(() => maintenance.resumeMigration(prepared.stage, { onProgress: async value => { if (value.phase === 'records' && !pressure) pressure = await fill(filler, 64 * 1024) } }))
  assert.ok(pressure)
  let statusWhileFull, statusReadError
  try { statusWhileFull = await maintenance.migrationStatus(prepared.stage) }
  catch (error) {
    // SQLite may need new shared-memory blocks even for a read-only WAL
    // connection. This must remain a visible I/O failure, not a fake progress.
    assert.equal(error.code, 'ERR_SQLITE_ERROR'); assert.equal(error.errcode & 255, 10)
    statusReadError = describe(error)
  }
  await release(filler)
  const status = await maintenance.migrationStatus(prepared.stage)
  assert.equal(status.completedRecords, 3); assert.equal(status.completedFiles, 0)
  if (statusWhileFull) { assert.equal(statusWhileFull.completedRecords, 3); assert.equal(statusWhileFull.completedFiles, 0) }
  await check(source, f); await maintenance.verifyBackup(backup)
  await maintenance.resumeMigration(prepared.stage); await maintenance.resumeMigration(prepared.stage)
  await check(destination, f)
  return { pressure, error, statusReadError, completedRecords: status.completedRecords, completedFiles: status.completedFiles, sourceAndBackupPreserved: true, repeatedResumeSucceeded: true }
})

await run('quarantine', async ({ directory, filler }) => {
  const source = join(directory, 'library'), f = await fixture(source); f.store.close?.()
  const path = join(source, 'notes', f.note.id + '.json'), broken = '{preserve damaged original'
  await writeFile(path, broken)
  const pressure = await fill(filler), store = await createStore(source)
  try {
    const health = await store.health()
    assert.equal(health.issueCount, 1); assert.equal(health.issues[0].preserved, false)
    assert.ok(health.issues[0].preservationError)
    assert.deepEqual(await store.document(f.document.id), f.document)
    assert.equal(await readFile(path, 'utf8'), broken)
    await release(filler)
    const retried = await store.health(); assert.equal(retried.issues[0].preserved, true)
    assert.equal(await readFile(join(source, retried.issues[0].quarantinePath), 'utf8'), broken)
    return { pressure, healthyRecordsReadable: true, damagedBytesPreserved: true, isolationRetrySucceeded: true }
  } finally { store.close?.() }
})

const result = { filesystem: 'APFS', volume, scenarios: results, runtime: process.versions, source: application, noFaultInjection: true, hostVolumeNotFilled: true }
await writeFile(join(volume.root, 'result.json'), JSON.stringify(result, null, 2))
if (process.parentPort) {
  process.parentPort.postMessage({ type: 'completed', result })
  process.parentPort.on('message', () => process.exit(0))
}
