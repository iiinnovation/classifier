import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, lstat, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { reportFixture, reportReply, waitReportRun } from './helpers/report-fixture.mjs'
import { json } from './helpers/test-app.mjs'
import { createStore } from '../apps/api/src/store.mjs'
import { backupLibrary, restoreLibrary } from '../apps/api/src/storage-maintenance.mjs'
import { inspectLibrary } from '../apps/api/src/library-inspection.mjs'

async function fixture(t, storage = 'sqlite', qaOptions) {
  const previous = process.env.CLASSIFIER_TEST_STORAGE
  process.env.CLASSIFIER_TEST_STORAGE = storage
  let app
  try { app = await reportFixture(qaOptions) }
  finally { if (previous === undefined) delete process.env.CLASSIFIER_TEST_STORAGE; else process.env.CLASSIFIER_TEST_STORAGE = previous }
  t.after(() => app.close())
  let report = await app.value(`/api/topics/${app.topic.id}/reports`, json('POST', { title: '保留研究成果', sources: app.selectors }), 201)
  report = await app.value(`/api/reports/${report.id}/assemble`, json('POST', { revision: report.revision }))
  return { ...app, report }
}
async function confirmation(f, bucket, id, overrides = {}) {
  const preview = await f.value(`/api/deletion-preview/${bucket}/${id}`)
  return { operationId: randomUUID(), revision: preview.revision, policy: preview.policy, confirmed: true, stopTasks: true, ...overrides }
}
const remove = (f, bucket, id, body, status = 200) => f.value(`/api/${bucket}/${id}`, json('DELETE', body), status)

test('JSON deletion stays unavailable and requires explicit migration without changing records or originals', async t => {
  const f = await fixture(t, 'json'), bytes = await readFile(join(f.dataDir, 'originals', f.first.id))
  const preview = await f.value(`/api/deletion-preview/documents/${f.first.id}`)
  assert.equal(preview.executionAvailable, false)
  await remove(f, 'documents', f.first.id, await confirmation(f, 'documents', f.first.id), 422)
  assert.deepEqual(await readFile(join(f.dataDir, 'originals', f.first.id)), bytes)
  assert.equal((await f.value(`/api/reports/${f.report.id}`)).revision, f.report.revision)
})

test('shared document deletion preserves research and history, labels deleted sources, blocks stale generation/adoption and survives restart', async t => {
  let calls = 0
  const f = await fixture(t, 'sqlite', { config: { url: 'https://fixture.invalid', key: 'test-only', model: 'fixture' }, fetchImpl: async (_url, options) => { calls++; const input = JSON.parse(JSON.parse(options.body).messages.at(-1).content); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reportReply(input)) } }] })) } })
  const otherTopics = []
  for (const title of ['共享主题二', '共享主题三']) {
    const topic = await f.value('/api/topics', json('POST', { title, question: '保留共享研究资料' }), 201)
    await f.value(`/api/topics/${topic.id}/documents/${f.first.id}`, { method: 'PUT' }); otherTopics.push(topic)
  }
  const run = await f.value(`/api/reports/${f.report.id}/suggestions`, json('POST', { revision: f.report.revision }), 202)
  assert.equal((await waitReportRun(f, run.id)).status, 'completed')
  const body = await confirmation(f, 'documents', f.first.id)
  const result = await remove(f, 'documents', f.first.id, body)
  assert.equal(result.completed, true); assert.equal(result.filePending, false); assert.equal(result.detachedLinks, 3)
  await assert.rejects(lstat(join(f.dataDir, 'originals', f.first.id)), { code: 'ENOENT' })
  await f.value(`/api/documents/${f.first.id}`, undefined, 410)
  for (const topic of [f.topic, ...otherTopics]) assert.ok(!(await f.value(`/api/topics/${topic.id}`)).documents.some(link => link.documentId === f.first.id))
  const note = await f.value(`/api/notes/${f.note.id}`)
  assert.equal(note.sourceState, 'deleted'); assert.ok(note.evidence[0].reference.text)
  const comparison = await f.value(`/api/comparisons/${f.comparison.id}/history`)
  assert.equal(comparison.cells[0].value, f.comparison.cells[0].value)
  assert.equal(comparison.cells[0].evidence[0].sourceState, 'deleted')
  const saved = await f.value(`/api/reports/${f.report.id}/history`)
  assert.equal(saved.revision, f.report.revision); assert.equal(saved.blocks[0].text, f.report.blocks[0].text)
  assert.ok(saved.history.length); assert.ok(saved.evidence.some(item => item.sourceState === 'deleted'))
  const exported = await (await f.request(`/api/reports/${f.report.id}/export?revision=${saved.revision}`)).text()
  assert.match(exported, /原文已删除/); assert.match(exported, /保留历史摘录/)
  await f.value(`/api/reports/${f.report.id}/suggestions`, json('POST', { revision: saved.revision }), 409)
  await f.value(`/api/reports/${f.report.id}/adopt`, json('POST', { revision: saved.revision, runId: run.id }), 409)
  assert.equal(calls, 1)
  assert.deepEqual(await remove(f, 'documents', f.first.id, body), result)
  await remove(f, 'reports', f.report.id, body, 409)
  await f.restart()
  assert.equal((await f.value(`/api/notes/${f.note.id}`)).sourceState, 'deleted')
  assert.deepEqual(await remove(f, 'documents', f.first.id, body), result)
  const db = new DatabaseSync(join(f.dataDir, 'library.sqlite'), { readOnly: true })
  try { assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2); assert.equal(db.prepare('SELECT count(*) AS n FROM deletion_operations').get().n, 1) } finally { db.close() }
  await f.stop()
  const store = await createStore(f.dataDir)
  try { assert.throws(() => store.write('documents', f.first), { status: 410 }); assert.equal((await store.read('reports', f.report.id)).revision, f.report.revision) } finally { store.close() }
})

test('confirmation and stale preview checks reject before any deletion or file operation', async t => {
  const f = await fixture(t)
  const body = await confirmation(f, 'documents', f.first.id)
  await remove(f, 'documents', f.first.id, { ...body, confirmed: false }, 400)
  await remove(f, 'documents', f.first.id, { ...body, policy: 'purge' }, 400)
  await f.value(`/api/notes/${f.note.id}`, json('PATCH', { revision: f.note.revision, content: '后续人工修改' }))
  await remove(f, 'documents', f.first.id, body, 409)
  assert.ok(await readFile(join(f.dataDir, 'originals', f.first.id)))
  const db = new DatabaseSync(join(f.dataDir, 'library.sqlite'), { readOnly: true })
  try { assert.equal(db.prepare('SELECT count(*) AS n FROM deletion_operations').get().n, 0); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1) } finally { db.close() }
})

test('unknown SQLite record buckets make deletion scope incomplete and preserve the original', async t => {
  const f = await fixture(t), db = new DatabaseSync(join(f.dataDir, 'library.sqlite'))
  try { db.prepare('INSERT INTO records(bucket,id,body) VALUES(?,?,?)').run('unknown-research-type', randomUUID(), JSON.stringify({ documentId: f.first.id })) } finally { db.close() }
  const preview = await f.value(`/api/deletion-preview/documents/${f.first.id}`)
  assert.equal(preview.complete, false)
  assert.ok((await f.value('/api/library-health')).issues.some(issue => issue.reason === 'UNKNOWN_RECORD_BUCKET'))
  await remove(f, 'documents', f.first.id, { operationId: randomUUID(), revision: preview.revision, policy: preview.policy, confirmed: true }, 409)
  assert.ok(await readFile(join(f.dataDir, 'originals', f.first.id)))
})

for (const bucket of ['notes', 'comparisons', 'reports', 'topics']) test(`${bucket} deletion removes owned history and preserves shared documents and copied research`, async t => {
  const f = await fixture(t)
  const target = { notes: f.note, comparisons: f.comparison, reports: f.report, topics: f.topic }[bucket]
  const original = await readFile(join(f.dataDir, 'originals', f.first.id))
  const result = await remove(f, bucket, target.id, await confirmation(f, bucket, target.id))
  assert.equal(result.deletedRecords, bucket === 'topics' ? 4 : 1)
  await f.value(`/api/${bucket}/${target.id}`, undefined, 404)
  assert.deepEqual(await readFile(join(f.dataDir, 'originals', f.first.id)), original)
  assert.ok(await f.value(`/api/documents/${f.first.id}`))
  if (bucket !== 'topics' && bucket !== 'reports') {
    const saved = await f.value(`/api/reports/${f.report.id}/history`)
    assert.equal(saved.blocks[0].text, f.report.blocks[0].text); assert.equal(saved.revision, f.report.revision)
    assert.ok(saved.sources.some(source => source.id === target.id && source.sourceState === 'deleted'))
  }
})

test('deletion stops and awaits related model work, rejects new mutations during the wait, and leaves no record resurrection', async t => {
  let began, aborted, finish
  const started = new Promise(resolve => { began = resolve })
  const cancelled = new Promise(resolve => { aborted = resolve })
  const release = new Promise(resolve => { finish = resolve })
  t.after(() => finish())
  const f = await fixture(t, 'sqlite', { config: { url: 'https://fixture.invalid', key: 'test-only', model: 'fixture' }, fetchImpl: async (_url, options) => {
    began(); await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true })); aborted(); await release; throw options.signal.reason
  } })
  const run = await f.value(`/api/reports/${f.report.id}/suggestions`, json('POST', { revision: f.report.revision }), 202)
  await started
  const body = await confirmation(f, 'reports', f.report.id)
  await remove(f, 'reports', f.report.id, { ...body, stopTasks: false }, 409)
  const pending = remove(f, 'reports', f.report.id, body)
  await cancelled
  await f.value(`/api/notes/${f.note.id}`, json('PATCH', { revision: f.note.revision, content: '等待期间不接纳此写入' }), 409)
  assert.ok(await f.value(`/api/reports/${f.report.id}`))
  finish()
  const result = await pending
  assert.equal(result.completed, true); assert.equal(result.deletedTasks, 1)
  await f.value(`/api/runs/${run.id}`, undefined, 404)
  await f.restart()
  await f.value(`/api/reports/${f.report.id}`, undefined, 404)
  await f.value(`/api/runs/${run.id}`, undefined, 404)
})

test('post-deletion backup and restore preserve deletion markers and saved report exports', async t => {
  const f = await fixture(t)
  await remove(f, 'documents', f.first.id, await confirmation(f, 'documents', f.first.id))
  await f.stop()
  const root = await mkdtemp(join(tmpdir(), 'classifier-deletion-backup-')); t.after(() => rm(root, { recursive: true, force: true }))
  const backup = join(root, 'backup'), restored = join(root, 'restored')
  await backupLibrary(f.dataDir, backup); await restoreLibrary(backup, restored)
  assert.equal((await inspectLibrary(restored)).issueCount, 0)
  const store = await createStore(restored)
  try { assert.ok(store.deletion('documents', f.first.id)); assert.equal(await store.read('documents', f.first.id), null); assert.equal((await store.read('reports', f.report.id)).revision, f.report.revision) } finally { store.close() }
})

test('topic deletion retains copied report content and historical sources in another topic', async t => {
  const f = await fixture(t)
  const other = await f.value('/api/topics', json('POST', { title: '保留复制内容的主题', question: '继续阅读保存的研究内容' }), 201)
  const copiedId = randomUUID(), db = new DatabaseSync(join(f.dataDir, 'library.sqlite'))
  try {
    const record = JSON.parse(db.prepare("SELECT body FROM records WHERE bucket='reports' AND id=?").get(f.report.id).body)
    record.id = copiedId; record.topicId = other.id; record.title = '另一个主题中的保存副本'
    db.prepare('INSERT INTO records(bucket,id,body) VALUES(?,?,?)').run('reports', copiedId, JSON.stringify(record))
  } finally { db.close() }
  const before = await f.value(`/api/reports/${copiedId}/history`)
  await remove(f, 'topics', f.topic.id, await confirmation(f, 'topics', f.topic.id))
  const after = await f.value(`/api/reports/${copiedId}/history`)
  assert.equal(after.blocks[0].text, before.blocks[0].text); assert.equal(after.revision, before.revision)
  assert.equal(after.history.length, before.history.length)
  assert.ok(after.sources.every(source => source.sourceState === 'deleted'))
  const exported = await (await f.request(`/api/reports/${copiedId}/export?revision=${after.revision}`)).text()
  assert.match(exported, /来源材料已删除/); assert.match(exported, /既有文献/)
})
