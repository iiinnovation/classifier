import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { createStore } from '../apps/api/src/store.mjs'
import { createApp } from '../apps/api/src/server.mjs'
import { initializeDatabase } from '../apps/api/src/sqlite-store.mjs'
import { DatabaseSync } from 'node:sqlite'
import { backupLibrary, restoreLibrary } from '../apps/api/src/storage-maintenance.mjs'
import { inspectLibrary } from '../apps/api/src/library-inspection.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'classifier-atomic-import-')), directory = join(root, 'library')
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(directory); initializeDatabase(join(directory, 'library.sqlite')).close()
  await writeFile(join(directory, 'library-manifest.json'), JSON.stringify({ formatVersion: 1, storage: 'sqlite', state: 'ready', recordVersion: 1 }))
  const store = await createStore(directory), topic = { id: randomUUID(), title: 'research', question: 'Atomic import?', documents: [], createdAt: new Date().toISOString() }
  await store.write('topics', topic)
  return { root, directory, store, topic }
}
function input(topicId = null) {
  const bytes = Buffer.from('private atomic import original'), createdAt = new Date().toISOString()
  const document = { id: randomUUID(), title: 'atomic document', fileName: 'original.txt', mediaType: 'text/plain', sections: [], references: [], warnings: [], source: { kind: 'upload', sha256: hash(bytes), byteLength: bytes.length }, createdAt }
  const job = { id: randomUUID(), fileName: 'original.txt', createdAt, status: 'running', topicId }
  return { document, bytes, job, topicId }
}

test('SQLite import commits document, latest topic links and task result together without replacing concurrent topic edits', async t => {
  const f = await fixture(t), first = input(f.topic.id), second = input(f.topic.id)
  try {
    await f.store.write('imports', first.job); await f.store.write('imports', second.job)
    await f.store.update('topics', f.topic.id, current => ({ ...current, title: 'edited during parsing' }))
    await Promise.all([first, second].map(value => f.store.commitImport(value.document, value.bytes, { topicId: value.topicId, job: value.job })))
    const topic = await f.store.read('topics', f.topic.id)
    assert.equal(topic.title, 'edited during parsing'); assert.equal(topic.documents.length, 2)
    for (const value of [first, second]) {
      assert.deepEqual(await f.store.document(value.document.id), value.document)
      assert.deepEqual(await f.store.original(value.document.id), value.bytes)
      const job = await f.store.read('imports', value.job.id); assert.equal(job.status, 'completed'); assert.equal(job.documentId, value.document.id)
    }
    assert.equal((await readdir(join(f.directory, 'originals'))).filter(name => name.endsWith('.tmp')).length, 0)
    assert.deepEqual((await inspectLibrary(f.directory)).issues, [])
  } finally { f.store.close() }
})

for (const fault of ['missing-topic', 'changed-job', 'bad-original', 'existing-original', 'cancelled']) test(`SQLite import ${fault} rejects without committing partial metadata`, async t => {
  const f = await fixture(t), value = input(fault === 'missing-topic' ? randomUUID() : f.topic.id)
  try {
    await f.store.write('imports', { ...value.job, ...(fault === 'changed-job' ? { status: 'cancelled' } : {}) })
    const controller = new AbortController(); if (fault === 'cancelled') controller.abort(new Error('cancel before commit'))
    if (fault === 'existing-original') await writeFile(join(f.directory, 'originals', value.document.id), 'unrelated original')
    const bytes = fault === 'bad-original' ? Buffer.from('different bytes') : value.bytes
    await assert.rejects(f.store.commitImport(value.document, bytes, { topicId: value.topicId, job: value.job, signal: controller.signal }))
    assert.equal(await f.store.read('documents', value.document.id), null)
    assert.deepEqual((await f.store.read('topics', f.topic.id)).documents, [])
    assert.equal((await f.store.read('imports', value.job.id)).documentId, undefined)
    if (fault === 'existing-original') assert.equal(await readFile(join(f.directory, 'originals', value.document.id), 'utf8'), 'unrelated original')
    else await assert.rejects(access(join(f.directory, 'originals', value.document.id)))
  } finally { f.store.close() }
})

for (const phase of ['intent', 'stage-synced', 'file-published', 'before-commit', 'after-commit']) test(`SQLite import reconciles SIGKILL at ${phase} without dangling topic links or resurrected tasks`, async t => {
  const f = await fixture(t), value = input(f.topic.id), parameters = join(f.root, 'input.json')
  await f.store.write('imports', value.job); f.store.close()
  await writeFile(parameters, JSON.stringify({ document: value.document, bytes: value.bytes.toString(), job: value.job, topicId: f.topic.id }))
  const child = fork(new URL('./helpers/atomic-import-child.mjs', import.meta.url), [f.directory, parameters, phase], { stdio: 'ignore' })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  const [code, signal] = await once(child, 'exit')
  assert.equal(signal, 'SIGKILL', `unexpected child completion: ${code}`)
  assert.equal(await readFile(parameters + '.checkpoint', 'utf8'), phase)
  const completed = phase === 'after-commit'
  for (let attempt = 0; attempt < 2; attempt++) {
    const reopened = await createStore(f.directory)
    try {
      assert.equal(Boolean(await reopened.read('documents', value.document.id)), completed)
      const topic = await reopened.read('topics', f.topic.id), job = await reopened.read('imports', value.job.id)
      assert.equal(topic.documents.length, completed ? 1 : 0); assert.equal(job.status, completed ? 'completed' : 'interrupted')
      if (completed) assert.deepEqual(await reopened.original(value.document.id), value.bytes)
      else await assert.rejects(reopened.original(value.document.id), { code: 'ENOENT' })
    } finally { reopened.close() }
    assert.equal((await readdir(join(f.directory, 'originals'))).filter(name => name.endsWith('.tmp')).length, 0)
  }
  assert.deepEqual((await inspectLibrary(f.directory)).issues, [])
  await backupLibrary(f.directory, join(f.root, 'backup')); await restoreLibrary(join(f.root, 'backup'), join(f.root, 'restored'))
  const restored = await createStore(join(f.root, 'restored'))
  try { assert.equal(Boolean(await restored.read('documents', value.document.id)), completed) } finally { restored.close() }
})

for (const phase of ['cancel-stage', 'publish-error']) test(`SQLite import ${phase} cleans published intent without committing records`, async t => {
  const f = await fixture(t), value = input(f.topic.id), parameters = join(f.root, 'input.json')
  await f.store.write('imports', value.job); f.store.close()
  await writeFile(parameters, JSON.stringify({ document: value.document, bytes: value.bytes.toString(), job: value.job, topicId: f.topic.id }))
  const child = fork(new URL('./helpers/atomic-import-child.mjs', import.meta.url), [f.directory, parameters, phase], { stdio: 'ignore' })
  const [code, signal] = await once(child, 'exit'); assert.equal(code, 0); assert.equal(signal, null)
  const reopened = await createStore(f.directory)
  try {
    assert.equal(await reopened.read('documents', value.document.id), null)
    assert.deepEqual((await reopened.read('topics', f.topic.id)).documents, [])
    assert.equal((await reopened.read('imports', value.job.id)).status, 'interrupted')
    await assert.rejects(reopened.original(value.document.id), { code: 'ENOENT' })
  } finally { reopened.close() }
  assert.deepEqual(await readdir(join(f.directory, 'originals')), [])
})

test('SQLite constraint failure after the document insert rolls back the document, topic and task as one transaction', async t => {
  const f = await fixture(t), value = input(f.topic.id)
  await f.store.write('imports', value.job)
  const db = new DatabaseSync(join(f.directory, 'library.sqlite'))
  db.exec("CREATE TRIGGER reject_topic BEFORE INSERT ON records WHEN NEW.bucket='topics' BEGIN SELECT RAISE(ABORT,'injected topic constraint failure'); END;")
  db.close()
  try {
    await assert.rejects(f.store.commitImport(value.document, value.bytes, { topicId: value.topicId, job: value.job }), /injected topic constraint failure/)
    assert.equal(await f.store.read('documents', value.document.id), null)
    assert.deepEqual(await f.store.read('topics', f.topic.id), f.topic)
    assert.deepEqual(await f.store.read('imports', value.job.id), value.job)
    assert.deepEqual(await readdir(join(f.directory, 'originals')), [])
  } finally { f.store.close() }
})

test('a reported error after durable SQLite COMMIT cannot turn a completed import into a failed or duplicated task', async t => {
  const f = await fixture(t), value = input(f.topic.id), parameters = join(f.root, 'input.json')
  await f.store.write('imports', value.job); f.store.close()
  await writeFile(parameters, JSON.stringify({ document: value.document, bytes: value.bytes.toString(), job: value.job, topicId: f.topic.id }))
  const child = fork(new URL('./helpers/atomic-import-child.mjs', import.meta.url), [f.directory, parameters, 'commit-ack-error'], { stdio: 'ignore' })
  assert.equal((await once(child, 'exit'))[0], 0)
  const reopened = await createStore(f.directory)
  try {
    assert.equal((await reopened.read('imports', value.job.id)).status, 'completed')
    assert.equal((await reopened.read('topics', f.topic.id)).documents.length, 1)
    assert.deepEqual(await reopened.original(value.document.id), value.bytes)
  } finally { reopened.close() }
})

test('SQLite import recovery preserves mismatched bytes and refuses forged journal paths', async t => {
  const f = await fixture(t), value = input(f.topic.id), operationId = randomUUID(), sentinel = join(f.root, 'sentinel.txt')
  f.store.close(); await writeFile(sentinel, 'outside bytes')
  const temporary = 'originals/.import-' + operationId + '.tmp'
  await writeFile(join(f.directory, temporary), 'unexpected bytes')
  await writeFile(join(f.directory, 'originals', value.document.id), value.bytes)
  const db = new DatabaseSync(join(f.directory, 'library.sqlite'))
  db.prepare('INSERT INTO import_operations(id,document_id,temporary_path,path,expected_sha256,state,created_at) VALUES(?,?,?,?,?,?,?)').run(operationId, value.document.id, temporary, 'originals/' + value.document.id, value.document.source.sha256, 'pending', new Date().toISOString())
  db.prepare('INSERT INTO import_operations(id,document_id,temporary_path,path,expected_sha256,state,created_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(), randomUUID(), '../sentinel.txt', '../sentinel.txt', hash('outside bytes'), 'pending', new Date().toISOString())
  const unlinkedId = randomUUID(), unlinkedDocument = randomUUID(), unlinkedTemporary = 'originals/.import-' + unlinkedId + '.tmp'
  await writeFile(join(f.directory, unlinkedTemporary), value.bytes)
  await writeFile(join(f.directory, 'originals', unlinkedDocument), value.bytes)
  db.prepare('INSERT INTO import_operations(id,document_id,temporary_path,path,expected_sha256,state,created_at) VALUES(?,?,?,?,?,?,?)').run(unlinkedId, unlinkedDocument, unlinkedTemporary, 'originals/' + unlinkedDocument, value.document.source.sha256, 'pending', new Date().toISOString())
  db.close()
  const reopened = await createStore(f.directory)
  try { assert.equal((await reopened.list('documents')).length, 0) } finally { reopened.close() }
  assert.equal(await readFile(sentinel, 'utf8'), 'outside bytes'); assert.equal(await readFile(join(f.directory, temporary), 'utf8'), 'unexpected bytes')
  assert.deepEqual(await readFile(join(f.directory, 'originals', value.document.id)), value.bytes)
  assert.deepEqual(await readFile(join(f.directory, unlinkedTemporary)), value.bytes)
  assert.deepEqual(await readFile(join(f.directory, 'originals', unlinkedDocument)), value.bytes)
  const inspection = await inspectLibrary(f.directory)
  assert.ok(inspection.issues.some(issue => issue.code === 'invalid-import-operation'))
  assert.ok(inspection.issues.some(issue => issue.code === 'pending-import-operation'))
})

test('SQLite HTTP synchronous and background imports use atomic topic commits and completed jobs persist after restart', async t => {
  const f = await fixture(t); f.store.close()
  let server, base
  const start = async () => { server = await createApp({ dataDir: f.directory }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); base = 'http://127.0.0.1:' + server.address().port }
  t.after(() => server?.shutdown()); await start()
  const upload = () => { const form = new FormData(); form.append('file', new Blob(['Atomic import research evidence']), 'import.txt'); form.append('topicId', f.topic.id); return { method: 'POST', body: form } }
  const response = await fetch(base + '/api/documents', upload()); assert.equal(response.status, 201); const document = await response.json()
  const jobResponse = await fetch(base + '/api/imports', upload()); assert.equal(jobResponse.status, 202); let job = await jobResponse.json()
  for (let i = 0; i < 100 && ['queued', 'running'].includes(job.status); i++) { await new Promise(resolve => setTimeout(resolve, 20)); job = await (await fetch(base + '/api/imports/' + job.id)).json() }
  assert.equal(job.status, 'completed')
  await server.shutdown(); await start()
  const topic = await (await fetch(base + '/api/topics/' + f.topic.id)).json()
  assert.deepEqual(new Set(topic.documents.map(link => link.documentId)), new Set([document.id, job.documentId]))
  assert.equal((await (await fetch(base + '/api/imports/' + job.id)).json()).status, 'completed')
  assert.equal((await fetch(base + '/api/documents/' + document.id + '/original')).status, 200)
})
