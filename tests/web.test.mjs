import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('switching documents blocks questions and discards the previous document response', async () => {
  class Element {
    constructor(tag = 'div') { this.tag = tag; this.children = []; this.value = ''; this.hidden = false; this.disabled = false; this.attributes = new Map(); this.style = {}; this.classList = { add() {}, remove() {} } }
    append(...nodes) { nodes.forEach(node => { node.parent = this }); this.children.push(...nodes) }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes) }
    querySelector(selector) { return selector === '[value="vision"]' ? new Element('option') : this.children.find(node => node.className === selector.slice(1)) || null }
    setAttribute(name, value) { this.attributes.set(name, value) }
    focus() {}
    showModal() { this.open = true }
    close() { this.open = false }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this) }
    replaceWith() {}
    scrollIntoView() {}
  }
  const nodes = new Map()
  const document = {
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id) },
    createElement(tag) { return new Element(tag) },
    createTextNode(text) { return { textContent: text } },
    querySelectorAll() { return [] },
  }
  const values = new Map()
  const localStorage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }
  const docs = ['A', 'B'].map(id => ({ id, title: id, referenceCount: 0 }))
  const full = id => id === 'B'
    ? { id, title: id, fileName: 'B.pdf', references: [{ id: 'ref_00001', title: '第 2 页 · 表格 1', text: '报价金额 85', page: 2, bbox: [0.2, 0.3, 0.4, 0.1], needsReview: true }], warnings: ['第 2 页表格需核对'], sections: [{ blocks: [] }, { blocks: [] }], questions: [], mediaType: 'application/pdf' }
    : { id, title: id, fileName: `${id}.txt`, references: [], warnings: [], sections: [], questions: [], mediaType: 'text/plain' }
  let resolveB, resolveOldQuestion
  const delayedB = new Promise(resolve => { resolveB = resolve })
  const delayedOldQuestion = new Promise(resolve => { resolveOldQuestion = resolve })
  const posts = []
  const response = value => ({ ok: true, json: async () => value })
  const fetch = async (path, options = {}) => {
    if (path === '/api/parser-capabilities') return response({ ocr: { available: false, languages: [] }, vision: false })
    if (path === '/health') return response({ modelConfigured: false })
    if (path === '/api/documents') return response({ documents: docs })
    if (path === '/api/documents/A') return response(full('A'))
    if (path === '/api/documents/B') return delayedB
    if (path.endsWith('/questions') && options.method === 'POST') {
      posts.push(path)
      if (path.includes('/A/')) return delayedOldQuestion
      return response({ id: 'new', documentId: 'B', question: 'B question', status: 'completed', events: [], result: { mode: 'extractive', answer: 'B answer', references: [] } })
    }
    if (path === '/api/runs/new') return response({ id: 'new', documentId: 'B', question: 'B question', status: 'completed', events: [], result: { mode: 'extractive', answer: 'B answer', references: [] } })
    throw new Error(`Unexpected request: ${path}`)
  }
  const source = (await readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8'))
    .replace(/^import katex from '\/katex\.mjs'\n/, 'const katex = { render() {} }\n')
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const { openDocument } = await new AsyncFunction('document', 'fetch', 'localStorage', 'setTimeout', 'clearTimeout', `${source}\nreturn { openDocument }`)(document, fetch, localStorage, setTimeout, clearTimeout)
  assert.equal(nodes.get('title').textContent, 'A')
  assert.equal(nodes.get('ask').textContent, '搜索 ↗')
  assert.match(nodes.get('question').placeholder, /关键词|报价/)
  nodes.get('library-toggle').onclick()
  assert.equal(nodes.get('library').hidden, false)
  nodes.get('close-library').onclick()
  assert.equal(nodes.get('library').hidden, true)
  nodes.get('import-open').onclick()
  assert.equal(nodes.get('import-dialog').open, true)
  nodes.get('close-import').onclick()
  assert.equal(nodes.get('import-dialog').open, false)

  document.getElementById('question').value = 'A question'
  const oldSubmit = nodes.get('question-form').onsubmit({ preventDefault() {} })
  assert.deepEqual(posts, ['/api/documents/A/questions'])
  const switching = openDocument('B')
  assert.equal(nodes.get('ask').disabled, true)
  nodes.get('question').value = 'Should be blocked'
  await nodes.get('question-form').onsubmit({ preventDefault() {} })
  assert.equal(posts.length, 1)

  resolveB(response(full('B')))
  await switching
  assert.equal(nodes.get('title').textContent, 'B')
  assert.equal(nodes.get('ask').disabled, false)
  assert.equal(nodes.get('page-review').hidden, false)
  assert.equal(nodes.get('references').hidden, true)
  assert.equal(nodes.get('page-image').src, '/api/documents/B/pages/1')
  assert.equal(nodes.get('reference-search').hidden, true)
  assert.equal(nodes.get('reference-results').children.length, 0)
  assert.equal(nodes.get('warnings-toggle').textContent, '待核对 1')
  nodes.get('warnings-toggle').onclick()
  assert.equal(nodes.get('warnings').hidden, false)
  assert.equal(nodes.get('warnings-toggle').textContent, '收起提醒')
  assert.match(nodes.get('warning-text').textContent, /第 2 页表格需核对/)
  nodes.get('warnings-close').onclick()
  assert.equal(nodes.get('warnings').hidden, true)
  assert.equal(nodes.get('warnings-toggle').textContent, '待核对 1')
  nodes.get('warnings-toggle').onclick()
  nodes.get('warnings-toggle').onclick()
  assert.equal(nodes.get('warnings').hidden, true)
  nodes.get('reference-search-toggle').onclick()
  nodes.get('reference-query').value = '报价'
  nodes.get('reference-query').oninput()
  assert.equal(nodes.get('reference-results').children.length, 1)
  nodes.get('reference-results').children[0].onclick()
  assert.equal(nodes.get('reference-search').hidden, true)
  assert.equal(nodes.get('page-image').src, '/api/documents/B/pages/2')
  assert.equal(nodes.get('selected-excerpt').hidden, false)
  assert.match(nodes.get('page-notice').textContent, /表格需核对/)
  nodes.get('page-image').onload()
  assert.equal(nodes.get('page-highlight').style.left, '20%')
  await assert.rejects(openDocument('missing'), /Unexpected request/)
  assert.equal(nodes.get('ask').disabled, false)
  resolveOldQuestion(response({ id: 'old', documentId: 'A', question: 'A question', status: 'completed', events: [] }))
  await oldSubmit
  assert.equal(nodes.get('history').children.some(node => node.id === 'run-old'), false)

  nodes.get('question').value = 'B question'
  await nodes.get('question-form').onsubmit({ preventDefault() {} })
  assert.deepEqual(posts, ['/api/documents/A/questions', '/api/documents/B/questions'])
  assert.equal(nodes.get('history').children.some(node => node.id === 'run-new'), true)
  assert.equal(nodes.get('history').children.some(node => node.className === 'empty-state'), false)
})
