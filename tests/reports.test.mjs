import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { json, upload } from './helpers/test-app.mjs'
import { reportFixture, reportReply, waitReportRun } from './helpers/report-fixture.mjs'

const editable = report => report.blocks.map(({ id, section, text, kind, citationIds }) => ({ id, section, text, kind, citationIds }))
async function create(app, sources = app.selectors) { return app.value(`/api/topics/${app.topic.id}/reports`, json('POST', { title: '研究总结', sources }), 201) }

test('manual report creation saves initial writing atomically, retries by identity and rejects fabricated evidence', async t => {
  const app = await reportFixture(); t.after(() => app.close())
  const body = { id: randomUUID(), title: '直接开始写作', blocks: [{ id: randomUUID(), section: '研究总结', text: '首次保存的人工论述。', kind: 'user', citationIds: [] }] }
  const path = `/api/topics/${app.topic.id}/reports`
  const first = await app.value(path, json('POST', body), 201)
  assert.equal(first.revision, 1); assert.equal(first.blocks[0].text, body.blocks[0].text)
  assert.equal(first.blocks[0].origin.type, 'manual')
  const again = await app.value(path, json('POST', body), 201)
  assert.equal(again.id, first.id); assert.deepEqual(again.blocks, first.blocks)
  await app.value(path, json('POST', { ...body, blocks: [{ ...body.blocks[0], text: '同一 ID 的另一请求' }] }), 409)
  for (const block of [{ ...body.blocks[0], kind: 'source', citationIds: ['forged'] }, { ...body.blocks[0], kind: 'inference' }, { ...body.blocks[0], text: 'x'.repeat(4001) }]) {
    await app.value(path, json('POST', { ...body, id: randomUUID(), blocks: [block] }), 422)
  }
  assert.equal((await app.value(path)).reports.length, 1)
  const empty = await app.value(path, json('POST', { title: '尚未采用的成果' }), 201)
  await app.value(`/api/reports/${empty.id}/export?revision=1`, undefined, 409)
  await app.restart()
  assert.equal((await app.value(`/api/reports/${first.id}`)).blocks[0].text, body.blocks[0].text)
})

test('M4 materials, manual paragraphs, checked citations, history, export and restart persist together', async t => {
  const app = await reportFixture(); t.after(() => app.close())
  const { value, topic, first, second } = app
  const body = { id: randomUUID(), title: '研究总结', sources: app.selectors }
  let report = await value(`/api/topics/${topic.id}/reports`, json('POST', body), 201)
  assert.equal((await value(`/api/topics/${topic.id}/reports`, json('POST', body), 201)).id, report.id)
  assert.equal(report.evidence.length, 2)
  assert.equal(report.blocks.length, 0)
  const path = `/api/reports/${report.id}`
  report = await value(`${path}/assemble`, json('POST', { revision: report.revision }))
  assert.equal(report.blocks.length, 4)
  assert.ok(report.blocks.some(block => block.text.includes('不可直接比较；测量条件不一致')))
  const paragraphs = editable(report); paragraphs[0].text = '人工修订的研究发现，只适用于所选研究。'
  report = await value(path, json('PATCH', { revision: report.revision, blocks: paragraphs }))
  report = await value(path, json('PATCH', { revision: report.revision, reviewBlockId: report.blocks[0].id }))
  assert.equal(report.blocks[0].reviewState, 'checked')
  const savedRevision = report.revision
  const exported = await app.request(`${path}/export?revision=${report.revision}`)
  assert.equal(exported.status, 200); assert.match(exported.headers.get('content-type'), /text\/markdown/)
  const markdown = await exported.text()
  for (const text of ['人工修订', '已核对', 'Researcher A', '2025', 'Evidence Journal', '10.1000/example', first.id, second.id, first.references[0].title, first.references[0].text, '不可直接比较']) assert.ok(markdown.includes(text), text)
  await value(`${path}/export?revision=1`, undefined, 409)
  report = await value(path, json('PATCH', { revision: report.revision, title: '新标题' }))
  report = await value(path, json('PATCH', { revision: report.revision, restoreRevision: savedRevision }))
  assert.equal(report.title, '研究总结'); assert.equal(report.blocks[0].text, paragraphs[0].text)
  await value(`/api/topics/${topic.id}/documents/${first.id}`, { method: 'DELETE' })
  await app.restart()
  report = await value(path)
  assert.equal(report.blocks[0].text, paragraphs[0].text); assert.ok(report.evidence.every(item => item.matchesCurrent))
  assert.ok((await value(`${path}/history`)).history.length >= 4)
  const raw = JSON.parse(await readFile(join(app.dataDir, 'reports', `${report.id}.json`), 'utf8'))
  assert.equal(raw.evidence[0].matchesCurrent, undefined)
})

test('M4 rejects foreign materials, fabricated citations, false model provenance and conflicting writes', async t => {
  const app = await reportFixture(); t.after(() => app.close())
  const { value, note, first } = app
  const foreign = await value('/api/topics', json('POST', { title: '其他主题', question: '另一个问题' }), 201)
  await value(`/api/topics/${foreign.id}/reports`, json('POST', { title: '错误来源', sources: [{ type: 'note', id: note.id, revision: note.revision }] }), 422)
  await value(`/api/topics/${app.topic.id}/reports`, json('POST', { title: '伪造原文', sources: [{ type: 'passages', documentId: first.id, documentVersion: first.evidenceVersion, referenceIds: ['not-a-passage'] }] }), 422)
  let report = await create(app), path = `/api/reports/${report.id}`
  const block = { section: '总结', text: '结论', kind: 'source', citationIds: ['forged'] }
  await value(path, json('PATCH', { revision: report.revision, blocks: [block] }), 422)
  await value(path, json('PATCH', { revision: report.revision, blocks: [{ ...block, kind: 'inference', citationIds: [report.evidence[0].id] }] }), 422)
  const results = await Promise.all(['A', 'B'].map(title => app.request(path, json('PATCH', { revision: report.revision, title }))))
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409])
  report = await value(path); assert.equal(report.revision, 2)
  await value(`${path}/suggestions`, json('POST', { revision: report.revision }), 409)
})

test('M4 source updates retain old quoted text, flag reviews and export historical locations safely', async t => {
  const app = await reportFixture(); t.after(() => app.close())
  const { value, first } = app
  let report = await create(app, [{ type: 'passages', documentId: first.id, documentVersion: first.evidenceVersion, referenceIds: [first.references[0].id] }]), path = `/api/reports/${report.id}`
  report = await value(`${path}/assemble`, json('POST', { revision: 1 }))
  const saved = editable(report), oldId = report.evidence[0].id
  saved[0].text = '![remote](https://example.invalid/tracker) <script>alert(1)</script>'
  report = await value(path, json('PATCH', { revision: report.revision, blocks: saved }))
  await value(`/api/documents/${first.id}`, json('PATCH', { title: '编辑书目不会改变证据' }))
  assert.equal((await value(path)).evidence[0].matchesCurrent, true)
  const file = join(app.dataDir, 'documents', `${first.id}.json`), doc = JSON.parse(await readFile(file, 'utf8'))
  doc.references[0].text = '原文的新解析版本。'; await writeFile(file, JSON.stringify(doc))
  report = await value(path)
  assert.equal(report.evidence[0].matchesCurrent, false); assert.equal(report.blocks[0].outdated, true)
  await value(path, json('PATCH', { revision: report.revision, reviewBlockId: report.blocks[0].id }), 409)
  const updated = await value(`/api/documents/${first.id}`)
  report = await value(path, json('PATCH', { revision: report.revision, sources: [{ type: 'passages', documentId: first.id, documentVersion: updated.evidenceVersion, referenceIds: [first.references[0].id] }] }))
  assert.equal(report.evidence.length, 2); assert.equal(report.blocks[0].citationIds[0], oldId)
  const markdown = await (await app.request(`${path}/export?revision=${report.revision}`)).text()
  assert.ok(markdown.includes(first.references[0].text)); assert.ok(markdown.includes('原文已变化'))
  assert.ok(markdown.includes('\\!\\[remote\\]')); assert.ok(!markdown.includes('<script>'))
  report = await value(path, json('PATCH', { revision: report.revision, sources: [] }))
  assert.equal(report.evidence[0].id, oldId)
  const old = (await value(`${path}/history`)).history.find(item => item.revision === 2)
  assert.equal(old.evidence[0].matchesCurrent, false); assert.equal(old.evidence[0].reference.text, first.references[0].text)
})

test('M4 suggestions use selected snapshots and cannot overwrite human edits or changed sources', async t => {
  const seen = []; let mode = 'valid'
  const qaOptions = { config: { url: 'https://fixture.invalid', key: 'test-only', model: 'fixture' }, fetchImpl: async (_url, options) => {
    const input = JSON.parse(JSON.parse(options.body).messages[1].content); seen.push(input)
    const result = reportReply(input)
    if (mode === 'forged') result.blocks[0].citationIds = ['unknown']
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }))
  } }
  const app = await reportFixture(qaOptions); t.after(() => app.close())
  const { value, note, first, topic } = app
  let report = await create(app, [app.selectors[0]]), path = `/api/reports/${report.id}`
  async function generate() { const run = await value(`${path}/suggestions`, json('POST', { revision: report.revision }), 202); return waitReportRun(app, run.id) }
  const initial = await generate(); assert.equal(initial.status, 'completed')
  assert.deepEqual(seen[0].evidence.map(item => item.documentId), [first.id]); assert.equal(seen[0].partial, true)
  assert.equal((await value(path)).blocks.length, 0)
  report = await value(path, json('PATCH', { revision: report.revision, blocks: [{ section: '人工判断', text: '保留人工内容', kind: 'user', citationIds: [] }] }))
  await value(`${path}/adopt`, json('POST', { revision: report.revision, runId: initial.id }), 409)
  const stale = await generate()
  const updatedNote = await value(`/api/notes/${note.id}`, json('PATCH', { revision: note.revision, content: '笔记更新后的证据解释' }))
  await value(`${path}/adopt`, json('POST', { revision: report.revision, runId: stale.id }), 409)
  report = await value(path, json('PATCH', { revision: report.revision, sources: [{ type: 'note', id: note.id, revision: updatedNote.revision }] }))
  const good = await generate(); report = await value(`${path}/adopt`, json('POST', { revision: report.revision, runId: good.id }))
  assert.equal(report.blocks[0].origin.runId, good.id); assert.equal(report.blocks[0].reviewState, 'pending')
  assert.ok((await value(`${path}/history`)).history.some(item => item.blocks[0]?.text === '保留人工内容'))
  mode = 'forged'; assert.equal((await generate()).status, 'failed')
  assert.equal((await value(path)).blocks[0].origin.runId, good.id)
  await value(`/api/topics/${topic.id}/documents/${first.id}`, { method: 'DELETE' })
  await value(`${path}/suggestions`, json('POST', { revision: report.revision }), 409)
})

test('M4 cancellation and restart interrupt generation without changing saved text', async t => {
  const qaOptions = { config: { url: 'https://fixture.invalid', key: 'test-only', model: 'fixture' }, fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
    if (options.signal.aborted) reject(options.signal.reason)
    else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
  }) }
  const app = await reportFixture(qaOptions); t.after(() => app.close())
  const report = await create(app), path = `/api/reports/${report.id}`
  const run = await app.value(`${path}/suggestions`, json('POST', { revision: 1 }), 202)
  await app.value(`/api/runs/${run.id}/cancel`, { method: 'POST' })
  assert.equal((await waitReportRun(app, run.id)).status, 'cancelled')
  const id = randomUUID()
  await writeFile(join(app.dataDir, 'runs', `${id}.json`), JSON.stringify({ id, purpose: 'report-suggestion', reportId: report.id, status: 'running', createdAt: new Date().toISOString(), events: [] }))
  await app.restart()
  assert.equal((await app.value(`/api/runs/${id}`)).status, 'interrupted')
  assert.equal((await app.value(path)).revision, 1)
})

test('M4 large assembled reports remain editable while HTTP and content limits still apply', async t => {
  const app = await reportFixture(); t.after(() => app.close())
  const docs = []
  for (const suffix of ['A', 'B']) {
    const imported = await app.value('/api/documents', upload(Array.from({ length: 12 }, (_, i) => `原文 ${suffix} 第 ${i + 1} 段。`).join('\n\n'), `${suffix}.txt`, app.topic.id), 201)
    docs.push(await app.value(`/api/documents/${imported.id}`))
  }
  let table = await app.value(`/api/topics/${app.topic.id}/comparisons`, json('POST', { title: '长成果材料', documentIds: docs.map(doc => doc.id), columns: [{ name: '结果' }] }), 201)
  for (const doc of docs) table = await app.value(`/api/comparisons/${table.id}/cells/${doc.id}/${table.columns[0].id}`, json('PATCH', { revision: table.revision, value: '研究发现。'.repeat(280), status: 'recorded', kind: 'source', source: { type: 'passages', documentVersion: doc.evidenceVersion, referenceIds: doc.references.map(ref => ref.id) } }))
  let report = await create(app, [{ type: 'comparison', id: table.id, revision: table.revision }])
  const path = `/api/reports/${report.id}`
  const initialBlocks = Array.from({ length: 38 }, (_, i) => ({ id: randomUUID(), section: `发现 ${i}`, text: '中'.repeat(700), kind: 'source', citationIds: report.evidence.slice(0, 16).map(item => item.id) }))
  const initial = json('PATCH', { revision: report.revision, blocks: initialBlocks })
  assert.ok(Buffer.byteLength(initial.body) < 128 * 1024)
  report = await app.value(path, initial)
  report = await app.value(`${path}/assemble`, json('POST', { revision: report.revision }))
  assert.equal(report.blocks.length, 40)
  assert.ok(report.blocks.reduce((sum, block) => sum + block.text.length, 0) <= 30000)
  const paragraphs = editable(report); paragraphs[0].text = '改' + paragraphs[0].text.slice(1)
  const options = json('PATCH', { revision: report.revision, blocks: paragraphs })
  assert.ok(Buffer.byteLength(options.body) > 128 * 1024)
  report = await app.value(path, options)
  assert.deepEqual(editable(report), paragraphs)
  await app.restart()
  assert.deepEqual(editable(await app.value(path)), paragraphs)
  assert.equal((await app.request(`${path}/export?revision=${report.revision}`)).status, 200)
  await app.value(path, json('PATCH', { revision: report.revision, blocks: paragraphs.map((block, index) => index === 0 ? { ...block, text: '中'.repeat(4001) } : block) }), 422)
  const oversized = await app.value(path, json('PATCH', { revision: report.revision, title: 'x'.repeat(1024 * 1024) }), 413)
  assert.match(oversized.error, /1024 KiB/)
  const ordinary = await app.value(`/api/topics/${app.topic.id}`, json('PATCH', { title: 'x'.repeat(128 * 1024) }), 413)
  assert.match(ordinary.error, /128 KiB/)
  assert.equal((await app.value(path)).revision, report.revision)
})

test('M4 assembly skips repeated material, retains human edits and adds only changed or removed items', async t => {
  const app = await reportFixture(); t.after(() => app.close())
  const { value } = app
  let report = await create(app), path = `/api/reports/${report.id}`
  const concurrent = await Promise.all([1, 2].map(() => app.request(`${path}/assemble`, json('POST', { revision: report.revision }))))
  assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 409])
  report = await value(path)
  assert.equal(report.blocks.length, 4)
  assert.equal(report.blocks[0].text, `${app.first.title} · ${app.original}`)
  const originalIds = report.blocks.map(block => block.id)
  const changed = editable(report); changed[0].text = '保留已经人工改写的结论'
  report = await value(path, json('PATCH', { revision: report.revision, blocks: changed }))
  report = await value(path, json('PATCH', { revision: report.revision, reviewBlockId: report.blocks[0].id }))
  const checked = report
  report = await value(`${path}/assemble`, json('POST', { revision: report.revision }))
  assert.equal(report.revision, checked.revision)
  assert.equal(report.historyCount, checked.historyCount)
  assert.equal(report.updatedAt, checked.updatedAt)
  assert.deepEqual(report.blocks, checked.blocks)
  assert.equal(report.blocks[0].reviewState, 'checked')

  const reviewedNote = await value(`/api/notes/${app.note.id}`, json('PATCH', { revision: app.note.revision, reviewState: 'checked' }))
  await value(`/api/documents/${app.first.id}`, json('PATCH', { title: '更新后的书目标题' }))
  report = await value(path, json('PATCH', { revision: report.revision, sources: [{ type: 'note', id: reviewedNote.id, revision: reviewedNote.revision }, { type: 'comparison', id: app.comparison.id, retain: true }] }))
  const metadataRevision = report.revision
  report = await value(`${path}/assemble`, json('POST', { revision: report.revision }))
  assert.equal(report.revision, metadataRevision)
  assert.equal(report.blocks.length, 4)

  const note = await value(`/api/notes/${app.note.id}`, json('PATCH', { revision: reviewedNote.revision, content: '新材料补充了适用范围。' }))
  report = await value(path, json('PATCH', { revision: report.revision, sources: [{ type: 'note', id: note.id, revision: note.revision }, { type: 'comparison', id: app.comparison.id, retain: true }] }))
  report = await value(`${path}/assemble`, json('POST', { revision: report.revision }))
  assert.equal(report.blocks.length, 5)
  assert.deepEqual(report.blocks.slice(0, 4).map(block => block.id), originalIds)
  assert.equal(report.blocks[0].text, '保留已经人工改写的结论')
  assert.match(report.blocks[4].text, /新材料补充了适用范围/)

  let comparison = await value(`/api/comparisons/${app.comparison.id}/cells/${app.first.id}/${app.comparison.columns[0].id}`, json('PATCH', { revision: app.comparison.revision, value: '这一行的研究条件已修订' }))
  comparison = await value(`/api/comparisons/${comparison.id}/analyses/${comparison.columns[0].id}`, json('PATCH', { revision: comparison.revision, documentIds: [app.first.id, app.second.id], relation: 'difference', value: '不同样本和测量条件下的发现需要分别解释。', conditions: '不能直接合并数值。' }))
  report = await value(path, json('PATCH', { revision: report.revision, sources: [{ type: 'note', id: note.id, retain: true }, { type: 'comparison', id: comparison.id, revision: comparison.revision }] }))
  report = await value(`${path}/assemble`, json('POST', { revision: report.revision }))
  assert.equal(report.blocks.length, 6)
  assert.match(report.blocks[5].text, /这一行的研究条件已修订/)
  const removed = report.blocks[4]
  report = await value(path, json('PATCH', { revision: report.revision, blocks: editable(report).filter(block => block.id !== removed.id) }))
  report = await value(`${path}/assemble`, json('POST', { revision: report.revision }))
  assert.equal(report.blocks.length, 6)
  assert.equal(report.blocks.at(-1).text, removed.text)
  assert.notEqual(report.blocks.at(-1).id, removed.id)
  await app.restart()
  assert.equal((await value(`${path}/assemble`, json('POST', { revision: report.revision }))).revision, report.revision)
})

test('M4 assembly recognizes pre-key material blocks from history after manual revision', async t => {
  const app = await reportFixture(); t.after(() => app.close())
  let report = await create(app, [app.selectors[0]]), path = `/api/reports/${report.id}`
  report = await app.value(`${path}/assemble`, json('POST', { revision: report.revision }))
  const changed = editable(report); changed[0].text = '旧版成果里已修改的结论'
  report = await app.value(path, json('PATCH', { revision: report.revision, blocks: changed }))
  const file = join(app.dataDir, 'reports', `${report.id}.json`)
  const legacy = JSON.parse(await readFile(file, 'utf8'))
  for (const version of [legacy, ...legacy.history]) for (const block of version.blocks) {
    delete block.origin.itemKey
    if (block.text === `${app.first.title} · ${app.original}`) block.text = app.original
  }
  await writeFile(file, JSON.stringify(legacy)); await app.restart()
  let repeated = await app.value(`${path}/assemble`, json('POST', { revision: report.revision }))
  assert.equal(repeated.revision, report.revision)
  assert.deepEqual(editable(repeated), changed)
  const note = await app.value(`/api/notes/${app.note.id}`, json('PATCH', { revision: app.note.revision, content: '旧成果使用的新笔记版本' }))
  report = await app.value(path, json('PATCH', { revision: repeated.revision, sources: [{ type: 'note', id: note.id, revision: note.revision }] }))
  report = await app.value(`${path}/assemble`, json('POST', { revision: report.revision }))
  assert.equal(report.blocks.length, 2)
  assert.equal(report.blocks[0].text, changed[0].text)
  assert.match(report.blocks[1].text, /旧成果使用的新笔记版本/)
  repeated = await app.value(`${path}/assemble`, json('POST', { revision: report.revision }))
  assert.equal(repeated.revision, report.revision)
})

test('M4 assembly explicitly preserves model provenance from comparison materials', async t => {
  const qaOptions = { config: { url: 'https://fixture.invalid', key: 'test-only', model: 'fixture' }, fetchImpl: async (_url, options) => {
    const input = JSON.parse(JSON.parse(options.body).messages[1].content)
    const cells = input.documents.map(doc => ({ documentId: doc.id, value: '基于所选原文的解释', status: 'recorded', kind: 'inference', conditions: '限于当前材料', comparability: 'unchecked', reason: '', referenceIds: input.evidence.filter(item => item.documentId === doc.id).slice(0, 1).map(item => item.id) }))
    const result = { cells, analysis: { relation: 'difference', value: '两份材料的条件需要分别解释', conditions: '不合并研究数值', referenceIds: cells.flatMap(cell => cell.referenceIds) } }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }))
  } }
  const app = await reportFixture(qaOptions); t.after(() => app.close())
  let comparison = app.comparison
  const run = await app.value(`/api/comparisons/${comparison.id}/suggestions`, json('POST', { revision: comparison.revision, columnId: comparison.columns[0].id }), 202)
  assert.equal((await waitReportRun(app, run.id)).status, 'completed')
  comparison = await app.value(`/api/comparisons/${comparison.id}/adopt`, json('POST', { revision: comparison.revision, runId: run.id }))
  let report = await create(app, [{ type: 'comparison', id: comparison.id, revision: comparison.revision }]), path = `/api/reports/${report.id}`
  report = await app.value(`${path}/assemble`, json('POST', { revision: report.revision }))
  assert.ok(report.blocks.every(block => block.kind === 'inference' && block.origin.type === 'material' && block.origin.generatedKind === 'inference' && block.reviewState === 'pending'))
  const changed = editable(report); changed[0].text = '人工核对后的模型归纳'
  report = await app.value(path, json('PATCH', { revision: report.revision, blocks: changed }))
  assert.equal((await app.value(`${path}/assemble`, json('POST', { revision: report.revision }))).revision, report.revision)
})
