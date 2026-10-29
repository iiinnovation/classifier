import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { createStore } from '../apps/api/src/store.mjs'
import { migrateLibrary, verifyBackup } from '../apps/api/src/storage-maintenance.mjs'
import { createApp } from '../apps/api/src/server.mjs'
import { once } from 'node:events'
import { reportFixture } from './helpers/report-fixture.mjs'
import { json, upload } from './helpers/test-app.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'classifier-migration-validation-')), source = join(root, 'source')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await createStore(source), createdAt = new Date().toISOString(), bytes = Buffer.from('Unchanged migration evidence')
  const document = { id: randomUUID(), createdAt, title: 'Original', sections: [{ title: 'Text', text: bytes.toString() }], references: [{ id: 'ref_00001', text: bytes.toString() }], warnings: [], source: { sha256: createHash('sha256').update(bytes).digest('hex') } }
  const topic = { id: randomUUID(), createdAt, title: 'Research', question: 'Keep evidence', documents: [{ documentId: document.id }] }
  const note = { id: randomUUID(), createdAt, topicId: topic.id, documentId: document.id, field: '主要发现', content: 'Saved note', kind: 'user', status: 'recorded', origin: { type: 'manual' }, evidence: [], history: [], revision: 1 }
  await store.saveOriginal(document.id, bytes)
  for (const [bucket, value] of [['documents', document], ['topics', topic], ['notes', note]]) await store.write(bucket, value)
  return { root, source, document, topic, note }
}

test('migration rejects a structurally damaged record after retaining a verified pre-upgrade backup', async t => {
  const { root, source, note } = await fixture(t), path = join(source, 'notes', note.id + '.json')
  const bytes = JSON.stringify({ ...note, evidence: [null] })
  await writeFile(path, bytes)
  const target = join(root, 'target'), backup = join(root, 'before')
  await assert.rejects(migrateLibrary(source, target, backup), { code: 'RECORD_CORRUPT' })
  await assert.rejects(access(target), { code: 'ENOENT' })
  await verifyBackup(backup)
  assert.equal(await readFile(path, 'utf8'), bytes)
  assert.equal(await readFile(join(backup, 'notes', note.id + '.json'), 'utf8'), bytes)
})

test('migration refuses a current comparison row whose document is missing', async t => {
  const { root, source, document, topic } = await fixture(t)
  const comparison = { id: randomUUID(), createdAt: new Date().toISOString(), topicId: topic.id, documentIds: [document.id, randomUUID()], columns: [], cells: [], analyses: [], history: [] }
  const path = join(source, 'comparisons', comparison.id + '.json'), bytes = JSON.stringify(comparison)
  await writeFile(path, bytes)
  const target = join(root, 'target'), backup = join(root, 'before')
  await assert.rejects(migrateLibrary(source, target, backup), /比较表引用缺失文献/)
  await assert.rejects(access(target), { code: 'ENOENT' })
  await verifyBackup(backup)
  assert.equal(await readFile(path, 'utf8'), bytes)
  assert.equal(await readFile(join(backup, 'comparisons', comparison.id + '.json'), 'utf8'), bytes)
})

test('migration resolves current comparison document IDs with the existing UUID casing rule', async t => {
  const { root, source, document, topic } = await fixture(t)
  const comparison = { id: randomUUID(), createdAt: new Date().toISOString(), topicId: topic.id, documentIds: [document.id.toUpperCase()], columns: [], cells: [], analyses: [], history: [] }
  await (await createStore(source)).write('comparisons', comparison)
  const target = join(root, 'target')
  await migrateLibrary(source, target, join(root, 'before'))
  const migrated = await createStore(target)
  try { assert.deepEqual(await migrated.read('comparisons', comparison.id), comparison) }
  finally { migrated.close() }
})

test('migration retains copied materials and stale analysis/history after their live sources disappear', async t => {
  const app = await reportFixture(), root = await mkdtemp(join(tmpdir(), 'classifier-migration-snapshots-'))
  let server
  t.after(async () => { await server?.shutdown(); await app.close(); await rm(root, { recursive: true, force: true }) })
  let comparison = await app.value(`/api/comparisons/${app.comparison.id}/cells/${app.first.id}/${app.comparison.columns[0].id}`, json('PATCH', { revision: app.comparison.revision, source: { type: 'note', noteId: app.note.id, revision: app.note.revision } }))
  comparison = await app.value(`/api/comparisons/${comparison.id}/analyses/${comparison.columns[0].id}`, json('PATCH', { revision: comparison.revision, documentIds: comparison.documentIds, relation: 'difference', value: 'Saved analysis from both documents', conditions: 'Keep the original inputs' }))
  let report = await app.value(`/api/topics/${app.topic.id}/reports`, json('POST', { title: 'Copied sources survive migration', sources: [app.selectors[0], { type: 'comparison', id: comparison.id, revision: comparison.revision }] }), 201)
  report = await app.value(`/api/reports/${report.id}/assemble`, json('POST', { revision: report.revision }))
  const third = await app.value('/api/documents', upload('Replacement current document', 'third.txt', app.topic.id), 201)
  comparison = await app.value(`/api/comparisons/${comparison.id}`, json('PATCH', { revision: comparison.revision, documentIds: [app.first.id, third.id] }))
  // Removing a row deliberately leaves its old analysis inputs/history intact.
  assert.ok(comparison.analyses.some(item => item.rows.some(row => row.documentId === app.second.id)))
  await app.value(`/api/topics/${app.topic.id}/documents/${app.second.id}`, { method: 'DELETE' })
  await app.stop()
  await rm(join(app.dataDir, 'documents', app.second.id + '.json'))
  await rm(join(app.dataDir, 'originals', app.second.id))
  await rm(join(app.dataDir, 'notes', app.note.id + '.json'))
  const sourceBytes = {}
  for (const [bucket, id] of [['comparisons', comparison.id], ['reports', report.id]]) sourceBytes[bucket] = await readFile(join(app.dataDir, bucket, id + '.json'), 'utf8')
  const target = join(root, 'target'), backup = join(root, 'before')
  await migrateLibrary(app.dataDir, target, backup)
  await verifyBackup(backup)
  const store = await createStore(target)
  try {
    for (const [bucket, id] of [['comparisons', comparison.id], ['reports', report.id]]) {
      assert.deepEqual(await store.read(bucket, id), JSON.parse(sourceBytes[bucket]))
      assert.equal(await readFile(join(app.dataDir, bucket, id + '.json'), 'utf8'), sourceBytes[bucket])
      assert.equal(await readFile(join(backup, bucket, id + '.json'), 'utf8'), sourceBytes[bucket])
    }
  } finally { store.close() }
  server = await createApp({ dataDir: target }); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = 'http://127.0.0.1:' + server.address().port
  const shown = await fetch(`${base}/api/reports/${report.id}`)
  assert.equal(shown.status, 200)
  assert.deepEqual((await shown.json()).blocks.map(block => block.text), report.blocks.map(block => block.text))
  const exported = await fetch(`${base}/api/reports/${report.id}/export?revision=${report.revision}`)
  assert.equal(exported.status, 200); assert.ok((await exported.text()).includes(app.second.references[0].text))
  const current = await fetch(`${base}/api/comparisons/${comparison.id}`)
  assert.equal(current.status, 200); assert.ok((await current.json()).analyses.every(item => item.outdated))
})
