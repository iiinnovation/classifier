import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createApp } from '../apps/api/src/server.mjs'
import { createStore } from '../apps/api/src/store.mjs'

test('HTTP: import, retrieve originals, ask, persist history and reject invalid input', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'classifier-api-test-'))
  delete process.env.CLASSIFIER_MODEL_API_URL
  delete process.env.CLASSIFIER_MODEL_API_KEY
  const server = await createApp({ dataDir })
  t.after(async () => {
    if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    await rm(dataDir, { recursive: true, force: true })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const request = (path, options) => fetch(base + path, options)
  assert.equal((await request('/health')).status, 200)
  for (const path of ['/', '/app.js', '/style.css', '/katex.mjs', '/katex.css', '/fonts/KaTeX_Main-Regular.woff2']) assert.equal((await request(path)).status, 200)
  const original = '# 细胞研究\n\n我们使用显微镜研究细胞形态。\n\n样本来自实验组。'
  const form = new FormData()
  form.append('file', new Blob([original], { type: 'text/markdown' }), 'study.md')
  const upload = await request('/api/documents', { method: 'POST', body: form })
  assert.equal(upload.status, 201)
  const document = await upload.json()
  assert.equal(document.title, '细胞研究')
  assert.ok(document.references.length > 0)
  assert.equal(await (await request(`/api/documents/${document.id}/original`)).text(), original)
  assert.equal((await (await request('/api/documents')).json()).documents.length, 1)
  const ask = question => request(`/api/documents/${document.id}/questions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question }),
  })
  assert.equal((await ask('')).status, 422)
  const created = await ask('显微镜')
  assert.equal(created.status, 202)
  let run = await created.json()
  for (let attempt = 0; attempt < 100 && ['queued', 'running'].includes(run.status); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10))
    run = await (await request(`/api/runs/${run.id}`)).json()
  }
  assert.equal(run.status, 'completed')
  assert.equal(run.result.mode, 'extractive')
  assert.ok(run.result.references.some(ref => ref.text.includes('显微镜')))
  const restored = await createStore(dataDir)
  assert.equal((await restored.read('runs', run.id)).status, 'completed')
  const history = await (await request(`/api/documents/${document.id}`)).json()
  assert.equal(history.questions[0].id, run.id)
  assert.equal((await request('/api/documents/not-an-id')).status, 400)
  assert.equal((await request('/api/documents', { headers: { origin: 'https://other.invalid' } })).status, 403)
  assert.equal((await request('/api/parser-capabilities')).status, 200)
  const background = new FormData()
  background.append('file', new Blob(['后台导入的文档内容']), 'background.txt')
  const queued = await request('/api/imports', { method: 'POST', body: background })
  assert.equal(queued.status, 202)
  let job = await queued.json()
  for (let i = 0; i < 200 && ['queued', 'running'].includes(job.status); i++) {
    await new Promise(resolve => setTimeout(resolve, 20))
    job = await (await request(`/api/imports/${job.id}`)).json()
  }
  assert.equal(job.status, 'completed', job.error)
  assert.equal((await request(`/api/documents/${job.documentId}`)).status, 200)
  const cancelled = await (await request('/api/imports', { method: 'POST', body: background })).json()
  assert.equal((await request(`/api/imports/${cancelled.id}/cancel`, { method: 'POST' })).status, 200)
  let cancelJob
  for (let i = 0; i < 200; i++) {
    cancelJob = await (await request(`/api/imports/${cancelled.id}`)).json()
    if (!['queued', 'running'].includes(cancelJob.status)) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(cancelJob.status, 'cancelled')
})

test('unfinished tasks become interrupted after reopening storage', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'classifier-restart-test-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const store = await createStore(dataDir)
  const run = { id: randomUUID(), status: 'running', createdAt: new Date().toISOString() }
  await store.write('runs', run)
  await store.write('imports', run)
  const reopened = await createStore(dataDir)
  assert.equal((await reopened.read('runs', run.id)).status, 'interrupted')
  assert.equal((await reopened.read('imports', run.id)).status, 'interrupted')
})
