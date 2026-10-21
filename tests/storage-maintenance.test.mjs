import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir, symlink, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { once } from 'node:events'
import { createStore } from '../apps/api/src/store.mjs'
import { createApp } from '../apps/api/src/server.mjs'
import { backupLibrary, verifyBackup, restoreLibrary, migrateLibrary } from '../apps/api/src/storage-maintenance.mjs'
import { evidenceVersion } from '../apps/api/src/evidence.mjs'
import { acquireDataLock } from '../apps/api/src/data-lock.mjs'
import { reportFixture } from './helpers/report-fixture.mjs'
import { json, upload } from './helpers/test-app.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'classifier-maintenance-')), source = join(root, 'legacy')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await createStore(source), id = randomUUID(), topicId = randomUUID()
  const text = 'Source evidence retained through storage migration', createdAt = new Date().toISOString()
  const document = { id, title: 'Storage fixture', fileName: 'fixture.txt', mediaType: 'text/plain', createdAt, warnings: [], schemaVersion: 2, source: { sha256: createHash('sha256').update(text).digest('hex'), byteLength: Buffer.byteLength(text) }, sections: [{ title: 'Text', text }], references: [{ id: 'ref_00001', title: 'Text', text }] }
  await store.saveOriginal(id, Buffer.from(text)); await store.write('documents', document)
  await store.write('topics', { id: topicId, title: 'Research', question: 'Retain evidence?', documents: [{ documentId: id }], createdAt })
  const note = { id: randomUUID(), documentId: id, topicId, createdAt, revision: 1, content: 'User text', history: [{ revision: 0, content: 'Earlier text' }], evidence: [{ documentId: id, documentVersion: evidenceVersion(document), reference: document.references[0] }] }
  await store.write('notes', note)
  await writeFile(join(source, '.env'), 'TEST_SECRET=never-copy-this')
  return { root, source, store, document, topicId, note, text }
}

test('D1 explicit migration preserves evidence, history and originals, then serves SQLite through HTTP', async t => {
  const { root, source, document, topicId, note, text } = await fixture(t)
  const destination = join(root, 'sqlite'), backup = join(root, 'pre-upgrade')
  const result = await migrateLibrary(source, destination, backup)
  assert.equal(result.records, 3)
  assert.equal(result.sourcePreserved, true)
  assert.equal((await verifyBackup(backup)).storage, 'json')
  await assert.rejects(access(join(backup, '.env')))
  assert.deepEqual(JSON.parse(await readFile(join(source, 'documents', document.id + '.json'), 'utf8')), document)
  const store = await createStore(destination)
  try {
    assert.deepEqual(await store.read('notes', note.id), note)
    assert.equal(evidenceVersion(await store.document(document.id)), evidenceVersion(document))
    assert.equal((await store.original(document.id)).toString(), text)
    await store.update('notes', note.id, current => ({ ...current, revision: 2, content: 'New SQLite edit' }))
    await store.update('notes', note.id, async current => ({ ...current, content: current.content + (await store.document(document.id)).title }))
  } finally { store.close() }
  const server = await createApp({ dataDir: destination })
  t.after(() => server.shutdown())
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = 'http://127.0.0.1:' + server.address().port
  assert.equal((await fetch(base + '/api/documents/' + document.id)).status, 200)
  assert.equal((await fetch(base + '/api/topics/' + topicId)).status, 200)
  const response = await fetch(base + '/api/topics', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'SQLite new topic', question: 'Works after migration?' }) })
  assert.equal(response.status, 201)
  await server.shutdown()
  const later = await createStore(destination)
  try { assert.equal((await later.list('topics')).length, 2) } finally { later.close() }
})

test('D1 migration ignores non-record metadata in JSON buckets', async t => {
  const { root, source, document } = await fixture(t)
  await writeFile(join(source, 'documents', '.DS_Store'), 'Finder metadata')
  const destination = join(root, 'sqlite'), backup = join(root, 'backup')
  const result = await migrateLibrary(source, destination, backup)
  assert.equal(result.records, 3)
  const store = await createStore(destination)
  try { assert.equal((await store.document(document.id)).title, document.title) } finally { store.close() }
  assert.ok((await verifyBackup(backup)).files.some(file => file.path === 'documents/.DS_Store'))
})

test('D1 JSON and SQLite backups restore independently and reject modified bytes', async t => {
  const { root, source, document } = await fixture(t)
  const migrated = join(root, 'sqlite')
  await migrateLibrary(source, migrated, join(root, 'before'))
  const backup = join(root, 'sqlite-backup')
  await backupLibrary(migrated, backup)
  const store = await createStore(migrated)
  try { await store.update('documents', document.id, current => ({ ...current, title: 'Changed after backup' })) } finally { store.close() }
  const restored = join(root, 'restored')
  await restoreLibrary(backup, restored)
  const copy = await createStore(restored)
  try { assert.equal((await copy.document(document.id)).title, document.title) } finally { copy.close() }
  const legacyRestore = join(root, 'old-version')
  await restoreLibrary(join(root, 'before'), legacyRestore)
  assert.equal((await createStore(legacyRestore)).document instanceof Function, true)
  const unchanged = await createStore(migrated)
  try { assert.equal((await unchanged.document(document.id)).title, 'Changed after backup') } finally { unchanged.close() }
  const original = join(backup, 'originals', document.id)
  await writeFile(original, 'tampered')
  await assert.rejects(restoreLibrary(backup, join(root, 'invalid-restore')), /校验失败/)
  await assert.rejects(access(join(root, 'invalid-restore')))
})

test('D1 SQLite CAS rejects direct writes during an async update without losing the winner', async t => {
  const { root, source, note } = await fixture(t)
  const target = join(root, 'sqlite'); await migrateLibrary(source, target, join(root, 'backup'))
  const store = await createStore(target)
  const started = Promise.withResolvers(), release = Promise.withResolvers()
  try {
    const pending = store.update('notes', note.id, async current => { started.resolve(); await release.promise; return { ...current, content: 'stale' } })
    const refused = assert.rejects(pending, error => error.status === 409)
    await started.promise
    await store.write('notes', { ...note, content: 'winning direct edit' })
    release.resolve(); await refused
    assert.equal((await store.read('notes', note.id)).content, 'winning direct edit')
  } finally { release.resolve(); store.close() }
})

test('D1 unknown formats reject before interruption updates and corrupt databases remain untouched', async t => {
  const { root, source, store } = await fixture(t)
  const id = randomUUID(), record = { id, status: 'running', createdAt: new Date().toISOString() }
  await store.write('runs', record)
  await writeFile(join(source, 'library-manifest.json'), JSON.stringify({ formatVersion: 99, storage: 'sqlite', state: 'ready' }))
  await assert.rejects(createApp({ dataDir: source }), /格式不受支持/)
  assert.equal(JSON.parse(await readFile(join(source, 'runs', id + '.json'), 'utf8')).status, 'running')
  const broken = join(root, 'broken'); await mkdir(broken)
  await writeFile(join(broken, 'library-manifest.json'), JSON.stringify({ formatVersion: 1, storage: 'sqlite', state: 'ready' }))
  const bytes = Buffer.from('corrupt SQLite fixture')
  await writeFile(join(broken, 'library.sqlite'), bytes)
  await assert.rejects(createApp({ dataDir: broken }))
  assert.deepEqual(await readFile(join(broken, 'library.sqlite')), bytes)
})

test('D1 corrupt and interrupted legacy records stop migration after preserving a verified backup', async t => {
  const { root, source, document } = await fixture(t)
  const file = join(source, 'documents', document.id + '.json')
  await writeFile(file, '{broken bytes')
  await assert.rejects(migrateLibrary(source, join(root, 'new'), join(root, 'backup')))
  assert.equal((await verifyBackup(join(root, 'backup'))).storage, 'json')
  assert.equal(await readFile(file, 'utf8'), '{broken bytes')
  await assert.rejects(access(join(root, 'new')))
  await writeFile(file, JSON.stringify(document))
  await writeFile(file + '.recovery.tmp', JSON.stringify({ ...document, title: 'Uncommitted newer version' }))
  await assert.rejects(migrateLibrary(source, join(root, 'retry'), join(root, 'backup-retry')), /中断写入/)
  assert.ok((await readdir(join(source, 'documents'))).some(name => name.endsWith('.tmp')))
})

test('D1 maintenance rejects active libraries, existing destinations, path escapes and symlinks', async t => {
  const { root, source, document } = await fixture(t)
  await assert.rejects(backupLibrary(join(root, 'missing'), join(root, 'empty-backup')))
  await assert.rejects(access(join(root, 'missing')))
  const owner = await acquireDataLock(source)
  try { await assert.rejects(backupLibrary(source, join(root, 'busy')), { code: 'DATA_DIRECTORY_LOCKED' }) } finally { owner.release() }
  const backup = join(root, 'backup'); await backupLibrary(source, backup)
  await assert.rejects(restoreLibrary(backup, source), /已存在/)
  const manifestPath = join(backup, 'backup-manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const original = manifest.files[0].path
  manifest.files[0].path = '../escape'
  await writeFile(manifestPath, JSON.stringify(manifest))
  await assert.rejects(restoreLibrary(backup, join(root, 'escape')), /无效/)
  manifest.files[0].path = original
  await writeFile(manifestPath, JSON.stringify(manifest))
  const path = join(backup, 'originals', document.id)
  await rm(path); await symlink(join(source, 'originals', document.id), path)
  await assert.rejects(restoreLibrary(backup, join(root, 'symlink')), /符号链接/)
})

test('D1 SQLite backup refuses missing or changed originals and leaves the live library intact', async t => {
  const { root, source, document } = await fixture(t)
  const migrated = join(root, 'sqlite'); await migrateLibrary(source, migrated, join(root, 'before'))
  const original = join(migrated, 'originals', document.id)
  await writeFile(original, 'Changed externally')
  await assert.rejects(backupLibrary(migrated, join(root, 'invalid')), /原文件与数据库不一致/)
  await assert.rejects(access(join(root, 'invalid')))
  assert.equal(await readFile(original, 'utf8'), 'Changed externally')
})

test('D1 migrated research workflow preserves M2-M4 citations and supports edits exports and conflict checks', async t => {
  const app = await reportFixture()
  const root = await mkdtemp(join(tmpdir(), 'classifier-migrated-workflow-'))
  let server
  t.after(async () => { await server?.shutdown(); await app.close(); await rm(root, { recursive: true, force: true }) })
  let report = await app.value('/api/topics/' + app.topic.id + '/reports', json('POST', { title: 'Migrated research', sources: app.selectors }), 201)
  report = await app.value('/api/reports/' + report.id + '/assemble', json('POST', { revision: report.revision }))
  // testApp.close removes its temporary directory. Read a consistent offline copy
  // by shutting down the fixture server via its explicit test-only option below.
  await app.stop()
  const destination = join(root, 'sqlite')
  await migrateLibrary(app.dataDir, destination, join(root, 'backup'))
  async function start() {
    server = await createApp({ dataDir: destination }); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    return 'http://127.0.0.1:' + server.address().port
  }
  let base = await start()
  const request = async (path, options, status = 200) => { const response = await fetch(base + path, options); const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value }
  assert.equal((await request('/api/documents/' + app.first.id)).evidenceVersion, app.first.evidenceVersion)
  const migratedReport = await request('/api/reports/' + report.id)
  assert.deepEqual(migratedReport.blocks, report.blocks)
  assert.ok(migratedReport.evidence.every(item => item.matchesCurrent))
  const note = await request('/api/notes/' + app.note.id)
  await request('/api/notes/' + note.id, json('PATCH', { revision: note.revision, content: 'Edited on SQLite' }))
  let comparison = await request('/api/comparisons/' + app.comparison.id)
  comparison = await request('/api/comparisons/' + comparison.id, json('PATCH', { revision: comparison.revision, title: 'SQLite comparison' }))
  const changes = await Promise.all(['A', 'B'].map(title => fetch(base + '/api/reports/' + report.id, json('PATCH', { revision: report.revision, title }))))
  assert.deepEqual(changes.map(response => response.status).sort(), [200, 409])
  report = await request('/api/reports/' + report.id)
  const exported = await fetch(base + '/api/reports/' + report.id + '/export?revision=' + report.revision)
  assert.equal(exported.status, 200); assert.ok((await exported.text()).includes('Researcher A'))
  await request('/api/documents', upload('Newly imported SQLite source', 'new.txt', app.topic.id), 201)
  await server.shutdown(); base = await start()
  assert.equal((await request('/api/notes/' + note.id)).content, 'Edited on SQLite')
  assert.equal((await request('/api/comparisons/' + comparison.id)).title, 'SQLite comparison')
  assert.equal((await request('/api/documents')).documents.length, 3)
})
