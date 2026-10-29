import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { deletionPreview } from '../apps/api/src/deletion-preview.mjs'
import { createStore } from '../apps/api/src/store.mjs'
import { migrateLibrary } from '../apps/api/src/storage-maintenance.mjs'
import { recordBuckets } from '../apps/api/src/storage-layout.mjs'

async function fixture(t, storage = 'json') {
  const root = await mkdtemp(join(tmpdir(), 'classifier-delete-preview-')), source = join(root, 'json'), store = await createStore(source)
  t.after(() => rm(root, { recursive: true, force: true }))
  const createdAt = new Date().toISOString(), id = () => randomUUID(), documentId = id(), columnId = id()
  const document = { id: documentId, createdAt, title: 'Shared original', sections: [], references: [] }
  const topic = { id: id(), createdAt, title: 'Target topic', documents: [{ documentId }] }
  const other = { id: id(), createdAt, title: 'Other topic', documents: [{ documentId }] }
  const note = { id: id(), createdAt, topicId: topic.id, documentId, field: 'Saved note', content: 'User content', evidence: [], history: [{ content: 'Earlier note', evidence: [] }] }
  const comparison = { id: id(), createdAt, topicId: topic.id, title: 'Comparison', documentIds: [documentId], columns: [{ id: columnId, name: 'Method' }], cells: [{ documentId, columnId, value: 'Copied note', evidence: [], noteSources: [{ id: note.id, revision: 1 }], origin: { type: 'note' } }], analyses: [], history: [] }
  const material = { key: 'note:' + note.id, type: 'note', id: note.id, documentIds: [documentId], documents: [{ id: documentId, title: document.title }], evidence: [], content: [{ field: note.field, text: note.content, citationIds: [] }] }
  const report = { id: id(), createdAt, topicId: topic.id, title: 'Local report', sources: [material], evidence: [], blocks: [], history: [] }
  const externalReport = { ...structuredClone(report), id: id(), topicId: other.id, title: 'External historical copy', sources: [], history: [{ sources: [material], evidence: [], blocks: [] }] }
  const unrelated = { ...structuredClone(report), id: id(), topicId: other.id, title: 'Unrelated report', sources: [], blocks: [{ id: id(), section: 'Text', text: note.id, kind: 'user', citationIds: [], origin: { type: 'manual' } }], extension: { noteId: note.id } }
  const records = { documents: [document], topics: [topic, other], notes: [note], comparisons: [comparison], reports: [report, externalReport, unrelated], runs: [], imports: [] }
  await store.saveOriginal(documentId, Buffer.from('Original bytes'))
  for (const [bucket, values] of Object.entries(records)) for (const value of values) await store.write(bucket, value)
  let directory = source, current = store
  if (storage === 'sqlite') { directory = join(root, 'sqlite'); await migrateLibrary(source, directory, join(root, 'before')); current = await createStore(directory); t.after(() => current.close()) }
  return { root, directory, store: current, records, document, topic, other, note, comparison, report, externalReport, unrelated }
}
async function saved(store) { return Object.fromEntries(await Promise.all(recordBuckets.map(async bucket => [bucket, await store.list(bucket)]))) }

for (const storage of ['json', 'sqlite']) test(`${storage} previews cover document, topic, research and detach scope without changing records`, async t => {
  const f = await fixture(t, storage), before = await saved(f.store)
  for (const [bucket, target] of [['documents', f.document], ['topics', f.topic], ['notes', f.note], ['comparisons', f.comparison], ['reports', f.report]]) {
    const value = await deletionPreview(f.store, { bucket, id: target.id })
    assert.equal(value.readOnly, true); assert.equal(value.executionAvailable, storage === 'sqlite'); assert.equal(value.complete, true)
    assert.equal(value.removes.length, bucket === 'topics' ? 4 : 1)
    assert.ok(!value.removes.some(record => record.id === f.externalReport.id))
    if (bucket === 'documents') { assert.equal(value.counts.topicLinks, 2); assert.equal(value.counts.originalDocuments, 1); assert.equal(value.preserves.research.length, 4) }
    if (bucket === 'topics') { assert.deepEqual(value.preserves.documents.map(record => record.id), [f.document.id]); assert.equal(value.counts.historyVersions, 1); assert.equal(value.counts.topicLinks, 1) }
    if (['documents', 'topics', 'notes'].includes(bucket)) {
      const historical = value.preserves.research.find(record => record.id === f.externalReport.id)
      assert.equal(historical.currentReference, false); assert.equal(historical.historicalVersions, 1)
      assert.ok(!value.preserves.research.some(record => record.id === f.unrelated.id))
    }
  }
  const detached = await deletionPreview(f.store, { bucket: 'documents', id: f.document.id, action: 'detach', topicId: f.topic.id })
  assert.equal(detached.removes.length, 0); assert.equal(detached.counts.originalDocuments, 0)
  assert.equal(detached.links.length, 1); assert.equal(detached.links[0].topicId, f.topic.id)
  assert.ok(detached.preserves.research.every(record => record.id !== f.externalReport.id))
  assert.deepEqual(await saved(f.store), before)
  assert.equal((await f.store.original(f.document.id)).toString(), 'Original bytes')
})

test('preview reports tasks by saved inputs and affected comparison/report identity without cancelling them', async t => {
  const f = await fixture(t)
  const jobs = [
    { id: randomUUID(), purpose: 'comparison-suggestion', comparisonId: f.comparison.id, status: 'running' },
    { id: randomUUID(), purpose: 'report-suggestion', reportId: f.externalReport.id, status: 'queued' },
    { id: randomUUID(), purpose: 'comparison-draft', documentVersions: [{ id: f.document.id }], status: 'running' },
    { id: randomUUID(), topicId: f.topic.id, status: 'running' },
  ].map(value => ({ createdAt: new Date().toISOString(), ...value }))
  for (const job of jobs) await f.store.write('runs', job)
  const value = await deletionPreview(f.store, { bucket: 'documents', id: f.document.id })
  assert.equal(value.counts.activeTasks, 2); assert.ok(value.blockers.some(item => item.code === 'ACTIVE_TASKS'))
  assert.ok(!value.tasks.some(task => task.id === jobs[1].id), 'a report with only historical references does not use that source for its current generation')
  const topic = await deletionPreview(f.store, { bucket: 'topics', id: f.topic.id })
  assert.ok(topic.tasks.some(task => task.id === jobs[3].id))
  for (const job of jobs) assert.deepEqual(await f.store.read('runs', job.id), job)
  const importing = await deletionPreview(f.store, { bucket: 'topics', id: f.topic.id, synchronousImports: 1 })
  assert.equal(importing.complete, false); assert.ok(importing.blockers.some(item => item.code === 'SYNCHRONOUS_IMPORTS'))
})

test('preview follows retained paragraph provenance and transitive copied notes without treating prose as references', async t => {
  const f = await fixture(t)
  const source = { id: randomUUID(), section: 'Saved content', text: 'Copied user text without citations', kind: 'user', citationIds: [], origin: { type: 'material', sourceKey: 'comparison:' + f.comparison.id } }
  const copy = { ...f.unrelated, id: randomUUID(), title: 'Retained paragraph', blocks: [source] }
  await f.store.write('reports', copy)
  for (const [bucket, id] of [['notes', f.note.id], ['documents', f.document.id]]) {
    const preview = await deletionPreview(f.store, { bucket, id })
    const retained = preview.preserves.research.find(record => record.id === copy.id)
    assert.equal(retained.currentReference, true); assert.equal(retained.historicalVersions, 0)
    assert.ok(!preview.preserves.research.some(record => record.id === f.unrelated.id))
  }
  const job = { id: randomUUID(), createdAt: new Date().toISOString(), comparisonId: f.comparison.id, purpose: 'comparison-suggestion', status: 'running' }
  await f.store.write('runs', job)
  const preview = await deletionPreview(f.store, { bucket: 'reports', id: copy.id })
  assert.ok(!preview.tasks.some(value => value.id === job.id), 'deleting a copied report does not affect generation of its retained source')
})

for (const storage of ['json', 'sqlite']) test(`${storage} unknown references in damaged records make preview incomplete and preserve damaged bytes`, async t => {
  const f = await fixture(t, storage), bytes = '{damaged', id = randomUUID()
  if (storage === 'json') await writeFile(join(f.directory, 'notes', id + '.json'), bytes)
  else { const db = new DatabaseSync(join(f.directory, 'library.sqlite')); db.exec('PRAGMA ignore_check_constraints=ON'); db.prepare('INSERT INTO records(bucket,id,body) VALUES(?,?,?)').run('notes', id, bytes); db.close() }
  const value = await deletionPreview(f.store, { bucket: 'documents', id: f.document.id })
  assert.equal(value.complete, false); assert.ok(value.blockers.some(item => item.code === 'INCOMPLETE_LIBRARY'))
  await assert.rejects(deletionPreview(f.store, { bucket: 'notes', id }), { code: 'RECORD_CORRUPT' })
  if (storage === 'json') assert.equal(await readFile(join(f.directory, 'notes', id + '.json'), 'utf8'), bytes)
  else { const db = new DatabaseSync(join(f.directory, 'library.sqlite'), { readOnly: true }); assert.equal(db.prepare('SELECT body FROM records WHERE bucket=? AND id=?').get('notes', id).body, bytes); db.close() }
})

test('preview detects changed snapshots, rejects invalid scope, and produces a stable revision for unchanged data', async t => {
  const f = await fixture(t)
  const args = { bucket: 'notes', id: f.note.id }
  assert.equal((await deletionPreview(f.store, args)).revision, (await deletionPreview(f.store, args)).revision)
  let reads = 0
  const changing = { ...f.store, async list(bucket) { const values = await f.store.list(bucket); if (bucket === 'notes' && ++reads === 2) values[0].content = 'Concurrent edit'; return values } }
  const value = await deletionPreview(changing, args)
  assert.equal(value.complete, false); assert.ok(value.blockers.some(item => item.code === 'LIBRARY_CHANGED'))
  for (const invalid of [{ bucket: 'runs', id: f.note.id }, { ...args, id: '../escape' }, { ...args, action: 'purge' }, { ...args, topicId: f.topic.id }, { ...args, action: 'detach' }]) await assert.rejects(deletionPreview(f.store, invalid), { status: 400 })
  await assert.rejects(deletionPreview(f.store, { ...args, id: randomUUID() }), { status: 404 })
})
