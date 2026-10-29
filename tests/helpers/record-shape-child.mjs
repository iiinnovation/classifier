import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { once } from 'node:events'

const [root, application] = process.argv.slice(2)
const moduleAt = name => import(pathToFileURL(join(application, 'apps/api/src', name + '.mjs')).href)
const { createStore } = await moduleAt('store'), { createApp } = await moduleAt('server')
const { initializeDatabase } = await moduleAt('sqlite-store'), { evidenceVersion } = await moduleAt('evidence')
const { inspectLibrary } = await moduleAt('library-inspection')
const scenarios = [
  ['documents', 'references', value => { value.references = [null] }],
  ['topics', 'links', value => { value.documents = [null] }],
  ['notes', 'evidence', value => { value.evidence = [null] }],
  ['notes', 'history', value => { value.history = [{ evidence: [null] }] }],
  ['comparisons', 'cells', value => { value.cells = [{ evidence: null }] }],
  ['comparisons', 'analyses', value => { value.analyses = [{ rows: [null] }] }],
  ['reports', 'citations', value => { value.blocks = [{ citationIds: [null] }] }],
  ['reports', 'materials', value => { value.sources = [{ type: 'comparison', content: { cells: [null] } }] }],
  ['runs', 'draft', value => { value.result = { cells: [null] } }],
  ['imports', 'progress', value => { value.progress = [] }],
  ['documents', 'missing-references', value => { delete value.references }],
  ['topics', 'missing-links', value => { delete value.documents }],
  ['notes', 'missing-evidence', value => { delete value.evidence }],
  ['notes', 'missing-history', value => { delete value.history }],
  ['notes', 'missing-historical-evidence', value => { value.history = [{ content: 'Historical note' }] }],
  ['comparisons', 'missing-document-ids', value => { delete value.documentIds }],
  ['comparisons', 'invalid-analysis-column', value => { value.analyses = [{ columnId: randomUUID(), value: 'Saved analysis', evidence: [], rows: [], origin: { type: 'manual' } }] }],
  ['reports', 'missing-materials', value => { delete value.sources }],
  ['reports', 'missing-history', value => { delete value.history }],
  ['runs', 'missing-draft-versions', value => { value.purpose = 'comparison-draft'; delete value.documentVersions }],
]
const results = []
for (const storage of ['json', 'sqlite']) {
  const source = join(root, storage), createdAt = new Date().toISOString()
  await mkdir(source, { recursive: true })
  if (storage === 'sqlite') {
    initializeDatabase(join(source, 'library.sqlite')).close()
    await writeFile(join(source, 'library-manifest.json'), JSON.stringify({ formatVersion: 1, storage, state: 'ready' }))
  }
  const bytes = Buffer.from('Saved original evidence'), id = () => randomUUID()
  const document = { id: id(), createdAt, title: 'Healthy original', fileName: 'source.txt', sections: [{ title: 'Original', text: bytes.toString() }], references: [{ id: 'ref_00001', text: bytes.toString() }], warnings: [], source: { sha256: createHash('sha256').update(bytes).digest('hex') } }
  const topic = { id: id(), createdAt, title: 'Healthy topic', question: 'Preserve saved work', documents: [{ documentId: document.id, selection: 'included', readingStatus: 'read' }] }
  const note = { id: id(), createdAt, topicId: topic.id, documentId: document.id, field: '主要发现', content: 'Healthy note', revision: 1, history: [], origin: { type: 'manual' }, evidence: [{ documentId: document.id, documentVersion: evidenceVersion(document), reference: document.references[0] }] }
  const comparison = { id: id(), createdAt, topicId: topic.id, title: 'Healthy comparison', question: topic.question, documentIds: [document.id], columns: [{ id: id(), name: 'Evidence', description: '' }], cells: [], analyses: [], history: [], revision: 1 }
  const report = { id: id(), createdAt, topicId: topic.id, title: 'Healthy report', question: topic.question, sources: [], evidence: [], blocks: [{ id: id(), section: 'Saved section', text: 'Healthy saved research', kind: 'user', citationIds: [], origin: { type: 'manual' } }], history: [], revision: 1 }
  const records = { documents: document, topics: topic, notes: note, comparisons: comparison, reports: report, runs: { id: id(), createdAt, status: 'completed', events: [] }, imports: { id: id(), createdAt, status: 'completed' } }
  const store = await createStore(source)
  try { await store.saveOriginal(document.id, bytes); for (const [bucket, value] of Object.entries(records)) await store.write(bucket, value) }
  finally { store.close?.() }
  const damaged = scenarios.map(([bucket, name, change]) => {
    const value = { ...structuredClone(records[bucket]), id: id() }; change(value)
    if (bucket === 'runs' || bucket === 'imports') value.status = 'running'
    return { bucket, name, id: value.id, bytes: JSON.stringify(value) }
  })
  if (storage === 'json') for (const entry of damaged) await writeFile(join(source, entry.bucket, entry.id + '.json'), entry.bytes)
  else {
    const db = new DatabaseSync(join(source, 'library.sqlite'))
    try { for (const entry of damaged) db.prepare('INSERT INTO records(bucket,id,body) VALUES(?,?,?)').run(entry.bucket, entry.id, entry.bytes) }
    finally { db.close() }
  }
  for (let restart = 0; restart < 2; restart++) {
    const server = await createApp({ dataDir: source })
    try {
      server.listen(0, '127.0.0.1'); await once(server, 'listening')
      const base = 'http://127.0.0.1:' + server.address().port
      async function get(path, expected = 200) {
        const response = await fetch(base + path), body = await response.json()
        assert.equal(response.status, expected, path + ': ' + JSON.stringify(body)); return body
      }
      assert.equal((await get('/api/topics')).topics.length, 1)
      assert.equal((await get('/api/documents')).documents.length, 1)
      for (const bucket of ['notes', 'comparisons', 'reports']) assert.equal((await get(`/api/topics/${topic.id}/${bucket}`))[bucket].length, 1)
      assert.equal((await get('/api/notes/' + note.id)).content, note.content)
      assert.equal((await get('/api/comparisons/' + comparison.id)).id, comparison.id)
      assert.equal((await get('/api/reports/' + report.id)).blocks[0].text, report.blocks[0].text)
      for (const entry of damaged) assert.equal((await get('/api/' + entry.bucket + '/' + entry.id, 503)).code, 'RECORD_CORRUPT')
      const health = await get('/api/library-health')
      assert.equal(health.issueCount, scenarios.length); assert.ok(health.issues.every(issue => issue.preserved))
      for (const entry of damaged) assert.equal(await readFile(join(source, health.issues.find(issue => issue.id === entry.id).quarantinePath), 'utf8'), entry.bytes)
    } finally { await server.shutdown() }
  }
  const inspection = await inspectLibrary(source)
  assert.equal(inspection.issues.filter(issue => issue.code === 'invalid-record').length, scenarios.length)
  const db = storage === 'sqlite' ? new DatabaseSync(join(source, 'library.sqlite'), { readOnly: true }) : null
  try {
    for (const entry of damaged) {
      const original = db ? db.prepare('SELECT body FROM records WHERE bucket=? AND id=?').get(entry.bucket, entry.id).body : await readFile(join(source, entry.bucket, entry.id + '.json'), 'utf8')
      assert.equal(original, entry.bytes)
    }
  } finally { db?.close() }
  results.push({ storage, scenarios: scenarios.map(([bucket, name]) => ({ bucket, name, passed: true })), restartVerified: true, healthyListsAndSnapshotsReadable: true, damagedTaskBytesUnchanged: true, originalAndQuarantineBytesPreserved: true })
}
process.parentPort.postMessage({ type: 'completed', result: { results, runtime: process.versions, source: application } })
process.parentPort.on('message', () => process.exit(0))
