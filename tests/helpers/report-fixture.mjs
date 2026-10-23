import { testApp, json, upload } from './test-app.mjs'

export async function reportFixture(qaOptions) {
  const app = await testApp({ qaOptions })
  async function value(path, options, status = 200) {
    const response = await app.request(path, options), body = await response.json()
    if (response.status !== status) throw new Error(`${path}: expected ${status}, got ${response.status}: ${JSON.stringify(body)}`)
    return body
  }
  try {
    const topic = await value('/api/topics', json('POST', { title: '研究成果验收', question: '不同研究条件下有哪些发现和待验证问题？' }), 201)
    await value(`/api/topics/${topic.id}/documents/${app.legacy.id}`, { method: 'PUT' })
    const first = await value(`/api/documents/${app.legacy.id}`)
    const second = await value('/api/documents', upload('# 第二份研究\n\n研究二使用不同人群与测量条件，结果不能直接合并。', 'second.md', topic.id), 201)
    await value(`/api/documents/${first.id}`, json('PATCH', { authors: 'Researcher A', year: '2025', venue: 'Evidence Journal', doi: '10.1000/example' }))
    const note = await value(`/api/topics/${topic.id}/documents/${first.id}/notes`, json('POST', { field: '主要发现', origin: { type: 'reference' }, referenceIds: [first.references[0].id], documentVersion: first.evidenceVersion }), 201)
    let comparison = await value(`/api/topics/${topic.id}/comparisons`, json('POST', { title: '条件比较', documentIds: [first.id, second.id], columns: [{ name: '研究条件' }] }), 201)
    for (const doc of [first, await value(`/api/documents/${second.id}`)]) comparison = await value(`/api/comparisons/${comparison.id}/cells/${doc.id}/${comparison.columns[0].id}`, json('PATCH', { revision: comparison.revision, value: doc.references[0].text, status: 'recorded', kind: 'source', conditions: '限于当前研究样本', comparability: 'not_comparable', reason: '测量条件不一致', source: { type: 'passages', referenceIds: [doc.references[0].id], documentVersion: doc.evidenceVersion } }))
    comparison = await value(`/api/comparisons/${comparison.id}/analyses/${comparison.columns[0].id}`, json('PATCH', { revision: comparison.revision, documentIds: [first.id, second.id], relation: 'difference', value: '不同样本和测量条件下的发现需要分别解释。', conditions: '不能直接合并数值。' }))
    const selectors = [{ type: 'note', id: note.id, revision: note.revision }, { type: 'comparison', id: comparison.id, revision: comparison.revision }]
    return { ...app, value, topic, first, second, note, comparison, selectors }
  } catch (error) { await app.close(); throw error }
}
export async function waitReportRun(app, id) {
  for (let i = 0; i < 200; i++) {
    const run = await app.value(`/api/runs/${id}`)
    if (!['queued', 'running'].includes(run.status)) return run
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('Report task did not finish')
}
export function reportReply(input) {
  return { blocks: [{ section: '研究总结', text: '所选研究需要结合各自条件解释，暂不合并数值。', kind: 'inference', citationIds: input.evidence.map(item => item.id) }, { section: '待验证问题', text: '更广泛人群是否适用，仍需补充材料。', kind: 'question', citationIds: [] }] }
}
