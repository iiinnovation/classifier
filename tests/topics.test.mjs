import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { testApp, json, upload, waitJob } from './helpers/test-app.mjs'

test('M1: topics, shared bibliography, independent screening, removal and restart preserve legacy evidence', async t => {
  const app = await testApp()
  t.after(() => app.close())
  const { request, legacy } = app
  async function value(path, options, status = 200) {
    const response = await request(path, options)
    assert.equal(response.status, status, await response.clone().text())
    return response.json()
  }
  assert.equal((await value('/api/documents')).documents[0].title, legacy.title)
  assert.deepEqual((await value(`/api/documents/${legacy.id}`)).references, legacy.references)
  const a = await value('/api/topics', json('POST', { title: '方法比较', question: '不同研究方法是否可比？', scope: '近五年实证研究' }), 201)
  const b = await value('/api/topics', json('POST', { title: '理论研究', question: '材料支持哪些论点？' }), 201)
  await value(`/api/topics/${a.id}`, json('PATCH', { title: '方法与条件比较', question: '条件差异如何影响结果？', scope: '实验与定量材料' }))
  const linkA = `/api/topics/${a.id}/documents/${legacy.id}`, linkB = `/api/topics/${b.id}/documents/${legacy.id}`
  await value(linkA, { method: 'PUT' }); await value(linkB, { method: 'PUT' })
  await value(linkA, json('PATCH', { selection: 'included', readingStatus: 'read', relevance: '提供比较条件', reason: '满足纳入范围' }))
  await value(linkB, json('PATCH', { selection: 'excluded', readingStatus: 'reading', relevance: '只涉及实验条件', reason: '不讨论理论论证' }))
  await value(linkA, { method: 'PUT' })
  const before = await value(`/api/documents/${legacy.id}`)
  await value(`/api/documents/${legacy.id}`, json('PATCH', { title: '材料比较研究', authors: '张三；李四', year: '2024', venue: '研究方法期刊', doi: 'https://doi.org/10.1234/example', url: 'https://example.org/paper' }))
  const updated = await value(`/api/documents/${legacy.id}`)
  assert.equal(updated.bibliography.doi, '10.1234/example')
  assert.deepEqual(updated.references, before.references)
  assert.deepEqual(updated.sections, before.sections)
  assert.equal(updated.schemaVersion, before.schemaVersion)
  assert.equal(await (await request(`/api/documents/${legacy.id}/original`)).text(), app.original)
  const run = await value(`/api/documents/${legacy.id}/questions`, json('POST', { question: '材料' }), 202)
  for (let i = 0; i < 100; i++) {
    const saved = await value(`/api/runs/${run.id}`)
    if (saved.status === 'completed') { assert.equal(saved.result.references[0].id, 'ref_00001'); break }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  await app.restart()
  const restoredA = await value(`/api/topics/${a.id}`), restoredB = await value(`/api/topics/${b.id}`)
  assert.equal(restoredA.title, '方法与条件比较')
  assert.equal(restoredA.question, '条件差异如何影响结果？')
  assert.equal(restoredA.scope, '实验与定量材料')
  assert.equal(restoredA.documents.length, 1)
  assert.equal(restoredA.documents[0].reason, '满足纳入范围')
  assert.equal(restoredA.documents[0].readingStatus, 'read')
  assert.equal(restoredA.documents[0].selection, 'included')
  assert.equal(restoredA.documents[0].relevance, '提供比较条件')
  assert.equal(restoredB.documents[0].selection, 'excluded')
  assert.equal(restoredB.documents[0].reason, '不讨论理论论证')
  assert.equal(restoredB.documents[0].readingStatus, 'reading')
  for (const topic of [restoredA, restoredB]) assert.equal(topic.documents[0].document.title, '材料比较研究')
  const list = (await value('/api/topics')).topics.find(topic => topic.id === a.id)
  assert.equal(list.documentCount, 1); assert.equal(list.includedCount, 1); assert.equal(list.readCount, 1)
  assert.equal((await value(`/api/documents/${legacy.id}`)).questions[0].status, 'completed')
  await value(linkA, { method: 'DELETE' })
  assert.equal((await value(`/api/topics/${a.id}`)).documents.length, 0)
  assert.equal((await value(`/api/topics/${b.id}`)).documents.length, 1)
  assert.equal((await value(`/api/documents/${legacy.id}`)).references[0].id, 'ref_00001')
})

test('M1: background and synchronous imports persist the designated topic without client follow-up', async t => {
  const app = await testApp()
  t.after(() => app.close())
  const { request } = app
  const topic = await (await request('/api/topics', json('POST', { title: '新材料', question: '材料的观点有哪些？' }))).json()
  const response = await request('/api/imports', upload('新文献包含的研究证据。', 'new.txt', topic.id.toUpperCase()))
  assert.equal(response.status, 202)
  const pending = await response.json()
  assert.equal(pending.topicId, topic.id)
  const job = await waitJob(request, pending.id)
  assert.equal(job.status, 'completed', job.error)
  const synchronous = await request('/api/documents', upload('同步上传研究。', 'sync.txt', topic.id))
  assert.equal(synchronous.status, 201)
  const doc = await synchronous.json()
  await app.restart()
  const restored = await (await request(`/api/topics/${topic.id}`)).json()
  assert.deepEqual(new Set(restored.documents.map(link => link.documentId)), new Set([job.documentId, doc.id]))
  assert.equal((await (await request(`/api/imports/${job.id}`)).json()).topicId, topic.id)
  const countBefore = (await (await request('/api/documents')).json()).documents.length
  for (const path of ['/api/imports', '/api/documents']) {
    assert.equal((await request(path, upload('不存在主题', 'bad.txt', randomUUID()))).status, 404)
    assert.equal((await request(path, upload('非法主题', 'bad.txt', '../bad'))).status, 400)
  }
  assert.equal((await (await request('/api/documents')).json()).documents.length, countBefore)
})

test('M1: reject invalid edits and serialize concurrent association and partial updates', async t => {
  const app = await testApp()
  t.after(() => app.close())
  const { request, legacy } = app
  for (const body of [{ title: 'missing question' }, { title: ' ', question: 'a' }, { title: 'a', question: 'b', documents: [] }, { title: 'x'.repeat(201), question: 'a' }]) assert.equal((await request('/api/topics', json('POST', body))).status, 422)
  const topic = await (await request('/api/topics', json('POST', { title: '并发保存', question: '如何保留研究记录？' }))).json()
  const second = await (await request('/api/documents', upload('另一篇资料'))).json()
  const path = `/api/topics/${topic.id}`
  const adds = await Promise.all([legacy.id, second.id, legacy.id].map(id => request(`${path}/documents/${id}`, { method: 'PUT' })))
  adds.forEach(result => assert.equal(result.status, 200))
  const edits = await Promise.all([
    request(path, json('PATCH', { scope: '并发更新范围' })),
    request(`${path}/documents/${legacy.id}`, json('PATCH', { reason: '保留理由' })),
    request(`${path}/documents/${legacy.id}`, json('PATCH', { readingStatus: 'read' })),
  ])
  edits.forEach(result => assert.equal(result.status, 200))
  const saved = await (await request(path)).json()
  assert.equal(saved.documents.length, 2); assert.equal(saved.scope, '并发更新范围')
  const relation = saved.documents.find(link => link.documentId === legacy.id)
  assert.equal(relation.reason, '保留理由'); assert.equal(relation.readingStatus, 'read')
  for (const body of [{ selection: 'bogus' }, { readingStatus: 'done' }, { reason: 1 }, { documentId: second.id }, { relevance: 'a'.repeat(2001) }]) assert.equal((await request(`${path}/documents/${legacy.id}`, json('PATCH', body))).status, 422)
  for (const body of [{ title: '' }, { year: 'abcd' }, { url: 'javascript:alert(1)' }, { doi: 'invalid' }, { references: [] }, { authors: [] }]) assert.equal((await request(`/api/documents/${legacy.id}`, json('PATCH', body))).status, 422)
  assert.equal((await request(path, json('PATCH', { question: ' ' }))).status, 422)
  assert.equal((await request(`${path}/documents/${randomUUID()}`, { method: 'PUT' })).status, 404)
  assert.equal((await request(`${path}/documents/${randomUUID()}`, json('PATCH', { reason: 'missing' }))).status, 404)
  assert.equal((await request('/api/topics/not-an-id')).status, 400)
  assert.equal((await request('/api/topics', { headers: { origin: 'https://other.invalid' } })).status, 403)
  assert.deepEqual((await (await request(path)).json()).documents, saved.documents)
})

test('UUID casing identifies the same document, association and serialized update queue', async t => {
  const app = await testApp()
  t.after(() => app.close())
  const { request, legacy } = app
  const topic = await (await request('/api/topics', json('POST', { title: '同一份文献', question: '标识符大小写会不会重复关联？' }))).json()
  for (const [topicId, documentId] of [[topic.id, legacy.id], [topic.id.toUpperCase(), legacy.id.toUpperCase()]]) {
    assert.equal((await request(`/api/topics/${topicId}/documents/${documentId}`, { method: 'PUT' })).status, 200)
  }
  assert.equal((await (await request(`/api/topics/${topic.id}`)).json()).documents.length, 1)
  const responses = await Promise.all([
    request(`/api/documents/${legacy.id}`, json('PATCH', { authors: '保留作者' })),
    request(`/api/documents/${legacy.id.toUpperCase()}`, json('PATCH', { year: '2024' })),
  ])
  for (const response of responses) assert.equal(response.status, 200)
  const document = await (await request(`/api/documents/${legacy.id}`)).json()
  assert.equal(document.bibliography.authors, '保留作者')
  assert.equal(document.bibliography.year, '2024')
})
