import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createSettingsProvider, environmentSettings, taskSettings, bindTaskAuthorization } from '../apps/api/src/settings.mjs'
import { modelSession } from '../apps/api/src/model-session.mjs'
import { createRuns } from '../apps/api/src/runs.mjs'
import { parseInWorker } from '../apps/api/src/imports.mjs'
import { answerQuestion } from '../apps/api/src/qa.mjs'
import { planComparison, generateComparison } from '../apps/api/src/comparison-model.mjs'
import { generateReport } from '../apps/api/src/report-model.mjs'
import { testApp, json, upload, waitJob } from './helpers/test-app.mjs'
import { textPdf } from './helpers/pdf-fixture.mjs'

const text = { url: 'https://text.invalid/chat', key: 'text-fixture-secret', model: 'fixture' }
const vision = { url: 'https://vision.invalid/chat', key: 'vision-fixture-secret', model: 'fixture' }
const reply = () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ claims: [], limitations: 'Controlled fixture, no research conclusion.' }) } }] }))
async function runStatus(app, id) {
  for (let i = 0; i < 300; i++) {
    const run = await (await app.request(`/api/runs/${id}`)).json()
    if (!['queued', 'running'].includes(run.status)) return run
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Run did not settle')
}

test('revocation reaches old and updated snapshots, separates text/vision, and requires a new connection to grant again', () => {
  const provider = createSettingsProvider({ text, vision }), a = taskSettings(provider)
  provider.update({ text: { ...text, key: 'updated-fixture-secret' } })
  const b = taskSettings(provider)
  assert.equal(a.authorization.text, b.authorization.text)
  provider.revoke('text')
  assert.equal(a.authorization.text.aborted, true); assert.equal(b.authorization.text.aborted, true)
  assert.equal(a.authorization.vision.aborted, false)
  assert.equal(taskSettings(provider, { config: text }).text.key, '')
  provider.update({ text })
  const c = taskSettings(provider)
  assert.equal(c.authorization.text.aborted, false); assert.equal(a.authorization.text.aborted, true)
  provider.revoke('vision')
  assert.equal(c.authorization.text.aborted, false); assert.equal(c.authorization.vision.aborted, true)
  assert.equal(provider.read().vision.key, '')
  const env = { CLASSIFIER_MODEL_API_URL: text.url, CLASSIFIER_MODEL_API_KEY: text.key }
  const adapter = environmentSettings(env), old = taskSettings(adapter)
  adapter.revoke('all')
  assert.equal(old.authorization.text.aborted, true)
  assert.equal(taskSettings(adapter, { config: text }).text.key, '')
  assert.equal(env.CLASSIFIER_MODEL_API_KEY, text.key)
  adapter.update({ text }); assert.equal(taskSettings(adapter).authorization.text.aborted, false)
  const session = modelSession(provider)
  for (const body of [null, [], {}, { scope: 'invalid' }, { scope: 'text', key: 'unexpected' }]) assert.throws(() => session.revoke(body), { status: 422 })
  assert.equal(provider.read().text.key, text.key)
})

for (const kind of ['question', 'comparison-plan', 'comparison-column', 'report']) test(`${kind} checks cancellation after awaited progress immediately before sending`, async () => {
  const provider = createSettingsProvider({ text }), snapshot = taskSettings(provider), controller = new AbortController()
  const unbind = bindTaskAuthorization(controller, snapshot.authorization.text)
  let sends = 0
  const options = { config: snapshot.text, signal: controller.signal, onEvent: async () => { await Promise.resolve(); provider.revoke('text') }, fetchImpl: async () => { sends++; return reply() } }
  const jobs = {
    question: () => answerQuestion({ title: 'Fixture', sections: [], references: [] }, 'question', options),
    'comparison-plan': () => planComparison({}, options),
    'comparison-column': () => generateComparison({ documents: [], evidence: [], column: { name: 'Fixture' } }, options),
    report: () => generateReport({ sources: [], evidence: [] }, options),
  }
  try { await assert.rejects(jobs[kind](), /授权已撤销/); assert.equal(sends, 0) }
  finally { unbind() }
})

test('a task whose configuration was captured before a slow record read cannot send after revocation', async () => {
  const provider = createSettingsProvider({ text }), reading = Promise.withResolvers(), release = Promise.withResolvers(), records = new Map()
  let sends = 0
  const runs = createRuns({ document: async () => { reading.resolve(); await release.promise; return { id: 'fixture', title: 'Fixture', sections: [], references: [] } }, write: async (_bucket, run) => records.set(run.id, structuredClone(run)) }, { fetchImpl: async () => { sends++; return reply() } }, provider)
  const started = runs.start('fixture', 'question')
  await reading.promise
  provider.revoke('all'); provider.update({ text })
  release.resolve()
  const run = await started
  await runs.stop()
  assert.equal(sends, 0); assert.equal(records.get(run.id).status, 'cancelled')
})

test('HTTP revocation stops old and new model snapshots, blocks subsequent rounds and overrides, and preserves local search and explicit reconnection', { timeout: 15000 }, async t => {
  const provider = createSettingsProvider({ text }), started = Promise.withResolvers(), release = Promise.withResolvers(), signals = []
  let sends = 0, delayed = true
  const app = await testApp({ settingsProvider: provider, qaOptions: { config: text, fetchImpl: async (_url, options) => {
    sends++; signals.push(options.signal)
    if (sends === 2) started.resolve()
    if (delayed) {
      await release.promise
      return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'lookup', type: 'function', function: { name: 'search_passages', arguments: '{"query":"研究材料"}' } }] } }] }))
    }
    return reply()
  } } })
  t.after(async () => { release.resolve(); await app.close() })
  const ask = async () => (await app.request(`/api/documents/${app.legacy.id}/questions`, json('POST', { question: '研究材料' }))).json()
  const a = await ask()
  provider.update({ text: { ...text, url: 'https://new.invalid/chat' } })
  const b = await ask()
  await started.promise
  const path = '/api/settings/model-authorization/revoke'
  assert.equal((await app.request(path, { ...json('POST', { scope: 'all' }), headers: { origin: 'https://foreign.invalid', 'content-type': 'application/json' } })).status, 403)
  assert.equal((await app.request(path, json('POST', { scope: 'unknown' }))).status, 422)
  assert.ok(signals.every(signal => !signal.aborted))
  const response = await app.request(path, json('POST', { scope: 'all' }))
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.ok(!(await response.text()).includes('fixture-secret'))
  assert.ok(signals.every(signal => signal.aborted))
  assert.equal((await (await app.request('/health')).json()).modelConfigured, false)
  release.resolve()
  for (const id of [a.id, b.id]) {
    const saved = await runStatus(app, id)
    assert.equal(saved.status, 'cancelled'); assert.equal(saved.result, undefined)
    assert.ok(!JSON.stringify(saved).includes('fixture-secret'))
  }
  assert.equal(sends, 2)
  const local = await runStatus(app, (await ask()).id)
  assert.equal(local.status, 'completed'); assert.equal(local.result.mode, 'extractive'); assert.equal(sends, 2)
  await app.restart(); assert.equal(sends, 2)
  delayed = false
  assert.equal((await app.request('/api/settings/text-model', json('PATCH', text))).status, 200)
  assert.equal((await runStatus(app, (await ask()).id)).status, 'completed'); assert.equal(sends, 3)
})

for (const isolate of [false, true]) test(`visual sends stay in the parent and cancellation stops the first request and remaining pages (isolated=${isolate})`, { timeout: 20000 }, async t => {
  const started = Promise.withResolvers(), disconnected = Promise.withResolvers(), service = createServer(async (req, res) => {
    for await (const _chunk of req) { /* Drain the synthetic page request. */ }
    res.once('close', () => disconnected.resolve())
    sends++; started.resolve()
  })
  let sends = 0
  service.listen(0, '127.0.0.1'); await once(service, 'listening')
  t.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)) })
  const provider = createSettingsProvider({ vision: { ...vision, url: `http://127.0.0.1:${service.address().port}/vision` } }), snapshot = provider.read(), controller = new AbortController()
  const unbind = bindTaskAuthorization(controller, snapshot.authorization.vision)
  const parsing = parseInWorker({ fileName: 'visual.pdf', bytes: textPdf(2) }, { mode: 'vision', visionConfig: snapshot.vision, signal: controller.signal, isolate })
  const failed = assert.rejects(parsing, /授权已撤销/)
  await started.promise; provider.revoke('vision')
  await failed; await disconnected.promise
  unbind(); assert.equal(sends, 1)
})

test('visual task revocation records cancellation and leaves text-model work and local imports available', { timeout: 20000 }, async t => {
  const started = Promise.withResolvers(), service = createServer(async (req, _res) => {
    for await (const _chunk of req) { /* Drain the synthetic page request. */ }
    sends++; started.resolve()
  })
  let sends = 0, app
  service.listen(0, '127.0.0.1'); await once(service, 'listening')
  t.after(async () => { await app?.close(); service.closeAllConnections(); await new Promise(resolve => service.close(resolve)) })
  const provider = createSettingsProvider({ text, vision: { ...vision, url: `http://127.0.0.1:${service.address().port}/vision` } })
  app = await testApp({ settingsProvider: provider, qaOptions: { fetchImpl: async () => reply() } })
  const body = new FormData(); body.append('file', new Blob([textPdf(2)], { type: 'application/pdf' }), 'visual.pdf'); body.append('mode', 'vision')
  const job = await (await app.request('/api/imports', { method: 'POST', body })).json()
  await started.promise
  assert.equal((await app.request('/api/settings/model-authorization/revoke', json('POST', { scope: 'vision' }))).status, 200)
  assert.equal((await waitJob(app.request, job.id)).status, 'cancelled'); assert.equal(sends, 1)
  assert.equal((await (await app.request('/api/parser-capabilities')).json()).vision, false)
  assert.equal((await (await app.request('/health')).json()).modelConfigured, true)
  const local = await (await app.request('/api/imports', upload('Local research content.', 'local.txt'))).json()
  assert.equal((await waitJob(app.request, local.id)).status, 'completed')
  const ask = await (await app.request(`/api/documents/${app.legacy.id}/questions`, json('POST', { question: '研究材料' }))).json()
  assert.equal((await runStatus(app, ask.id)).status, 'completed')
  await app.restart(); assert.equal(sends, 1)
})
