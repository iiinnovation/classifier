import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('switching documents blocks questions and discards the previous document response', async () => {
  class Element {
    constructor(tag = 'div') { this.tag = tag; this.children = []; this.value = ''; this.hidden = false; this.disabled = false }
    append(...nodes) { this.children.push(...nodes) }
    replaceChildren(...nodes) { this.children = nodes }
    querySelector() { return new Element('option') }
  }
  const nodes = new Map()
  const document = {
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id) },
    createElement(tag) { return new Element(tag) },
    createTextNode(text) { return { textContent: text } },
  }
  const values = new Map()
  const localStorage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }
  const docs = ['A', 'B'].map(id => ({ id, title: id, referenceCount: 0 }))
  const full = id => ({ id, title: id, fileName: `${id}.txt`, references: [], warnings: [], sections: [], questions: [], mediaType: 'text/plain' })
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
  await assert.rejects(openDocument('missing'), /Unexpected request/)
  assert.equal(nodes.get('ask').disabled, false)
  resolveOldQuestion(response({ id: 'old', documentId: 'A', question: 'A question', status: 'completed', events: [] }))
  await oldSubmit
  assert.equal(nodes.get('history').children.some(node => node.id === 'run-old'), false)

  nodes.get('question').value = 'B question'
  await nodes.get('question-form').onsubmit({ preventDefault() {} })
  assert.deepEqual(posts, ['/api/documents/A/questions', '/api/documents/B/questions'])
  assert.equal(nodes.get('history').children.some(node => node.id === 'run-new'), true)
})
