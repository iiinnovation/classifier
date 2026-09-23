import test from 'node:test'
import assert from 'node:assert/strict'
import { answerQuestion, validateAnswer } from '../apps/api/src/qa.mjs'

const ref = { id: 'ref_00001', title: 'Methods', text: 'Microscopy identified cells.' }
const second = { id: 'ref_00002', title: 'Results', text: 'Zebrafish survival improved.' }
const document = { title: 'Study', sections: [], references: [ref, second] }
const config = { url: 'https://model.invalid/chat/completions', key: 'test', model: 'test' }
const result = id => ({ claims: [{ text: 'Observed finding', kind: 'source', referenceIds: [id] }], limitations: '' })
const reply = message => ({ ok: true, json: async () => ({ choices: [{ message }] }) })
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })

test('rejects nonexistent and unread citations', () => {
  assert.throws(() => validateAnswer(result(second.id), new Map([[ref.id, ref]])), /未读取/)
  assert.equal(validateAnswer(result(ref.id), new Map([[ref.id, ref]])).mode, 'model')
})

test('search results must be read before they can be cited', async () => {
  for (const read of [false, true]) {
    let step = 0
    const response = await answerQuestion(document, 'microscopy', {
      config,
      fetchImpl: async () => {
        step++
        if (step === 1) return reply({ tool_calls: [call('search', 'search_passages', { query: 'zebrafish' })] })
        if (step === 2 && read) return reply({ tool_calls: [call('read', 'read_passages', { ids: [second.id] })] })
        return reply({ content: JSON.stringify(result(second.id)) })
      },
    })
    assert.equal(response.mode, read ? 'model' : 'extractive')
    if (read) assert.deepEqual(response.referenceIds, [second.id])
    else assert.match(response.warning, /未读取/)
  }
})

test('repeated tool requests terminate and preserve evidence', async () => {
  let requests = 0
  const response = await answerQuestion(document, 'microscopy', {
    config, fetchImpl: async () => {
      requests++
      return reply({ tool_calls: [call(`call-${requests}`, 'search_passages', { query: 'microscopy' })] })
    },
  })
  assert.ok(requests <= 5)
  assert.equal(response.mode, 'extractive')
  assert.ok(response.references.some(item => item.id === ref.id))
})

test('tool budget limits oversized batches and forces completion', async () => {
  let requests = 0
  const events = []
  const response = await answerQuestion(document, 'microscopy', {
    config, onEvent: async event => events.push(event),
    fetchImpl: async (_url, options) => {
      requests++
      if (requests === 1) return reply({ tool_calls: Array.from({ length: 12 }, (_, i) => call(`call-${i}`, 'search_passages', { query: `microscopy ${i}` })) })
      assert.equal(JSON.parse(options.body).tools, undefined)
      return reply({ content: JSON.stringify(result(ref.id)) })
    },
  })
  assert.equal(requests, 2)
  assert.equal(events.filter(event => event.type === 'tool' && event.ok).length, 8)
  assert.equal(response.mode, 'model')
})

test('model failure retains evidence; cancellation propagates', async () => {
  const response = await answerQuestion(document, 'microscopy', { config, fetchImpl: async () => { throw new Error('offline') } })
  assert.equal(response.mode, 'extractive')
  assert.match(response.warning, /offline/)
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  await assert.rejects(answerQuestion(document, 'microscopy', { config, signal: controller.signal }), /cancelled/)
})
