import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { initializeDatabase } from '../apps/api/src/sqlite-store.mjs'
import { createStore } from '../apps/api/src/store.mjs'
import { deletionPreview } from '../apps/api/src/deletion-preview.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'classifier-delete-recovery-')); t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'library'); await mkdir(directory)
  initializeDatabase(join(directory, 'library.sqlite')).close()
  await writeFile(join(directory, 'library-manifest.json'), JSON.stringify({ formatVersion: 1, storage: 'sqlite', state: 'ready' }))
  const createdAt = new Date().toISOString(), bytes = Buffer.from('Shared original; never unlink an unverified replacement.')
  const document = { id: randomUUID(), title: 'Shared original', createdAt, sections: [], references: [], source: { sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length } }
  const topics = [1, 2, 3].map(i => ({ id: randomUUID(), title: 'Topic ' + i, createdAt, documents: [{ documentId: document.id }] }))
  const note = { id: randomUUID(), createdAt, documentId: document.id, topicId: topics[0].id, content: 'Saved research', evidence: [], history: [{ content: 'Saved historical research', evidence: [] }] }
  const unrelated = { ...document, id: randomUUID(), title: 'Other original' }
  const store = await createStore(directory)
  try {
    await store.saveOriginal(document.id, bytes); await store.saveOriginal(unrelated.id, bytes)
    for (const item of [document, unrelated]) store.write('documents', item)
    for (const topic of topics) store.write('topics', topic)
    store.write('notes', note)
  } finally { store.close() }
  const operationId = randomUUID(), parameters = join(root, 'parameters.json')
  await writeFile(parameters, JSON.stringify({ documentId: document.id, operationId }))
  return { root, directory, document, topics, note, unrelated, bytes, operationId, parameters }
}
async function child(f, phase) {
  const process = spawn(globalThis.process.execPath, [fileURLToPath(new URL('./helpers/deletion-child.mjs', import.meta.url)), f.directory, f.parameters, phase], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  process.stdout.on('data', bytes => { stdout += bytes }); process.stderr.on('data', bytes => { stderr += bytes })
  const result = await new Promise((resolve, reject) => { process.once('error', reject); process.once('exit', (code, signal) => resolve({ code, signal })) })
  return { ...result, stdout, stderr }
}
async function verify(f, deleted) {
  const store = await createStore(f.directory)
  try {
    assert.deepEqual(await store.read('notes', f.note.id), f.note)
    assert.deepEqual(await store.read('documents', f.unrelated.id), f.unrelated)
    assert.deepEqual(await store.original(f.unrelated.id), f.bytes)
    for (const topic of f.topics) assert.equal((await store.read('topics', topic.id)).documents.length, deleted ? 0 : 1)
    if (deleted) {
      assert.equal(await store.read('documents', f.document.id), null); assert.ok(store.deletion('documents', f.document.id))
      await assert.rejects(lstat(join(f.directory, 'originals', f.document.id)), { code: 'ENOENT' })
      assert.equal((await store.health()).issueCount, 0)
    } else {
      assert.deepEqual(await store.read('documents', f.document.id), f.document)
      assert.deepEqual(await store.original(f.document.id), f.bytes)
      assert.equal(store.deletion('documents', f.document.id), null)
      const preview = await deletionPreview(store, { bucket: 'documents', id: f.document.id })
      assert.equal((await store.commitDeletion(preview, f.operationId)).completed, true)
    }
  } finally { store.close() }
}
for (const phase of ['before-commit', 'after-commit', 'before-unlink', 'after-unlink']) test(`SQLite deletion recovers real SIGKILL at ${phase} without partial links, wrong unlinks or lost research`, async t => {
  const f = await fixture(t), result = await child(f, phase)
  assert.equal(result.signal, 'SIGKILL', result.stderr)
  assert.equal(await readFile(f.parameters + '.checkpoint', 'utf8'), phase)
  await verify(f, phase !== 'before-commit'); await verify(f, true)
})
for (const phase of ['sqlite-full', 'unlink-denied', 'directory-sync-error', 'commit-ack-error']) test(`SQLite deletion ${phase} preserves the durable commit boundary and allows recovery`, async t => {
  const f = await fixture(t), result = await child(f, phase)
  assert.equal(result.code, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  if (phase === 'sqlite-full') assert.equal(report.error.errcode, 13)
  else if (phase === 'commit-ack-error') assert.equal(report.result.completed, true)
  else { assert.equal(report.result.completed, false); assert.equal(report.result.filePending, true) }
  await verify(f, phase !== 'sqlite-full'); await verify(f, true)
})
test('a replacement original is preserved during pending deletion, and matching bytes permit a later retry', async t => {
  const f = await fixture(t), result = await child(f, 'unlink-denied')
  assert.equal(result.code, 0, result.stderr)
  const replacement = Buffer.from('Different replacement; must survive automatic recovery')
  await writeFile(join(f.directory, 'originals', f.document.id), replacement)
  const store = await createStore(f.directory)
  try {
    assert.deepEqual(await readFile(join(f.directory, 'originals', f.document.id)), replacement)
    assert.equal((await store.health()).issues[0].reason, 'DELETION_FILE_PENDING')
    assert.equal(store.deletionReceipt(f.operationId, 'documents', f.document.id, JSON.parse(result.stdout).confirmedRevision).completed, false)
  } finally { store.close() }
  await writeFile(join(f.directory, 'originals', f.document.id), f.bytes)
  await verify(f, true)
})

test('task progress does not invalidate confirmation, and completed owned tasks are deleted atomically', async t => {
  const f = await fixture(t), store = await createStore(f.directory)
  try {
    const run = { id: randomUUID(), documentId: f.document.id, createdAt: new Date().toISOString(), status: 'running', events: [] }
    store.write('runs', run)
    const before = await deletionPreview(store, { bucket: 'documents', id: f.document.id })
    store.write('runs', { ...run, events: [{ type: 'progress', message: 'Current work' }] })
    assert.equal((await deletionPreview(store, { bucket: 'documents', id: f.document.id })).revision, before.revision)
    store.write('runs', { ...run, status: 'completed', result: { answer: 'A completed saved answer' }, finishedAt: new Date().toISOString() })
    const final = await deletionPreview(store, { bucket: 'documents', id: f.document.id })
    assert.equal(final.revision, before.revision)
    await store.commitDeletion(final, f.operationId)
    assert.equal(await store.read('runs', run.id), null)
    assert.throws(() => store.write('runs', run), { status: 410 })
  } finally { store.close() }
})

test('missing deletion markers cause version-2 startup to refuse writes instead of permitting resurrection', async t => {
  const f = await fixture(t)
  await child(f, 'commit-ack-error')
  const db = new DatabaseSync(join(f.directory, 'library.sqlite'))
  try { db.prepare('DELETE FROM record_deletions WHERE bucket=? AND id=?').run('documents', f.document.id) } finally { db.close() }
  await assert.rejects(createStore(f.directory), /删除操作的记录标记缺失/)
  const check = new DatabaseSync(join(f.directory, 'library.sqlite'), { readOnly: true })
  try { assert.equal(check.prepare("SELECT count(*) AS n FROM records WHERE bucket='documents' AND id=?").get(f.document.id).n, 0) } finally { check.close() }
})
