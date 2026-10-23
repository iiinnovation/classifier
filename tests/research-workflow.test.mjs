import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { researchFixture, researchReply, waitResearch } from './helpers/research-fixture.mjs'
import { json } from './helpers/test-app.mjs'
import { planComparison } from '../apps/api/src/comparison-model.mjs'

async function setup(t, options) {
  const app = await researchFixture(options); t.after(() => app.close())
  const table = await app.value('/api/topics/' + app.topic.id + '/comparisons', json('POST', { title: 'AI 比较', question: app.topic.question, documentIds: [app.legacy.id, app.second.id] }), 201)
  return { ...app, table, path: '/api/comparisons/' + table.id }
}
async function start(app, revision = app.table.revision, instruction = app.topic.question, requestId = randomUUID()) {
  return app.value(app.path + '/draft', json('POST', { revision, instruction, requestId }), 202)
}

test('research task generates cited comparison and summary without manually populated notes or cells', async t => {
  const app = await setup(t), requestId = randomUUID()
  const tasks = await Promise.all([start(app, 1, app.topic.question, requestId), start(app, 1, app.topic.question, requestId)])
  assert.equal(tasks[0].id, tasks[1].id)
  const run = await waitResearch(app, tasks[0].id)
  assert.equal(run.status, 'completed', run.error)
  assert.equal(run.result.cells.length, 4)
  assert.equal(app.inputs.length, 3)
  assert.ok(app.inputs.every(input => !JSON.stringify(input).includes(app.outside.id)))
  assert.ok((await app.value(app.path)).cells.every(cell => cell.status === 'unfilled'))
  assert.equal((await start(app, 1, app.topic.question, requestId)).id, run.id)
  const adopted = await app.value(app.path + '/adopt-draft', json('POST', { revision: 1, runId: run.id }))
  assert.equal(adopted.revision, 2)
  assert.equal(adopted.columns.length, 2)
  assert.ok(adopted.cells.every(cell => cell.evidence.length && cell.reviewState === 'pending'))
  assert.ok(adopted.analyses.every(analysis => !analysis.outdated))
  assert.equal((await app.value(app.path + '/adopt-draft', json('POST', { revision: 1, runId: run.id }))).revision, 2)
  const reports = await Promise.all([1, 2].map(() => app.value(app.path + '/report', json('POST', { revision: 2 }), 201)))
  const report = reports[0]
  assert.equal(reports[1].id, report.id)
  assert.equal(report.sources[0].id, adopted.id)
  assert.equal(report.blocks.length, 0)
  assert.equal((await app.value(app.path + '/report', json('POST', { revision: 2 }), 201)).id, report.id)
  const reportRequest = { revision: 1, requestId: randomUUID() }
  const suggestions = await Promise.all([1, 2].map(() => app.value('/api/reports/' + report.id + '/suggestions', json('POST', reportRequest), 202)))
  const generated = suggestions[0]
  assert.equal(suggestions[1].id, generated.id)
  const summary = await waitResearch(app, generated.id)
  assert.equal(summary.status, 'completed', summary.error)
  assert.equal((await app.value('/api/reports/' + report.id + '/suggestions', json('POST', reportRequest), 202)).id, summary.id)
  assert.equal(app.inputs.length, 4)
  const saved = await app.value('/api/reports/' + report.id + '/adopt', json('POST', { revision: 1, runId: summary.id }))
  assert.equal(saved.blocks.length, 2)
  assert.ok(saved.blocks[0].citationIds.length)
  await app.restart()
  assert.equal((await app.value('/api/reports/' + report.id)).blocks.length, 2)
  const response = await app.request('/api/reports/' + report.id + '/export?revision=2')
  assert.match(await response.text(), /所选研究的方法与条件不同/)
  assert.equal((await app.value(app.path + '/history')).history.length, 1)
})

test('research adoption rejects manual edits and source changes', async t => {
  const app = await setup(t)
  let run = await waitResearch(app, (await start(app)).id)
  await app.value(app.path, json('PATCH', { revision: 1, title: '人工修改的标题' }))
  await app.value(app.path + '/adopt-draft', json('POST', { revision: 2, runId: run.id }), 409)
  run = await waitResearch(app, (await start(app, 2)).id)
  await app.changeDocument(app.legacy.id, doc => { doc.references[0].text = '已经发生变化的原文' })
  await app.value(app.path + '/adopt-draft', json('POST', { revision: 2, runId: run.id }), 409)
  assert.ok((await app.value(app.path)).cells.every(cell => cell.status === 'unfilled'))
})

test('research rejects malformed plans and fabricated citations without partially updating the table', async t => {
  let mode = 'plan'
  const app = await setup(t, { respond: async input => {
    if (mode === 'plan' && input.existingColumns) return { columns: Array.from({ length: 7 }, (_, i) => ({ name: '维度' + i })) }
    const result = researchReply(input)
    if (mode === 'citation' && input.column) result.cells[0].referenceIds = [app.outside.id + ':ref_00001']
    return result
  } })
  let run = await waitResearch(app, (await start(app)).id)
  assert.equal(run.status, 'failed'); assert.match(run.error, /1–6/)
  mode = 'citation'
  run = await waitResearch(app, (await start(app)).id)
  assert.equal(run.status, 'failed'); assert.match(run.error, /未读取的证据/)
  assert.equal((await app.value(app.path)).revision, 1)
  await app.value(app.path + '/report', json('POST', { revision: 1 }), 422)
})

test('research cancellation and shutdown leave a retryable task and preserve existing content', async t => {
  let hang = true
  const app = await setup(t, { respond: (input, options) => hang ? new Promise((resolve, reject) => { if (options.signal.aborted) reject(options.signal.reason); else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }) }) : researchReply(input) })
  let run = await start(app)
  await app.value(app.path + '/draft', json('POST', { revision: 1, instruction: '另一项研究要求', requestId: randomUUID() }), 409)
  await app.value('/api/runs/' + run.id + '/cancel', { method: 'POST' })
  assert.equal((await waitResearch(app, run.id)).status, 'cancelled')
  run = await start(app)
  await app.restart()
  assert.equal((await app.value('/api/runs/' + run.id)).status, 'cancelled')
  hang = false
  run = await waitResearch(app, (await start(app)).id)
  assert.equal(run.status, 'completed', run.error)
  assert.equal((await app.value(app.path)).revision, 1)
})

test('research follow-up reuses selected materials and guards approved output against stale proposals', async t => {
  const app = await setup(t)
  let run = await waitResearch(app, (await start(app)).id)
  const first = await app.value(app.path + '/adopt-draft', json('POST', { revision: 1, runId: run.id }))
  run = await waitResearch(app, (await start(app, first.revision, '增加样本量，继续比较方法')).id)
  assert.ok(run.result.columns.some(col => col.name === '样本量'))
  assert.deepEqual(app.inputs.findLast(input => input.existingColumns).documents.map(doc => doc.id), first.documentIds)
  const updated = await app.value(app.path + '/adopt-draft', json('POST', { revision: first.revision, runId: run.id }))
  assert.equal(updated.revision, 3)
  assert.equal((await app.value(app.path + '/history')).history.length, 2)
  await app.value('/api/topics/' + app.topic.id + '/documents/' + app.second.id, { method: 'DELETE' })
  await app.value(app.path + '/draft', json('POST', { revision: 3, requestId: randomUUID() }), 409)
})

test('research without model rejects generation without sending material', async t => {
  const app = await setup(t, { configured: false })
  await app.value(app.path + '/draft', json('POST', { revision: 1, requestId: randomUUID() }), 409)
  assert.equal(app.inputs.length, 0)
  assert.equal((await app.value(app.path)).revision, 1)
})

test('research invalidates changed sources even when retrieval found no evidence', async t => {
  const app = await setup(t, { respond: input => input.existingColumns ? { columns: [{ name: 'zirconiumhafniumratio', description: 'hafniumisotopes' }] } : researchReply(input) })
  const run = await waitResearch(app, (await start(app)).id)
  assert.equal(run.status, 'completed', run.error)
  assert.ok(run.result.cells.every(cell => cell.status === 'not_found' && !cell.evidence.length))
  assert.equal((await app.value(app.path)).suggestions[0].stale, false)
  await app.changeDocument(app.second.id, doc => { doc.references[0].text += ' 原文修订。' })
  assert.equal((await app.value(app.path)).suggestions[0].stale, true)
  await app.value(app.path + '/adopt-draft', json('POST', { revision: 1, runId: run.id }), 409)
})

test('dimension planning accepts fenced JSON without accepting surrounding commentary', async () => {
  const plan = { columns: [{ name: '方法', description: 'methods' }] }
  const options = content => ({ config: { url: 'https://fixture.invalid', model: 'fixture', key: 'fixture' }, onEvent: async () => {}, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content } }] })) })
  assert.deepEqual(await planComparison({}, options('```json\n' + JSON.stringify(plan) + '\n```')), plan)
  await assert.rejects(planComparison({}, options('说明文字：' + JSON.stringify(plan))), /有效的 JSON/)
})
