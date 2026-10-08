import test from 'node:test'
import assert from 'node:assert/strict'
import { comparisonReferences } from '../apps/api/src/comparison-retrieval.mjs'

test('Chinese default dimensions retrieve English section bodies without translating the source', () => {
  const paragraphs = [
    ['h1', 'Methods'], ['method', 'We randomly assigned the groups and recorded changes over twelve weeks.'],
    ['h2', 'Participants'], ['subjects', 'One hundred and twenty adults were enrolled in two cohorts.'],
    ['h3', 'Results'], ['results', 'The measured score improved by twelve points in the intervention group.'],
    ['h4', 'Limitations'], ['limitations', 'Only adults from one hospital were included; transfer to other populations is uncertain.'],
  ]
  const document = { references: paragraphs.map(([id, text]) => ({ id, text, title: `Page 1 / ${id}` })) }
  for (const [name, expected] of [['方法', 'method'], ['研究对象', 'subjects'], ['主要发现', 'results'], ['局限', 'limitations']]) {
    const result = comparisonReferences(document, { name, description: '' })
    assert.ok(result.references.some(ref => ref.id === expected), name)
    for (const ref of result.references) assert.equal(ref.text, document.references.find(original => original.id === ref.id).text)
    assert.equal(result.partial, true)
  }
})

test('unmatched standard dimensions use explicitly partial context; custom queries remain literal', () => {
  const document = { references: [
    { id: 'heading', title: 'Page 1', text: 'Abstract' },
    { id: 'body', title: 'Page 1', text: 'A sequence of symbols is transformed through a finite sequence of operations.' },
  ] }
  const sample = comparisonReferences(document, { name: '方法', description: '' })
  assert.equal(sample.strategy, 'context_sample')
  assert.equal(sample.partial, true)
  assert.ok(sample.references.some(ref => ref.id === 'body'))
  const custom = comparisonReferences(document, { name: '电阻率', description: '' })
  assert.equal(custom.strategy, 'no_match'); assert.deepEqual(custom.references, [])
  assert.ok(comparisonReferences(document, { name: '符号处理', description: 'symbols operations' }).references.some(ref => ref.id === 'body'))
  assert.deepEqual(comparisonReferences({ references: [] }, { name: '方法' }).references, [])
})
