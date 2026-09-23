import test from 'node:test'
import assert from 'node:assert/strict'
import { searchReferences, terms } from '../apps/api/src/retrieval.mjs'

test('Chinese and English terms produce deterministic passage ranking', () => {
  const document = {
    references: [
      { id: 'ref_00001', title: '方法', page: 1, text: '我们使用 single-cell RNA sequencing 分析细胞异质性。' },
      { id: 'ref_00002', title: '结果', page: 2, text: '实验结果显示处理组的表达水平提高。' },
    ],
  }
  assert.ok(terms('single-cell RNA sequencing').includes('sequencing'))
  assert.equal(searchReferences(document, 'single-cell RNA sequencing')[0].id, 'ref_00001')
  assert.equal(searchReferences(document, '细胞异质性')[0].id, 'ref_00001')
})

test('empty or stop-word questions do not return arbitrary evidence', () => {
  const document = { references: [{ id: 'ref_00001', title: '正文', text: '实验正文' }] }
  assert.deepEqual(searchReferences(document, '的 是'), [])
})
