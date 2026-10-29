import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, rm, readdir, symlink, mkdir, open, stat, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { once } from 'node:events'
import { reportFixture } from './helpers/report-fixture.mjs'
import { json } from './helpers/test-app.mjs'
import { createStore } from '../apps/api/src/store.mjs'
import { createApp } from '../apps/api/src/server.mjs'
import { migrateLibrary } from '../apps/api/src/storage-maintenance.mjs'
import { inspectLibrary } from '../apps/api/src/library-inspection.mjs'
import { recordSizeLimit } from '../apps/api/src/record-integrity.mjs'
import { createRuns } from '../apps/api/src/runs.mjs'

for (const storage of ['json', 'sqlite']) test(`${storage} rejects oversized UTF-8 history before publishing and preserves the readable saved version`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'classifier-record-write-boundary-'))
  let store
  t.after(async () => { store?.close?.(); await rm(root, { recursive: true, force: true }) })
  const legacy = join(root, 'legacy'); store = await createStore(legacy)
  const saved = { id: randomUUID(), createdAt: new Date().toISOString(), documentId: randomUUID(), content: '已保存的笔记', evidence: [], history: [] }
  await store.write('documents', { id: saved.documentId, createdAt: saved.createdAt, sections: [], references: [] })
  await store.saveOriginal(saved.documentId, Buffer.from('record limit fixture'))
  await store.write('notes', saved)
  let directory = legacy
  if (storage === 'sqlite') { store.close?.(); directory = join(root, 'sqlite'); await migrateLibrary(legacy, directory, join(root, 'backup')); store = await createStore(directory) }
  const oversized = { ...saved, history: [{ content: '中'.repeat(Math.ceil(recordSizeLimit / 3)), evidence: [] }] }
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) > recordSizeLimit)
  await assert.rejects(async () => store.write('notes', oversized), { status: 413 })
  await assert.rejects(store.update('notes', saved.id, () => oversized), { status: 413 })
  const newId = randomUUID()
  await assert.rejects(async () => store.write('notes', { ...oversized, id: newId }), { status: 413 })
  assert.equal(await store.read('notes', newId), null)
  assert.deepEqual(await store.read('notes', saved.id), saved)
  assert.equal((await store.health()).issueCount, 0)
  if (storage === 'json') assert.deepEqual(await readdir(join(directory, 'notes')), [saved.id + '.json'])
  const runs = createRuns(store)
  try {
    for (const part of ['result', 'event']) {
      const run = await runs.startJob({ purpose: 'record-limit-test' }, async ({ onEvent }) => {
        await onEvent({ message: '保留已保存的查阅记录' })
        if (part === 'event') await onEvent({ message: oversized.history[0].content })
        return { padding: oversized.history[0].content }
      })
      let finished
      for (let i = 0; i < 200; i++) {
        finished = await store.read('runs', run.id)
        if (!['queued', 'running'].includes(finished.status)) break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.equal(finished.status, 'failed')
      assert.match(finished.error, /32 MiB/)
      assert.equal(finished.result, undefined)
      assert.equal(finished.events[0].message, '保留已保存的查阅记录')
      assert.equal(finished.events.length, 1)
    }
  } finally { await runs.stop() }
  assert.equal((await store.health()).issueCount, 0)
  store.close?.(); store = await createStore(directory)
  assert.deepEqual(await store.read('notes', saved.id), saved)
})

for (const storage of ['json', 'sqlite']) test(`${storage} bad records remain explicit and isolated while healthy lists, jobs and saved evidence stay readable`, async t => {
  const app = await reportFixture(), parent = await mkdtemp(join(tmpdir(), 'classifier-integrity-'))
  let server
  t.after(async () => { await server?.shutdown(); await app.close(); await rm(parent, { recursive: true, force: true }) })
  let report = await app.value(`/api/topics/${app.topic.id}/reports`, json('POST', { title: 'Saved research', sources: app.selectors }), 201)
  report = await app.value(`/api/reports/${report.id}/assemble`, json('POST', { revision: report.revision }))
  await app.stop()
  let source = app.dataDir
  if (storage === 'sqlite') { source = join(parent, 'sqlite'); await migrateLibrary(app.dataDir, source, join(parent, 'before')) }
  const goodJob = { id: randomUUID(), status: 'running', createdAt: new Date().toISOString() }, badId = randomUUID()
  const store = await createStore(source); await store.write('runs', goodJob); store.close?.()
  const damaged = storage === 'json' ? '{private damaged research' : JSON.stringify({ id: randomUUID(), createdAt: goodJob.createdAt, private: 'damaged research' })
  if (storage === 'json') {
    await writeFile(join(source, 'documents', app.first.id + '.json'), damaged)
    await writeFile(join(source, 'runs', badId + '.json'), damaged)
  } else {
    const db = new DatabaseSync(join(source, 'library.sqlite'))
    db.prepare("UPDATE records SET body=? WHERE bucket='documents' AND id=?").run(damaged, app.first.id)
    db.prepare("INSERT INTO records(bucket,id,body) VALUES('runs',?,?)").run(badId, damaged); db.close()
  }
  async function start() {
    server = await createApp({ dataDir: source }); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    return 'http://127.0.0.1:' + server.address().port
  }
  let base = await start()
  async function value(path, options, status = 200) { const response = await fetch(base + path, options); const body = await response.json(); assert.equal(response.status, status, JSON.stringify(body)); return body }
  assert.equal((await value('/api/topics')).topics.length, 1)
  assert.equal((await value('/api/documents')).documents.some(doc => doc.id === app.first.id), false)
  const topic = await value('/api/topics/' + app.topic.id)
  assert.equal(topic.documents.find(link => link.documentId === app.first.id).document.unavailable, 'corrupt')
  const note = await value('/api/notes/' + app.note.id)
  assert.equal(note.sourceState, 'corrupt'); assert.ok(note.evidence.every(item => !item.matchesCurrent)); assert.ok(note.content)
  const comparison = await value('/api/comparisons/' + app.comparison.id)
  assert.equal(comparison.documents.find(doc => doc.id === app.first.id).unavailable, 'corrupt')
  const saved = await value('/api/reports/' + report.id)
  assert.deepEqual(saved.blocks.map(block => block.text), report.blocks.map(block => block.text))
  assert.ok(saved.evidence.filter(item => item.documentId === app.first.id).every(item => item.sourceState === 'corrupt' && !item.matchesCurrent))
  assert.equal((await value('/api/runs/' + goodJob.id)).status, 'interrupted')
  for (const path of ['/api/documents/' + app.first.id, '/api/runs/' + badId]) assert.equal((await value(path, undefined, 503)).code, 'RECORD_CORRUPT')
  assert.equal((await value('/api/documents/' + app.first.id, json('PATCH', { title: 'must not overwrite damage' }), 503)).code, 'RECORD_CORRUPT')
  const health = await value('/api/library-health')
  assert.equal(health.issueCount, 2); assert.ok(health.issues.every(item => item.preserved))
  assert.ok(!JSON.stringify(health).includes('private')); assert.ok(!JSON.stringify(health).includes('damaged research'))
  for (const item of health.issues) assert.equal(await readFile(join(source, item.quarantinePath), 'utf8'), damaged)
  await server.shutdown(); base = await start()
  assert.equal((await value('/api/library-health')).issueCount, 2)
  await server.shutdown()
  assert.equal((await inspectLibrary(source)).quarantinedRecords, 2)
  if (storage === 'json') assert.equal(await readFile(join(source, 'documents', app.first.id + '.json'), 'utf8'), damaged)
  else { const db = new DatabaseSync(join(source, 'library.sqlite'), { readOnly: true }); assert.equal(db.prepare("SELECT body FROM records WHERE bucket='documents' AND id=?").get(app.first.id).body, damaged); db.close() }
})

test('JSON concurrent reads preserve one redacted isolation record and normal writes cannot replace damaged bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'classifier-quarantine-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = await createStore(root), id = randomUUID(), path = join(root, 'notes', id + '.json'), bytes = 'private broken note'
  await writeFile(path, bytes)
  await Promise.allSettled(Array.from({ length: 8 }, () => store.read('notes', id)))
  const health = await store.health(); assert.equal(health.issueCount, 1); assert.equal(health.issues[0].preserved, true)
  assert.equal((await readdir(join(root, 'quarantine/records'))).length, 2)
  await assert.rejects(store.write('notes', { id, createdAt: new Date().toISOString() }), { code: 'RECORD_CORRUPT' })
  assert.equal(await readFile(path, 'utf8'), bytes)
  const repaired = { id, createdAt: new Date().toISOString(), documentId: randomUUID(), content: 'explicit external recovery', evidence: [], history: [] }
  await writeFile(path, JSON.stringify(repaired))
  assert.deepEqual(await store.read('notes', id), repaired); assert.equal((await store.health()).issueCount, 0)
  assert.equal((await inspectLibrary(root)).quarantinedRecords, 1)
})

test('JSON isolation rejects source and quarantine symlinks without following them', async t => {
  const root = await mkdtemp(join(tmpdir(), 'classifier-unsafe-isolation-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = await createStore(root), outside = join(root, 'outside'), external = join(root, 'external.txt'), id = randomUUID(), badId = randomUUID()
  await mkdir(outside); await writeFile(external, 'outside content')
  await symlink(external, join(root, 'notes', id + '.json')); await symlink(outside, join(root, 'quarantine'))
  await writeFile(join(root, 'notes', badId + '.json'), '{bad')
  assert.equal((await store.list('notes')).length, 0)
  const health = await store.health(); assert.equal(health.issueCount, 2); assert.ok(health.issues.every(item => !item.preserved))
  assert.deepEqual(await readdir(outside), []); assert.equal(await readFile(external, 'utf8'), 'outside content')
})

test('JSON startup keeps interrupted edits visible and leaves a healthy saved version unchanged', async t => {
  const root = await mkdtemp(join(tmpdir(), 'classifier-temporary-notice-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = await createStore(root), id = randomUUID(), saved = { id, createdAt: new Date().toISOString(), documentId: randomUUID(), content: 'saved', evidence: [], history: [] }
  await store.write('notes', saved)
  const temporary = join(root, 'notes', id + '.json.' + randomUUID() + '.tmp'), bytes = JSON.stringify({ ...saved, content: 'interrupted newer edit' })
  await writeFile(temporary, bytes)
  const reopened = await createStore(root)
  assert.deepEqual(await reopened.read('notes', id), saved)
  assert.equal((await reopened.health()).issues[0].reason, 'INTERRUPTED_WRITE')
  assert.equal(await readFile(temporary, 'utf8'), bytes)
})

test('invalid record containers and oversized records are reported consistently without blocking healthy entries', async t => {
  const root = await mkdtemp(join(tmpdir(), 'classifier-invalid-containers-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = await createStore(root), id = randomUUID(), largeId = randomUUID(), good = { id: randomUUID(), createdAt: new Date().toISOString(), title: 'healthy topic', documents: [] }
  await store.write('topics', good)
  await writeFile(join(root, 'topics', id + '.json'), JSON.stringify({ id, createdAt: good.createdAt, documents: null }))
  const path = join(root, 'topics', largeId + '.json'), handle = await open(path, 'w')
  try { await handle.truncate(32 * 1024 ** 2 + 1) } finally { await handle.close() }
  assert.deepEqual(await store.list('topics'), [good])
  const health = await store.health(); assert.equal(health.issueCount, 2)
  assert.equal(health.issues.find(item => item.id === largeId).preserved, false)
  assert.equal((await stat(path)).size, 32 * 1024 ** 2 + 1)
  const inspection = await inspectLibrary(root)
  assert.ok(inspection.issues.some(issue => issue.code === 'invalid-record'))
  assert.ok(inspection.issues.some(issue => issue.code === 'record-too-large'))
})

test('a symlinked record bucket is reported without listing or reading the outside directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'classifier-unsafe-record-folder-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = await createStore(root), outside = join(root, 'outside'), id = randomUUID()
  await mkdir(outside); await writeFile(join(outside, 'private-name.json'), 'private outside bytes')
  await rename(join(root, 'notes'), join(root, 'notes-saved')); await symlink(outside, join(root, 'notes'), 'dir')
  assert.deepEqual(await store.list('notes'), [])
  const health = await store.health()
  assert.equal(health.issueCount, 1); assert.equal(health.issues[0].path, 'notes')
  assert.ok(!JSON.stringify(health).includes('private-name'))
  await assert.rejects(store.read('notes', id), { code: 'RECORD_CORRUPT' })
  assert.equal(await readFile(join(outside, 'private-name.json'), 'utf8'), 'private outside bytes')
})
