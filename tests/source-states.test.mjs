import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, unlink, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { reportFixture, reportReply, waitReportRun } from './helpers/report-fixture.mjs'
import { json } from './helpers/test-app.mjs'
import { availableRecord } from '../apps/api/src/record-integrity.mjs'
import { evidenceStatus } from '../apps/api/src/evidence.mjs'
import { randomUUID } from 'node:crypto'

async function fixture(t, storage) {
  const previous = process.env.CLASSIFIER_TEST_STORAGE
  process.env.CLASSIFIER_TEST_STORAGE = storage
  let app, calls = 0
  try {
    app = await reportFixture({ config: { url: 'https://fixture.invalid', key: 'test-only', model: 'fixture' }, fetchImpl: async (_url, options) => {
      calls++; const input = JSON.parse(JSON.parse(options.body).messages.at(-1).content)
      const reply = input.column ? {
        cells: input.documents.map(document => ({ documentId: document.id, value: '当前来源的比较内容', status: 'recorded', kind: 'source', conditions: '测试材料', comparability: 'unchecked', reason: '', referenceIds: input.evidence.filter(item => item.documentId === document.id).map(item => item.id) })),
        analysis: { relation: 'insufficient', value: '仍需核对条件', conditions: '', referenceIds: input.evidence.map(item => item.id) },
      } : reportReply(input)
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }))
    } })
  } finally { if (previous === undefined) delete process.env.CLASSIFIER_TEST_STORAGE; else process.env.CLASSIFIER_TEST_STORAGE = previous }
  t.after(() => app.close())
  app.note = await app.value(`/api/notes/${app.note.id}`, json('PATCH', { revision: app.note.revision, content: app.note.content }))
  app.selectors[0].revision = app.note.revision
  let report = await app.value(`/api/topics/${app.topic.id}/reports`, json('POST', { title: '来源状态', sources: app.selectors }), 201)
  report = await app.value(`/api/reports/${report.id}/assemble`, json('POST', { revision: report.revision }))
  const path = `/api/reports/${report.id}`
  const run = await app.value(path + '/suggestions', json('POST', { revision: report.revision }), 202)
  assert.equal((await waitReportRun(app, run.id)).status, 'completed')
  async function damage(bucket, id, state) {
    if (storage === 'json') {
      const path = join(app.dataDir, bucket, id + '.json')
      if (state === 'missing') await unlink(path); else await writeFile(path, '{broken source')
    } else {
      const db = new DatabaseSync(join(app.dataDir, 'library.sqlite'))
      try {
        if (state === 'missing') db.prepare('DELETE FROM records WHERE bucket=? AND id=?').run(bucket, id)
        else { db.exec('PRAGMA ignore_check_constraints=ON'); db.prepare('UPDATE records SET body=? WHERE bucket=? AND id=?').run('{broken source', bucket, id) }
      } finally { db.close() }
    }
  }
  return { ...app, report, path, run, damage, calls: () => calls }
}

for (const storage of ['json', 'sqlite']) for (const state of ['missing', 'corrupt']) test(`${storage} ${state} originals remain explicit across saved research, history, export, selection and model boundaries`, async t => {
  const f = await fixture(t, storage), beforeCalls = f.calls()
  await f.damage('documents', f.first.id, state)
  // No source revisions changed: these refusals must be caused by the missing
  // or corrupt original, not an unrelated stale-note conflict.
  await f.value(f.path + '/suggestions', json('POST', { revision: f.report.revision }), 409)
  await f.value(f.path + '/adopt', json('POST', { revision: f.report.revision, runId: f.run.id }), 409)
  assert.equal(f.calls(), beforeCalls)
  const topic = await f.value(`/api/topics/${f.topic.id}`)
  assert.equal(topic.documents.find(link => link.documentId === f.first.id).document.unavailable, state)
  let note = await f.value(`/api/notes/${f.note.id}`)
  assert.equal(note.sourceState, state); assert.equal(note.history[0].evidence[0].sourceState, state)
  assert.ok(note.history[0].evidence[0].reference.text); assert.equal(note.evidence[0].matchesCurrent, false)
  note = await f.value(`/api/notes/${f.note.id}`, json('PATCH', { revision: note.revision, archived: true }))
  note = await f.value(`/api/notes/${f.note.id}`, json('PATCH', { revision: note.revision, restoreRevision: 1 }))
  assert.equal(note.sourceState, state); assert.equal(note.content, f.note.content)
  await f.value(`/api/notes/${f.note.id}`, json('PATCH', { revision: note.revision, reviewState: 'checked' }), state === 'missing' ? 404 : 503)
  const table = await f.value(`/api/comparisons/${f.comparison.id}/history`)
  const all = [...table.cells, ...table.history.flatMap(version => version.cells)].flatMap(cell => cell.evidence).filter(item => item.documentId === f.first.id)
  assert.ok(all.length > 1); assert.ok(all.every(item => item.sourceState === state && !item.matchesCurrent))
  assert.ok((await f.value(`/api/topics/${f.topic.id}/comparisons`)).comparisons[0].sourceIssues.some(item => item.id === f.first.id && item.state === state))
  const report = await f.value(f.path + '/history')
  assert.ok(report.evidence.filter(item => item.documentId === f.first.id).every(item => item.sourceState === state && !item.matchesCurrent))
  assert.ok(report.history.length); assert.ok(report.history[0].sources.some(source => source.documents.some(doc => doc.id === f.first.id && doc.sourceState === state)))
  assert.equal(report.blocks[0].text, f.report.blocks[0].text)
  assert.ok((await f.value(`/api/topics/${f.topic.id}/reports`)).reports[0].sourceIssues.some(item => item.id === f.first.id && item.state === state))
  const catalog = await f.value(`/api/topics/${f.topic.id}/report-materials`)
  assert.equal(catalog.materials.find(item => item.id === f.note.id).unavailable, state)
  const exported = await (await f.request(f.path + `/export?revision=${report.revision}`)).text()
  assert.match(exported, state === 'missing' ? /原文缺失/ : /原文记录损坏/); assert.match(exported, /保留历史摘录/); assert.doesNotMatch(exported, /原文已删除/)
  await f.value(`/api/topics/${f.topic.id}/documents/${f.first.id}/note-suggestions`, json('POST', { field: '主要发现' }), state === 'missing' ? 404 : 503)
  await f.value(`/api/comparisons/${f.comparison.id}/cells/${f.first.id}/${f.comparison.columns[0].id}`, json('PATCH', { revision: table.revision, source: { type: 'note', noteId: f.note.id, revision: note.revision } }), state === 'missing' ? 404 : 503)
  assert.equal(f.calls(), beforeCalls)
  assert.equal((await f.value(f.path)).revision, f.report.revision)
})

for (const state of ['missing', 'corrupt']) test(`copied ${state} notes and comparisons are distinguished even after material removal`, async t => {
  const f = await fixture(t, 'json')
  const retained = await f.value(f.path, json('PATCH', { revision: f.report.revision, sources: [] }))
  await f.damage('notes', f.note.id, state); await f.damage('comparisons', f.comparison.id, state)
  const report = await f.value(f.path + '/history')
  assert.equal(report.sources.length, 0)
  assert.ok(report.blocks.filter(block => block.origin.type === 'material').every(block => block.sourceState === state && block.outdated))
  assert.ok(report.history.some(version => version.sources.some(source => source.sourceState === state)))
  assert.equal(report.blocks[0].text, retained.blocks[0].text)
  assert.ok((await f.value(`/api/topics/${f.topic.id}/reports`)).reports[0].sourceIssues.some(item => item.bucket === 'notes' && item.state === state))
  const text = await (await f.request(f.path + `/export?revision=${report.revision}`)).text()
  assert.match(text, state === 'missing' ? /来源材料缺失/ : /来源材料记录损坏/)
})

test('read failures stay distinct from missing/corrupt sources and cannot match an absent version', async () => {
  const id = '00000000-0000-0000-0000-000000000001'
  for (const [code, state] of [['RECORD_UNAVAILABLE', 'unavailable'], ['RECORD_CORRUPT', 'corrupt']]) {
    const current = await availableRecord({ async read() { throw Object.assign(new Error('fixture'), { code }) } }, 'documents', id)
    assert.equal(current.state, state); assert.equal(evidenceStatus({ documentId: id }, current).matchesCurrent, false)
  }
  assert.equal(evidenceStatus({ documentId: id }, { value: null, state: 'missing' }).matchesCurrent, false)
})

test('an actual unreadable JSON original is labelled unavailable and recovers without changing saved evidence', async t => {
  const f = await fixture(t, 'json'), path = join(f.dataDir, 'documents', f.first.id + '.json')
  await chmod(path, 0)
  try {
    const topic = await f.value(`/api/topics/${f.topic.id}`)
    assert.equal(topic.documents.find(item => item.documentId === f.first.id).document.unavailable, 'unavailable')
    const note = await f.value(`/api/notes/${f.note.id}`); assert.equal(note.sourceState, 'unavailable')
    const report = await f.value(f.path + '/history')
    assert.equal(report.evidence.find(item => item.documentId === f.first.id).sourceState, 'unavailable')
    const markdown = await (await f.request(f.path + `/export?revision=${report.revision}`)).text()
    assert.match(markdown, /原文暂时无法读取/); assert.doesNotMatch(markdown, /原文缺失|原文记录损坏|已删除/)
    await f.value(f.path + '/suggestions', json('POST', { revision: report.revision }), 409)
  } finally { await chmod(path, 0o600) }
  const restored = await f.value(f.path)
  assert.equal(restored.evidence.find(item => item.documentId === f.first.id).sourceState, 'available')
  assert.equal(restored.evidence.find(item => item.documentId === f.first.id).matchesCurrent, true)
  assert.equal(restored.revision, f.report.revision)
})

test('comparison tasks reject lost note provenance before sending or adopting model content', async t => {
  const f = await fixture(t, 'json'), path = `/api/comparisons/${f.comparison.id}`
  const table = await f.value(path + `/cells/${f.first.id}/${f.comparison.columns[0].id}`, json('PATCH', { revision: f.comparison.revision, source: { type: 'note', noteId: f.note.id, revision: f.note.revision } }))
  const run = await f.value(path + '/suggestions', json('POST', { revision: table.revision, columnId: table.columns[0].id }), 202)
  assert.equal((await waitReportRun(f, run.id)).status, 'completed')
  await f.damage('notes', f.note.id, 'missing')
  const calls = f.calls()
  await f.value(path + '/suggestions', json('POST', { revision: table.revision, columnId: table.columns[0].id }), 409)
  await f.value(path + '/draft', json('POST', { revision: table.revision, requestId: randomUUID(), instruction: '继续比较' }), 409)
  await f.value(path + '/adopt', json('POST', { revision: table.revision, runId: run.id }), 409)
  const shown = await f.value(path + '/history')
  assert.equal(shown.cells[0].noteSources[0].sourceState, 'missing')
  assert.ok(shown.sourceIssues.some(item => item.bucket === 'notes'))
  const catalog = await f.value(`/api/topics/${f.topic.id}/report-materials`)
  assert.equal(catalog.materials.find(item => item.id === table.id).unavailable, 'missing')
  assert.equal(f.calls(), calls); assert.equal(shown.revision, table.revision)
})
