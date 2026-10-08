import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { testApp, json, upload } from './helpers/test-app.mjs'

async function setup(t, options) {
  const app = await testApp(options)
  t.after(() => app.close())
  const value = async (path, options, expected = 200) => {
    const response = await app.request(path, options)
    assert.equal(response.status, expected, await response.clone().text())
    return response.json()
  }
  const topic = await value('/api/topics', json('POST', { title: '阅读笔记', question: '研究材料和方法是什么？' }), 201)
  await value(`/api/topics/${topic.id}/documents/${app.legacy.id}`, { method: 'PUT' })
  const path = `/api/topics/${topic.id}/documents/${app.legacy.id}`
  const document = await value(`/api/documents/${app.legacy.id}`)
  return { ...app, value, topic, path, document }
}
async function waitRun(value, id) {
  for (let i = 0; i < 150; i++) {
    const run = await value(`/api/runs/${id}`)
    if (!['queued', 'running'].includes(run.status)) return run
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Run did not finish')
}

test('M2 notes: source snapshots, revisions, explicit missing states, idempotency and restart', async t => {
  const { value, path, document, restart, topic, legacy } = await setup(t)
  const input = { id: randomUUID(), field: '材料或对象', origin: { type: 'reference' }, referenceIds: ['ref_00001'], documentVersion: document.evidenceVersion }
  let note = await value(`${path}/notes`, json('POST', input), 201)
  assert.equal(note.kind, 'source'); assert.equal(note.reviewState, 'pending')
  assert.equal(note.evidence[0].documentId, legacy.id)
  assert.equal(note.evidence[0].reference.text, document.references[0].text)
  assert.equal(note.evidence[0].matchesCurrent, true)
  const duplicate = await Promise.all([value(`${path}/notes`, json('POST', input), 201), value(`${path}/notes`, json('POST', input), 201)])
  assert.equal(duplicate[0].id, duplicate[1].id)
  assert.equal((await value(`${path}/notes`, json('POST', Object.fromEntries(Object.entries({ ...input, id: input.id.toUpperCase() }).reverse())), 201)).id, note.id)
  assert.equal((await value(`${path}/notes`)).notes.length, 1)
  note = await value(`/api/notes/${note.id}`, json('PATCH', { revision: note.revision, reviewState: 'checked' }))
  note = await value(`/api/notes/${note.id}`, json('PATCH', { revision: note.revision, content: '人工纠正：仅比较两组材料，未报告样本量。', field: '样本构成' }))
  assert.equal(note.reviewState, 'pending'); assert.equal(note.editedByUser, true)
  assert.equal(note.history.length, 2)
  await value(`/api/notes/${note.id}`, json('PATCH', { revision: 1, content: '过期修改' }), 409)
  await restart()
  const saved = await value(`/api/notes/${note.id}`)
  assert.equal(saved.content, note.content); assert.equal(saved.field, '样本构成')
  const empty = await value(`${path}/notes`, json('POST', { field: '样本数量', status: 'not_reported', content: '', kind: 'user' }), 201)
  assert.equal(empty.content, ''); assert.equal(empty.status, 'not_reported')
  const restored = await value(`/api/notes/${note.id}`, json('PATCH', { revision: note.revision, restoreRevision: 1 }))
  assert.equal(restored.content, document.references[0].text)
  assert.equal(restored.revision, note.revision + 1)
  let archived = await value(`/api/notes/${note.id}`, json('PATCH', { revision: restored.revision, archived: true }))
  assert.equal(archived.archived, true)
  archived = await value(`/api/notes/${note.id}`, json('PATCH', { revision: archived.revision, archived: false }))
  assert.equal(archived.archived, false)
  await value(`${path}/notes`, json('POST', { ...input, content: '不能用相同请求 ID 创建不同笔记' }), 409)
  await value(`/api/topics/${topic.id}/documents/${legacy.id}`, { method: 'DELETE' })
  assert.equal((await value(`${path}/notes`)).linked, false)
  assert.equal((await value(`/api/topics/${topic.id}/notes`)).notes.length, 2)
  await value(`${path}/notes`, json('POST', { field: '新笔记', content: '未关联不能新建' }), 409)
  const retained = await value(`/api/notes/${note.id}`, json('PATCH', { revision: archived.revision, content: '移出后仍可修订既有笔记' }))
  assert.equal(retained.content, '移出后仍可修订既有笔记')
})

test('M2 evidence remains stable across metadata edits, parse changes and reimports', async t => {
  const { value, path, document, dataDir, legacy } = await setup(t)
  let note = await value(`${path}/notes`, json('POST', { origin: { type: 'reference' }, referenceIds: ['ref_00001'], documentVersion: document.evidenceVersion }), 201)
  await value(`/api/documents/${legacy.id}`, json('PATCH', { title: '更正后的标题', authors: '研究者' }))
  assert.equal((await value(`/api/notes/${note.id}`)).evidence[0].matchesCurrent, true)
  const file = join(dataDir, 'documents', `${legacy.id}.json`)
  const changed = JSON.parse(await readFile(file, 'utf8'))
  changed.references[0].text = '重新解析后 ID 相同而内容已改变。'
  await writeFile(file, JSON.stringify(changed))
  const stale = await value(`/api/notes/${note.id}`)
  assert.equal(stale.evidence[0].matchesCurrent, false)
  assert.equal(stale.evidence[0].reference.text, document.references[0].text)
  await value(`/api/notes/${note.id}`, json('PATCH', { revision: note.revision, reviewState: 'checked' }), 409)
  await value(`${path}/notes`, json('POST', { origin: { type: 'reference' }, referenceIds: ['ref_00001'], documentVersion: document.evidenceVersion }), 409)
  const reparsed = await value(`/api/documents/${legacy.id}`)
  note = await value(`/api/notes/${note.id}`, json('PATCH', { revision: note.revision, referenceIds: ['ref_00001'], documentVersion: reparsed.evidenceVersion }))
  assert.equal(note.evidence[0].reference.text, changed.references[0].text)
  assert.equal(note.history[0].evidence[0].reference.text, document.references[0].text)
  const reimported = await value('/api/documents', upload('相同文件名的新文献。', legacy.fileName), 201)
  assert.notEqual(reimported.id, legacy.id)
  assert.equal((await value(`/api/notes/${note.id}`)).documentId, legacy.id)
})

test('M2 rejects forged evidence, false model provenance, invalid states and conflicting edits', async t => {
  const { value, path, document, topic, legacy } = await setup(t)
  for (const body of [
    { field: '', content: '' }, { content: '无来源', kind: 'source' },
    { content: '伪造模型', kind: 'inference' }, { content: 'x', status: 'invented' },
    { content: 'x', evidence: [] }, { content: 'x', referenceIds: ['missing'], documentVersion: document.evidenceVersion },
    { content: 'x', origin: { type: 'reference', reference: 'forged' } },
  ]) await value(`${path}/notes`, json('POST', body), 422)
  await value(`${path}/notes`, json('POST', { id: [randomUUID()], content: '无效 ID 类型' }), 400)
  await value(`${path}/notes`, json('POST', { origin: { type: 'answer', runId: [randomUUID()], claimIndex: 0 } }), 400)
  const note = await value(`${path}/notes`, json('POST', { content: '用户自己的想法', kind: 'user', field: '待验证问题' }), 201)
  const replies = await Promise.all([
    value(`/api/notes/${note.id}`, json('PATCH', { revision: 1, content: '第一处修改' })),
    value(`/api/notes/${note.id}`, json('PATCH', { revision: 1, field: '第二处修改' }), 409),
  ])
  assert.equal(replies[0].revision, 2)
  const other = await value('/api/topics', json('POST', { title: '另一个主题', question: '另一组问题？' }), 201)
  await value(`/api/topics/${other.id}/documents/${legacy.id}`, { method: 'PUT' })
  assert.equal((await value(`/api/topics/${other.id}/documents/${legacy.id}/notes`)).notes.length, 0)
  await value(`/api/topics/${other.id}/documents/${legacy.id}/notes`, json('POST', { field: '待验证问题', content: '同一文献在另一主题中的独立笔记' }), 201)
  assert.equal((await value(`/api/topics/${other.id}/notes`)).notes[0].content, '同一文献在另一主题中的独立笔记')
  assert.equal((await value(`/api/topics/${topic.id}/notes`)).notes.length, 1)
  assert.equal((await value(`/api/topics/${topic.id}/notes`)).notes[0].content, '第一处修改')
})

test('M2 model suggestions retain provenance and never overwrite accepted human edits', async t => {
  let calls = 0
  const qaOptions = { config: { url: 'https://model.invalid/chat', key: 'test-only', model: 'fixture' }, fetchImpl: async (_url, options) => {
    calls++
    const request = JSON.parse(options.body), evidence = JSON.parse(request.messages[1].content).initialEvidence
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ claims: [{ kind: 'inference', text: `模型建议 ${calls}：条件差异值得进一步核对。`, referenceIds: [evidence[0].id] }], limitations: '只依据当前资料。' }) } }] }))
  } }
  const { value, path, legacy, topic, dataDir, restart } = await setup(t, { qaOptions })
  const task = await value(`${path}/note-suggestions`, json('POST', { field: '材料或对象' }), 202)
  const run = await waitRun(value, task.id)
  assert.equal(run.status, 'completed'); assert.equal(run.result.mode, 'model')
  let note = await value(`${path}/notes`, json('POST', { field: '材料或对象', origin: { type: 'answer', runId: task.id, claimIndex: 0 } }), 201)
  assert.equal(note.kind, 'inference'); assert.equal(note.evidence[0].matchesCurrent, true)
  note = await value(`/api/notes/${note.id}`, json('PATCH', { revision: note.revision, content: '人工修正，保留明确的研究条件。' }))
  const second = await value(`${path}/note-suggestions`, json('POST', { field: '材料或对象' }), 202)
  assert.equal((await waitRun(value, second.id)).status, 'completed')
  assert.equal((await value(`${path}/notes`)).notes.length, 1)
  assert.equal((await value(`/api/notes/${note.id}`)).content, '人工修正，保留明确的研究条件。')
  assert.equal((await value(`/api/documents/${legacy.id}`)).questions.length, 0)
  await value(`${path}/notes`, json('POST', { origin: { type: 'answer', runId: task.id, claimIndex: 99 } }), 422)
  const pendingId = randomUUID()
  await writeFile(join(dataDir, 'runs', `${pendingId}.json`), JSON.stringify({ id: pendingId, purpose: 'note-suggestion', topicId: topic.id, documentId: legacy.id, field: '方法', status: 'running', events: [], createdAt: new Date().toISOString() }))
  await restart()
  assert.equal((await value(`${path}/notes`)).suggestions.find(run => run.id === pendingId).status, 'interrupted')
  assert.equal(calls, 2)
})

test('M2 suggestions require a model; ordinary extractive answers can still become source notes', async t => {
  const { value, path, legacy } = await setup(t)
  await value(`${path}/note-suggestions`, json('POST', { field: '方法' }), 409)
  const task = await value(`/api/documents/${legacy.id}/questions`, json('POST', { question: '材料' }), 202)
  const run = await waitRun(value, task.id)
  const note = await value(`${path}/notes`, json('POST', { origin: { type: 'answer', runId: run.id, referenceId: run.result.references[0].id } }), 201)
  assert.equal(note.kind, 'source'); assert.equal(note.origin.type, 'answer')
  assert.equal(note.evidence[0].matchesCurrent, true)
})
