import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { testApp, json, upload } from './helpers/test-app.mjs'

async function setup(t, qaOptions) {
  const app = await testApp({ qaOptions })
  t.after(() => app.close())
  const value = async (path, options, expected = 200) => {
    const response = await app.request(path, options)
    assert.equal(response.status, expected, await response.clone().text())
    return response.json()
  }
  const topic = await value('/api/topics', json('POST', { title: '材料比较', question: '材料与条件有哪些差异？' }), 201)
  await value(`/api/topics/${topic.id}/documents/${app.legacy.id}`, { method: 'PUT' })
  const second = await value('/api/documents', upload('# 第二份研究\n\n材料来自不同来源，条件不同，不能直接合并数值。', 'second.md', topic.id), 201)
  const outside = await value('/api/documents', upload('范围外材料不能加入比较上下文。', 'outside.txt'), 201)
  const first = await value(`/api/documents/${app.legacy.id}`)
  const input = { id: randomUUID(), title: '材料证据表', documentIds: [first.id, second.id], columns: [{ id: randomUUID(), name: '材料', description: '比较研究对象和条件' }] }
  const table = await value(`/api/topics/${topic.id}/comparisons`, json('POST', input), 201)
  return { ...app, value, topic, first, second: await value(`/api/documents/${second.id}`), outside, input, table, col: table.columns[0].id, path: `/api/comparisons/${table.id}` }
}
async function waitRun(value, id) {
  for (let i = 0; i < 200; i++) {
    const run = await value(`/api/runs/${id}`)
    if (!['queued', 'running'].includes(run.status)) return run
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Comparison task did not finish')
}
export function comparisonReply(input) {
  return { cells: input.documents.map(doc => {
    const refs = input.evidence.filter(item => item.documentId === doc.id)
    return { documentId: doc.id, value: refs.length ? `根据${doc.title}记录的材料` : '', status: refs.length ? 'recorded' : 'not_found', kind: 'source', conditions: '仅限输入材料中的研究设置', comparability: refs.length ? 'conditional' : 'unchecked', reason: refs.length ? '研究设置不同，需要核对' : '', referenceIds: refs.slice(0, 1).map(item => item.id) }
  }), analysis: { relation: 'difference', value: '当前所选文献描述了不同条件下的材料。', conditions: '不能直接合并不同设置的指标。', referenceIds: input.documents.flatMap(doc => input.evidence.filter(item => item.documentId === doc.id).slice(0, 1).map(item => item.id)) } }
}

test('M3 manual matrix retains note and passage evidence, differences, versions and restart state', async t => {
  const { value, topic, first, second, input, table, col, path, restart } = await setup(t)
  assert.equal((await value(`/api/topics/${topic.id}/comparisons`)).comparisons.length, 1)
  await value(`/api/topics/${topic.id}/comparisons`, json('POST', input), 201)
  assert.equal((await value(path)).cells.length, 2)
  const note = await value(`/api/topics/${topic.id}/documents/${first.id}/notes`, json('POST', { field: '材料', origin: { type: 'reference' }, referenceIds: [first.references[0].id], documentVersion: first.evidenceVersion }), 201)
  let current = await value(`${path}/cells/${first.id}/${col}`, json('PATCH', { revision: 1, source: { type: 'note', noteId: note.id, revision: 1 }, conditions: '两组材料', comparability: 'conditional', reason: '缺少统一测量条件' }))
  assert.equal(current.cells[0].noteSources[0].revision, 1)
  current = await value(`${path}/cells/${second.id}/${col}`, json('PATCH', { revision: current.revision, value: '另一来源的材料', status: 'recorded', kind: 'source', source: { type: 'passages', referenceIds: [second.references[0].id], documentVersion: second.evidenceVersion }, comparability: 'not_comparable', reason: '研究条件不同' }))
  assert.equal(current.cells[1].evidence[0].documentId, second.id)
  current = await value(`${path}/analyses/${col}`, json('PATCH', { revision: current.revision, value: '两篇研究的条件不一致，暂不直接比较结果。', relation: 'difference', conditions: '需要补齐材料来源', documentIds: [first.id, second.id] }))
  assert.equal(current.analyses[0].outdated, false)
  const oldRevision = current.revision
  await value(`/api/notes/${note.id}`, json('PATCH', { revision: 1, content: '修订后的笔记，比较表保持原快照' }))
  current = await value(path)
  assert.equal(current.cells[0].noteChanged, true)
  assert.equal(current.analyses[0].outdated, true)
  assert.equal(current.cells[0].value, first.references[0].text)
  await value(`${path}/cells/${first.id}/${col}`, json('PATCH', { revision: current.revision, source: { type: 'note', noteId: note.id, revision: 1 } }), 409)
  current = await value(`${path}/cells/${first.id}/${col}`, json('PATCH', { revision: current.revision, value: '人工修订的比较值' }))
  assert.equal(current.analyses[0].outdated, true)
  await value(path, json('PATCH', { revision: 1, title: '过期编辑' }), 409)
  await restart()
  assert.equal((await value(path)).cells[0].value, '人工修订的比较值')
  current = await value(path, json('PATCH', { revision: current.revision, restoreRevision: oldRevision }))
  assert.equal(current.cells[0].value, first.references[0].text)
  assert.ok((await value(`${path}/history`)).history.length >= 4)
  current = await value(path, json('PATCH', { revision: current.revision, columns: [{ id: col, name: '材料来源', description: '重新定义的维度' }] }))
  assert.equal(current.analyses[0].outdated, true)
  current = await value(path, json('PATCH', { revision: current.revision, archived: true }))
  assert.equal(current.archived, true)
  await value(`/api/topics/${topic.id}/documents/${second.id}`, { method: 'DELETE' })
  current = await value(path)
  assert.equal(current.documents[1].linked, false)
  assert.equal(current.cells[1].evidence[0].documentId, second.id)
})

test('M3 rejects scope violations, fabricated sources and invalid comparability', async t => {
  const { value, topic, first, second, outside, input, path, col } = await setup(t)
  await value(`/api/topics/${topic.id}/comparisons`, json('POST', { ...input, id: randomUUID(), documentIds: [first.id, outside.id] }), 409)
  await value(path, json('PATCH', { revision: 1, documentIds: [first.id, outside.id] }), 409)
  await value(`${path}/cells/${outside.id}/${col}`, json('PATCH', { revision: 1, value: '范围外' }), 422)
  await value(`${path}/cells/${first.id}/${col}`, json('PATCH', { revision: 1, value: '无来源结论', kind: 'source', status: 'recorded' }), 422)
  await value(`${path}/cells/${first.id}/${col}`, json('PATCH', { revision: 1, value: '缺少理由', comparability: 'not_comparable' }), 422)
  await value(`${path}/cells/${first.id}/${col}`, json('PATCH', { revision: 1, source: { type: 'passages', referenceIds: [second.references[0].id], documentVersion: second.evidenceVersion } }), 409)
  const other = await value('/api/topics', json('POST', { title: '另一主题', question: '不同研究问题' }), 201)
  await value(`/api/topics/${other.id}/documents/${first.id}`, { method: 'PUT' })
  const otherNote = await value(`/api/topics/${other.id}/documents/${first.id}/notes`, json('POST', { content: '其他主题的想法' }), 201)
  await value(`${path}/cells/${first.id}/${col}`, json('PATCH', { revision: 1, source: { type: 'note', noteId: otherNote.id, revision: 1 } }), 422)
  const current = await value(`${path}/cells/${first.id}/${col}`, json('PATCH', { revision: 1, status: 'not_found', value: '', kind: 'user' }))
  assert.equal(current.cells[0].status, 'not_found')
  await value(`${path}/suggestions`, json('POST', { revision: current.revision, columnId: col }), 409)
})

test('M3 model uses only selected evidence and adoption cannot overwrite intervening edits', async t => {
  const inputs = []
  let mode = 'valid'
  const qaOptions = { config: { url: 'https://model.invalid/comparison', key: 'test-only', model: 'fixture' }, fetchImpl: async (_url, options) => {
    const input = JSON.parse(JSON.parse(options.body).messages[1].content); inputs.push(input)
    const result = comparisonReply(input)
    if (mode === 'foreign-row') result.cells[0].referenceIds = result.cells[1].referenceIds
    if (mode === 'unknown-ref') result.cells[0].referenceIds = ['invented']
    if (mode === 'missing-value') { result.cells[0].status = 'not_found'; result.cells[0].value = '凭空填入 88%' }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }))
  } }
  const { value, first, second, outside, path, col, topic } = await setup(t, qaOptions)
  const note = await value(`/api/topics/${topic.id}/documents/${first.id}/notes`, json('POST', { field: '材料', content: '用于比较的笔记线索' }), 201)
  const task = await value(`${path}/suggestions`, json('POST', { revision: 1, columnId: col }), 202)
  assert.equal((await waitRun(value, task.id)).status, 'completed')
  assert.deepEqual(inputs[0].documents.map(doc => doc.id), [first.id, second.id])
  assert.ok(inputs[0].evidence.every(item => item.documentId !== outside.id))
  assert.equal((await value(path)).revision, 1)
  let current = await value(`${path}/cells/${first.id}/${col}`, json('PATCH', { revision: 1, status: 'recorded', value: '任务启动后的人工修订' }))
  await value(`${path}/adopt`, json('POST', { revision: current.revision, runId: task.id }), 409)
  assert.equal((await value(path)).cells[0].value, '任务启动后的人工修订')
  const fresh = await value(`${path}/suggestions`, json('POST', { revision: current.revision, columnId: col }), 202)
  assert.equal((await waitRun(value, fresh.id)).status, 'completed')
  current = await value(`${path}/adopt`, json('POST', { revision: current.revision, runId: fresh.id }))
  assert.equal(current.analyses[0].outdated, false)
  assert.equal(new Set(current.analyses[0].evidence.map(item => item.documentId)).size, 2)
  assert.equal(current.cells[0].origin.runId, fresh.id)
  const beforeNoteEdit = await value(`${path}/suggestions`, json('POST', { revision: current.revision, columnId: col }), 202)
  assert.equal((await waitRun(value, beforeNoteEdit.id)).status, 'completed')
  await value(`/api/notes/${note.id}`, json('PATCH', { revision: 1, content: '任务完成后更新的笔记线索' }))
  await value(`${path}/adopt`, json('POST', { revision: current.revision, runId: beforeNoteEdit.id }), 409)
  const before = current.cells
  for (mode of ['foreign-row', 'unknown-ref', 'missing-value']) {
    const invalid = await value(`${path}/suggestions`, json('POST', { revision: current.revision, columnId: col }), 202)
    assert.equal((await waitRun(value, invalid.id)).status, 'failed')
    await value(`${path}/adopt`, json('POST', { revision: current.revision, runId: invalid.id }), 422)
    assert.deepEqual((await value(path)).cells, before)
  }
})

test('M3 cancellation, restart interruption and changed source block unsafe adoption', async t => {
  let hang = false
  const qaOptions = { config: { url: 'https://model.invalid/comparison', key: 'test-only', model: 'fixture' }, fetchImpl: async (_url, options) => {
    if (hang) return new Promise((resolve, reject) => { if (options.signal.aborted) reject(options.signal.reason); else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }) })
    const input = JSON.parse(JSON.parse(options.body).messages[1].content)
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(comparisonReply(input)) } }] }))
  } }
  const { value, first, topic, dataDir, path, table, col, restart } = await setup(t, qaOptions)
  const task = await value(`${path}/suggestions`, json('POST', { revision: 1, columnId: col }), 202)
  assert.equal((await waitRun(value, task.id)).status, 'completed')
  const file = join(dataDir, 'documents', `${first.id}.json`), document = JSON.parse(await readFile(file, 'utf8'))
  document.references[0].text = '重新解析后的不同材料内容。'
  await writeFile(file, JSON.stringify(document))
  await value(`${path}/adopt`, json('POST', { revision: 1, runId: task.id }), 409)
  hang = true
  const active = await value(`${path}/suggestions`, json('POST', { revision: 1, columnId: col }), 202)
  await value(`/api/runs/${active.id}/cancel`, { method: 'POST' })
  assert.equal((await waitRun(value, active.id)).status, 'cancelled')
  const id = randomUUID()
  await writeFile(join(dataDir, 'runs', `${id}.json`), JSON.stringify({ id, status: 'running', purpose: 'comparison-suggestion', comparisonId: table.id, topicId: topic.id, columnName: '材料', events: [], createdAt: new Date().toISOString() }))
  await restart()
  assert.equal((await value(path)).suggestions.find(run => run.id === id).status, 'interrupted')
})

test('M3 default dimensions give the model bounded English evidence from selected documents', async t => {
  const inputs = []
  const qaOptions = { config: { url: 'https://model.invalid/comparison', key: 'test-only', model: 'fixture' }, fetchImpl: async (_url, options) => {
    const input = JSON.parse(JSON.parse(options.body).messages[1].content); inputs.push(input)
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(comparisonReply(input)) } }] }))
  } }
  const app = await testApp({ qaOptions }); t.after(() => app.close())
  const value = async (path, options, status = 200) => {
    const response = await app.request(path, options); assert.equal(response.status, status); return response.json()
  }
  const topic = await value('/api/topics', json('POST', { title: '英文文献', question: '比较研究方法与结果。' }), 201)
  const documents = []
  for (const title of ['Study One', 'Study Two']) documents.push(await value('/api/documents', upload(`# ${title}\n\n## Methods\n\nWe randomized groups and measured changes after twelve weeks.\n\n## Participants\n\nAdults from one hospital were enrolled.\n\n## Results\n\nThe outcome score improved in the treatment arm.\n\n## Limitations\n\nLong term effects and other populations remain uncertain.`, `${title}.md`, topic.id), 201))
  const table = await value(`/api/topics/${topic.id}/comparisons`, json('POST', { title: '默认中文维度', documentIds: documents.map(doc => doc.id) }), 201)
  for (const col of table.columns) {
    const run = await value(`/api/comparisons/${table.id}/suggestions`, json('POST', { revision: 1, columnId: col.id }), 202)
    assert.equal((await waitRun(value, run.id)).status, 'completed')
    const input = inputs.at(-1)
    assert.deepEqual(input.documents.map(doc => doc.id), documents.map(doc => doc.id))
    assert.ok(input.evidence.every(item => item.documentId !== app.legacy.id))
    for (const doc of documents) {
      const evidence = input.evidence.filter(item => item.documentId === doc.id)
      assert.ok(evidence.length > 0 && evidence.length <= 6)
      assert.ok(evidence.reduce((sum, item) => sum + item.text.length, 0) <= 6000)
      assert.ok(evidence.every(item => doc.references.some(ref => ref.text === item.text)))
    }
  }
})

test('M3 historical evidence checks removed documents without expanding current comparison scope', async t => {
  const { value, topic, table, first, second, outside, path, col, dataDir } = await setup(t)
  await value(`/api/topics/${topic.id}/documents/${outside.id}`, { method: 'PUT' })
  let current = await value(path, json('PATCH', { revision: 1, documentIds: [first.id, second.id, outside.id] }))
  const original = await value(`/api/documents/${outside.id}`)
  current = await value(`${path}/cells/${outside.id}/${col}`, json('PATCH', { revision: current.revision, status: 'recorded', value: '旧范围中引用的原文', kind: 'source', source: { type: 'passages', referenceIds: [original.references[0].id], documentVersion: original.evidenceVersion } }))
  const historicalRevision = current.revision
  current = await value(path, json('PATCH', { revision: current.revision, documentIds: [first.id, second.id] }))
  let history = (await value(`${path}/history`)).history.find(version => version.revision === historicalRevision)
  assert.equal(history.cells[0].evidence[0].matchesCurrent, true)
  assert.deepEqual((await value(path)).documentIds, [first.id, second.id])
  await value(`${path}/sources/${outside.id}`, undefined, 422)
  const raw = JSON.parse(await readFile(join(dataDir, 'comparisons', `${table.id}.json`), 'utf8'))
  assert.equal(raw.history.find(version => version.revision === historicalRevision).cells[0].evidence[0].matchesCurrent, undefined)
  const file = join(dataDir, 'documents', `${outside.id}.json`)
  const changed = JSON.parse(await readFile(file, 'utf8')); changed.references[0].text = '解析后不同的原文'
  await writeFile(file, JSON.stringify(changed))
  history = (await value(`${path}/history`)).history.find(version => version.revision === historicalRevision)
  assert.equal(history.cells[0].evidence[0].matchesCurrent, false)
  assert.equal(history.cells[0].evidence[0].reference.text, original.references[0].text)
})
