import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { decodeRecord } from '../apps/api/src/record-integrity.mjs'
import { createStore } from '../apps/api/src/store.mjs'
import { createApp } from '../apps/api/src/server.mjs'
import { migrateLibrary } from '../apps/api/src/storage-maintenance.mjs'
import { inspectLibrary } from '../apps/api/src/library-inspection.mjs'
import { reportFixture } from './helpers/report-fixture.mjs'
import { json } from './helpers/test-app.mjs'

const badShapes = [
  ['documents', 'reference item', value => { value.references = [null] }],
  ['documents', 'reference text', value => { value.references = [{ id: 'ref_00001', text: 42 }] }],
  ['documents', 'section item', value => { value.sections = ['not a section'] }],
  ['documents', 'warning item', value => { value.warnings = [{}] }],
  ['topics', 'linked document item', value => { value.documents = [null] }],
  ['topics', 'linked document id', value => { value.documents = [{ documentId: {} }] }],
  ['notes', 'evidence item', value => { value.evidence = [null] }],
  ['notes', 'reference snapshot', value => { value.evidence = [{ reference: null }] }],
  ['notes', 'history evidence', value => { value.history = [{ evidence: [42] }] }],
  ['notes', 'origin', value => { value.origin = [] }],
  ['notes', 'content', value => { value.content = {} }],
  ['comparisons', 'document ids', value => { value.documentIds = [null] }],
  ['comparisons', 'column item', value => { value.columns = [null] }],
  ['comparisons', 'cell evidence', value => { value.cells = [{ evidence: null }] }],
  ['comparisons', 'cell note sources', value => { value.cells = [{ noteSources: [null] }] }],
  ['comparisons', 'analysis rows', value => { value.analyses = [{ rows: [null] }] }],
  ['comparisons', 'history cells', value => { value.history = [{ cells: [null] }] }],
  ['reports', 'block citation ids', value => { value.blocks = [{ citationIds: [null] }] }],
  ['reports', 'material item', value => { value.sources = [null] }],
  ['reports', 'material evidence', value => { value.sources = [{ evidence: [null] }] }],
  ['reports', 'comparison material cells', value => { value.sources = [{ type: 'comparison', content: { cells: [null] } }] }],
  ['reports', 'note material citations', value => { value.sources = [{ type: 'note', content: [{ citationIds: 'broken' }] }] }],
  ['reports', 'history material', value => { value.history = [{ sources: [null] }] }],
  ['runs', 'event item', value => { value.events = [null] }],
  ['runs', 'document versions', value => { value.documentVersions = [null] }],
  ['runs', 'draft result cells', value => { value.result = { cells: [null] } }],
  ['imports', 'progress', value => { value.progress = [] }],
  ...['sections', 'references'].map(field => ['documents', 'missing ' + field, value => { delete value[field] }]),
  ['topics', 'missing links', value => { delete value.documents }],
  ['topics', 'invalid linked id', value => { value.documents = [{ documentId: 'not-a-record-id' }] }],
  ...['documentId', 'content', 'evidence', 'history'].map(field => ['notes', 'missing ' + field, value => { delete value[field] }]),
  ['notes', 'missing history evidence', value => { value.history = [{ content: 'Preserved historical text' }] }],
  ...['topicId', 'documentIds', 'columns', 'cells', 'analyses', 'history'].map(field => ['comparisons', 'missing ' + field, value => { delete value[field] }]),
  ['comparisons', 'missing historical cells', value => { value.history = [{ documentIds: [], columns: [], analyses: [] }] }],
  ...['topicId', 'blocks', 'sources', 'evidence', 'history'].map(field => ['reports', 'missing ' + field, value => { delete value[field] }]),
  ['reports', 'missing historical sources', value => { value.history = [{ blocks: [], evidence: [] }] }],
  ['runs', 'missing draft document versions', value => { value.purpose = 'comparison-draft'; delete value.documentVersions }],
  ['runs', 'missing completed report evidence', value => { value.purpose = 'report-suggestion'; value.status = 'completed'; value.result = { blocks: [] } }],
  ['comparisons', 'cell outside selected documents', value => { value.columns = [{ id: randomUUID(), name: 'Column' }]; value.cells = [{ documentId: randomUUID(), columnId: value.columns[0].id, value: '', evidence: [], noteSources: [], origin: { type: 'manual' } }] }],
  ['comparisons', 'cell outside selected columns', value => { value.documentIds = [randomUUID()]; value.cells = [{ documentId: value.documentIds[0], columnId: randomUUID(), value: '', evidence: [], noteSources: [], origin: { type: 'manual' } }] }],
  ['comparisons', 'analysis outside selected columns', value => { value.analyses = [{ columnId: randomUUID(), value: 'Saved analysis', rows: [], evidence: [], origin: { type: 'manual' } }] }],
  ['comparisons', 'historical analysis outside its own columns', value => { value.history = [{ documentIds: [], columns: [], cells: [], analyses: [{ columnId: randomUUID(), value: 'Saved analysis', rows: [], evidence: [], origin: { type: 'manual' } }] }] }],
]

function minimalRecords() {
  return {
    documents: { sections: [], references: [] }, topics: { documents: [] },
    notes: { documentId: randomUUID(), content: 'Saved text', evidence: [], history: [] },
    comparisons: { topicId: randomUUID(), documentIds: [], columns: [], cells: [], analyses: [], history: [] },
    reports: { topicId: randomUUID(), blocks: [], sources: [], evidence: [], history: [] },
    runs: {}, imports: {},
  }
}

test('record shape validates large typed arrays within a bounded child heap', { timeout: 10000 }, async () => {
  const result = await promisify(execFile)(process.execPath, ['--max-old-space-size=64', fileURLToPath(new URL('./helpers/record-shape-memory.mjs', import.meta.url))])
  const report = JSON.parse(result.stdout)
  assert.equal(report.count, 750000); assert.equal(report.passed, true)
  assert.ok(report.recordBytes < 32 * 1024 ** 2)
})

for (const [bucket, label, damage] of badShapes) test(`record shape rejects ${bucket}: ${label}`, () => {
  const record = { id: randomUUID(), createdAt: new Date().toISOString(), ...minimalRecords()[bucket] }
  assert.deepEqual(decodeRecord(bucket, record.id, JSON.stringify(record)), record)
  damage(record)
  assert.throws(() => decodeRecord(bucket, record.id, JSON.stringify(record)), { code: 'RECORD_CORRUPT' })
})

test('record shape preserves optional legacy fields, unknown extensions and saved evidence bytes', () => {
  const records = {
    documents: { schemaVersion: 2, sections: [], references: [{ id: 'ref_00001', text: 'Original evidence', page: null }], bibliography: { authors: 'A; B', year: '2025' }, source: { sha256: 'a'.repeat(64), byteLength: 12 } },
    topics: { documents: [] },
    notes: { topicId: null, documentId: randomUUID(), content: 'Saved text', evidence: [], history: [{ content: 'Legacy saved text', evidence: [] }], reviewedAt: null },
    comparisons: { topicId: randomUUID(), documentIds: [], columns: [], cells: [], analyses: [], history: [] },
    reports: { topicId: randomUUID(), sources: [], blocks: [], evidence: [], history: [] },
    runs: { events: [], result: { answer: 'kept', extra: [null, { unknown: true }] } },
    imports: { topicId: null, progress: { phase: 'reading', completed: 0, total: null } },
  }
  for (const [bucket, fields] of Object.entries(records)) {
    const record = { id: randomUUID(), createdAt: new Date().toISOString(), ...fields, extension: { notInterpreted: [null, 1] } }
    assert.deepEqual(decodeRecord(bucket, record.id, JSON.stringify(record)), record)
  }
})

for (const storage of ['json', 'sqlite']) test(`${storage} nested record damage is isolated before HTTP lists and healthy research are rendered`, async t => {
  const app = await reportFixture(), parent = await mkdtemp(join(tmpdir(), 'classifier-record-shape-'))
  let server
  t.after(async () => { await server?.shutdown(); await app.close(); await rm(parent, { recursive: true, force: true }) })
  let report = await app.value(`/api/topics/${app.topic.id}/reports`, json('POST', { title: 'Preserved research', sources: app.selectors }), 201)
  report = await app.value(`/api/reports/${report.id}/assemble`, json('POST', { revision: report.revision }))
  await app.stop()
  let source = app.dataDir
  if (storage === 'sqlite') { source = join(parent, 'sqlite'); await migrateLibrary(app.dataDir, source, join(parent, 'before')) }
  const store = await createStore(source), original = {}
  for (const [bucket, id] of [['documents', app.first.id], ['topics', app.topic.id], ['notes', app.note.id], ['comparisons', app.comparison.id], ['reports', report.id]]) original[bucket] = await store.read(bucket, id)
  store.close?.()
  const damaged = badShapes.map(([bucket, label, damage]) => {
    const value = structuredClone(original[bucket] || { createdAt: new Date().toISOString(), status: 'running' })
    value.id = randomUUID(); damage(value)
    return { bucket, id: value.id, label, bytes: JSON.stringify(value) }
  })
  if (storage === 'json') for (const entry of damaged) await writeFile(join(source, entry.bucket, entry.id + '.json'), entry.bytes)
  else {
    const db = new DatabaseSync(join(source, 'library.sqlite'))
    try { for (const entry of damaged) db.prepare('INSERT INTO records(bucket,id,body) VALUES(?,?,?)').run(entry.bucket, entry.id, entry.bytes) }
    finally { db.close() }
  }
  server = await createApp({ dataDir: source }); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = 'http://127.0.0.1:' + server.address().port
  async function value(path, status = 200, options) {
    const response = await fetch(base + path, options), body = await response.json()
    assert.equal(response.status, status, path + ': ' + JSON.stringify(body)); return body
  }
  assert.equal((await value('/api/topics')).topics.length, 1)
  assert.equal((await value('/api/documents')).documents.length, 2)
  assert.equal((await value(`/api/topics/${app.topic.id}/notes`)).notes.length, 1)
  assert.equal((await value(`/api/topics/${app.topic.id}/comparisons`)).comparisons.length, 1)
  assert.equal((await value(`/api/topics/${app.topic.id}/reports`)).reports.length, 1)
  assert.equal((await value('/api/notes/' + app.note.id)).content, app.note.content)
  assert.equal((await value('/api/comparisons/' + app.comparison.id)).id, app.comparison.id)
  assert.deepEqual((await value('/api/reports/' + report.id)).blocks.map(block => block.text), report.blocks.map(block => block.text))
  for (const entry of damaged) assert.equal((await value('/api/' + entry.bucket + '/' + entry.id, 503)).code, 'RECORD_CORRUPT', entry.label)
  const health = await value('/api/library-health')
  assert.equal(health.issueCount, badShapes.length); assert.ok(health.issues.every(issue => issue.preserved))
  for (const entry of damaged) {
    const issue = health.issues.find(issue => issue.id === entry.id)
    assert.equal(await readFile(join(source, issue.quarantinePath), 'utf8'), entry.bytes)
  }
  const badNote = damaged.find(entry => entry.bucket === 'notes')
  assert.equal((await value('/api/notes/' + badNote.id, 503, json('PATCH', { revision: 1, content: 'cannot replace damage' }))).code, 'RECORD_CORRUPT')
  await server.shutdown(); server = null
  const inspection = await inspectLibrary(source)
  assert.equal(inspection.issues.filter(issue => issue.code === 'invalid-record').length, badShapes.length)
  if (storage === 'json') for (const entry of damaged) assert.equal(await readFile(join(source, entry.bucket, entry.id + '.json'), 'utf8'), entry.bytes)
  else {
    const db = new DatabaseSync(join(source, 'library.sqlite'), { readOnly: true })
    try { for (const entry of damaged) assert.equal(db.prepare('SELECT body FROM records WHERE bucket=? AND id=?').get(entry.bucket, entry.id).body, entry.bytes) }
    finally { db.close() }
  }
})
