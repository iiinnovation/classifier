import { testApp, json, upload } from './test-app.mjs'

export function researchReply(input) {
  if (input.existingColumns) return { columns: [{ name: '方法', description: 'methods 研究方法' }, { name: input.instruction.includes('样本量') ? '样本量' : '主要发现', description: 'sample results 材料 研究结果' }] }
  if (input.column) {
    const cells = input.documents.map(doc => {
      const refs = input.evidence.filter(item => item.documentId === doc.id).slice(0, 1)
      return { documentId: doc.id, value: refs.length ? input.column.name + '：' + doc.title : '', status: refs.length ? 'recorded' : 'not_found', kind: 'source', conditions: '仅针对提供的节选', comparability: refs.length ? 'conditional' : 'unchecked', reason: refs.length ? '条件需要分别核对' : '', referenceIds: refs.map(ref => ref.id) }
    })
    const referenceIds = cells.flatMap(cell => cell.referenceIds)
    return { cells, analysis: { relation: cells.every(cell => cell.referenceIds.length) ? 'difference' : 'insufficient', value: '所选研究的条件需要分别解释。', conditions: '证据仅来自所选材料的部分节选。', referenceIds } }
  }
  return { blocks: [{ section: '研究总结', text: '所选研究的方法与条件不同，结论需分别解释。', kind: input.evidence.length ? 'inference' : 'question', citationIds: input.evidence.map(item => item.id).slice(0, 24) }, { section: '待验证问题', text: '样本与测量设置是否一致，仍需核对。', kind: 'question', citationIds: [] }] }
}

export async function researchFixture({ respond = async input => researchReply(input), configured = true } = {}) {
  const inputs = []
  const qaOptions = configured ? { config: { url: 'https://fixture.invalid/research', key: 'test-only', model: 'fixture' }, fetchImpl: async (_url, options) => {
    const input = JSON.parse(JSON.parse(options.body).messages[1].content); inputs.push(input)
    const output = await respond(input, options)
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }))
  } } : undefined
  const app = await testApp({ qaOptions })
  const value = async (path, options, status = 200) => {
    const response = await app.request(path, options), body = await response.json()
    if (response.status !== status) throw new Error(path + ': expected ' + status + ', got ' + response.status + ': ' + JSON.stringify(body))
    return body
  }
  try {
    const topic = await value('/api/topics', json('POST', { title: '任务式研究', question: '比较这些论文的方法和结论，看看分歧在哪里' }), 201)
    await value('/api/topics/' + topic.id + '/documents/' + app.legacy.id, { method: 'PUT' })
    const second = await value('/api/documents', upload('# 第二项研究\n\n研究方法：使用另一种方法，材料来自不同人群。\n\n主要发现：测量条件不同，不能直接合并结果。', 'second.md', topic.id), 201)
    const outside = await value('/api/documents', upload('不属于本次任务的私人材料，不可发送。', 'outside.txt'), 201)
    return { ...app, value, topic, second, outside, inputs }
  } catch (error) { await app.close(); throw error }
}

export async function waitResearch(app, id) {
  for (let i = 0; i < 200; i++) {
    const run = await app.value('/api/runs/' + id)
    if (!['queued', 'running'].includes(run.status)) return run
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Research task timed out')
}
