import test from 'node:test'
import assert from 'node:assert/strict'
import { createSettingsProvider, taskSettings } from '../apps/api/src/settings.mjs'
import { testApp, json, waitJob } from './helpers/test-app.mjs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { textPdf } from './helpers/pdf-fixture.mjs'

test('injected settings update health immediately while queued work holds an immutable credential snapshot', async t => {
  const provider = createSettingsProvider(), seen = [], gate = Promise.withResolvers()
  const app = await testApp({ settingsProvider: provider, qaOptions: { fetchImpl: async (url, options) => {
    seen.push({ url, authorization: options.headers.authorization })
    await gate.promise
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ claims: [], limitations: '测试不作研究判断。' }) } }] }))
  } } })
  t.after(() => { gate.resolve(); return app.close() })
  assert.equal((await (await app.request('/health')).json()).modelConfigured, false)
  provider.update({ text: { url: 'https://old.invalid', key: 'old-test-key', model: 'fixture' } })
  const first = taskSettings(provider)
  assert.equal((await (await app.request('/health')).json()).modelConfigured, true)
  const run = await (await app.request(`/api/documents/${app.legacy.id}/questions`, json('POST', { question: '研究材料' }))).json()
  provider.update({ text: { url: 'https://new.invalid', key: 'new-test-key', model: 'fixture' } })
  assert.equal(first.text.key, 'old-test-key')
  assert.throws(() => { first.text.key = 'mutated' }, TypeError)
  gate.resolve()
  let saved
  for (let i = 0; i < 100; i++) {
    saved = await (await app.request(`/api/runs/${run.id}`)).json()
    if (!['queued', 'running'].includes(saved.status)) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(saved.status, 'completed')
  assert.deepEqual(seen[0], { url: 'https://old.invalid', authorization: 'Bearer old-test-key' })
  assert.ok(!JSON.stringify(saved).includes('old-test-key'))
  assert.equal(taskSettings(provider).text.url, 'https://new.invalid')
})

test('running multi-round text tasks keep their snapshot while new tasks use changed settings', { timeout: 15000 }, async t => {
  const old = { url: 'https://old.invalid', key: 'old-fixture-key', model: 'old-model' }
  const next = { url: 'https://new.invalid', key: 'new-fixture-key', model: 'new-model' }
  const provider = createSettingsProvider({ text: old }), seen = [], started = Promise.withResolvers(), release = Promise.withResolvers()
  let oldCalls = 0
  const app = await testApp({ settingsProvider: provider, qaOptions: { fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body)
    seen.push({ url, key: options.headers.authorization, model: body.model })
    if (url === old.url && ++oldCalls === 1) {
      started.resolve(); await release.promise
      return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'lookup', type: 'function', function: { name: 'search_passages', arguments: JSON.stringify({ query: '研究材料' }) } }] } }] }))
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ claims: [], limitations: '配置隔离测试。' }) } }] }))
  } } })
  t.after(async () => { release.resolve(); await app.close() })
  const a = await (await app.request(`/api/documents/${app.legacy.id}/questions`, json('POST', { question: '研究材料' }))).json()
  await started.promise
  provider.update({ text: next })
  const b = await (await app.request(`/api/documents/${app.legacy.id}/questions`, json('POST', { question: '研究材料' }))).json()
  release.resolve()
  for (const id of [a.id, b.id]) {
    let run
    for (let i = 0; i < 200; i++) {
      run = await (await app.request(`/api/runs/${id}`)).json()
      if (!['queued', 'running'].includes(run.status)) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(run.status, 'completed')
    assert.equal(run.result.mode, 'model')
    assert.ok(!JSON.stringify(run).includes('fixture-key'))
  }
  assert.equal(oldCalls, 2)
  assert.deepEqual(seen.filter(call => call.url === old.url), Array(2).fill({ url: old.url, key: `Bearer ${old.key}`, model: old.model }))
  assert.deepEqual(seen.filter(call => call.url === next.url), [{ url: next.url, key: `Bearer ${next.key}`, model: next.model }])
})

test('a visual import keeps its provider across pages and the next import uses updated settings', { timeout: 30000 }, async t => {
  const firstPage = Promise.withResolvers(), release = Promise.withResolvers(), seen = []
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    seen.push({ path: req.url, key: req.headers.authorization, model: body.model })
    if (seen.length === 1) { firstPage.resolve(); await release.promise }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ blocks: [{ type: 'paragraph', text: 'Controlled visual fixture content', bbox: [0.1, 0.1, 0.8, 0.1] }] }) } }] }))
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const base = `http://127.0.0.1:${upstream.address().port}`
  const provider = createSettingsProvider({ vision: { url: `${base}/old`, key: 'vision-old-fixture', model: 'old-vision' } })
  let app
  t.after(async () => { release.resolve(); await app?.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)) })
  app = await testApp({ settingsProvider: provider })
  async function start(pages) {
    const body = new FormData(); body.append('file', new Blob([textPdf(pages)], { type: 'application/pdf' }), 'settings.pdf'); body.append('mode', 'vision')
    const response = await app.request('/api/imports', { method: 'POST', body })
    assert.equal(response.status, 202); return response.json()
  }
  const a = await start(2)
  await firstPage.promise
  provider.update({ vision: { url: `${base}/new`, key: 'vision-new-fixture', model: 'new-vision' } })
  release.resolve()
  const savedA = await waitJob(app.request, a.id)
  assert.equal(savedA.status, 'completed')
  const b = await start(1), savedB = await waitJob(app.request, b.id)
  assert.equal(savedB.status, 'completed')
  assert.deepEqual(seen, [
    { path: '/old', key: 'Bearer vision-old-fixture', model: 'old-vision' },
    { path: '/old', key: 'Bearer vision-old-fixture', model: 'old-vision' },
    { path: '/new', key: 'Bearer vision-new-fixture', model: 'new-vision' },
  ])
  for (const job of [savedA, savedB]) {
    const document = await (await app.request(`/api/documents/${job.documentId}`)).json()
    assert.ok(document.sections.every(section => section.extraction === 'vision'))
    assert.ok(!JSON.stringify({ job, document }).includes('vision-old-fixture'))
    assert.ok(!JSON.stringify({ job, document }).includes('vision-new-fixture'))
  }
})
