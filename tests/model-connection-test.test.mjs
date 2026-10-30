import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { modelSession } from '../apps/api/src/model-session.mjs'
import { createSettingsProvider } from '../apps/api/src/settings.mjs'
import { testModelConnection } from '../apps/api/src/model-connection-test.mjs'
import { testApp, json } from './helpers/test-app.mjs'

const connection = { url: 'https://connection.invalid/v1/chat/completions', model: 'fixture', key: 'connection-fixture-secret' }
const reply = () => new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))

test('testing a draft sends only fixed text, leaves active settings untouched and binds success to the exact saved connection', async t => {
  const provider = createSettingsProvider({ text: { ...connection, url: 'https://original.invalid/chat' } }), calls = []
  const app = await testApp({ settingsProvider: provider, modelTestOptions: { fetchImpl: async (url, options) => { calls.push({ url, ...options }); return reply() } } })
  t.after(() => app.close())
  const path = '/api/settings/text-model'
  const bad = await app.request(path + '/test', { ...json('POST', connection), headers: { origin: 'https://foreign.invalid', 'content-type': 'application/json' } })
  assert.equal(bad.status, 403); assert.equal(calls.length, 0)
  const response = await app.request(path + '/test', json('POST', connection))
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal((await response.json()).state, 'passed')
  assert.equal(provider.read().text.url, 'https://original.invalid/chat')
  assert.equal(calls[0].redirect, 'error')
  const body = JSON.parse(calls[0].body)
  assert.equal(body.messages.length, 1); assert.match(body.messages[0].content, /synthetic connection test/)
  assert.ok(!calls[0].body.includes(app.original)); assert.ok(!calls[0].body.includes(app.legacy.id))
  const saved = await (await app.request(path, json('PATCH', connection))).json()
  assert.equal(saved.connectionTest.state, 'passed'); assert.ok(!JSON.stringify(saved).includes(connection.key))
  await app.request(path, json('PATCH', { ...connection, model: 'different-model', key: '' }))
  assert.equal((await (await app.request(path)).json()).connectionTest.state, 'untested')
  await app.request(path + '/test', json('POST', { ...connection, model: 'different-model', key: '' }))
  assert.equal(calls.at(-1).headers.authorization, 'Bearer ' + connection.key)
  for (const bucket of ['runs', 'imports', 'notes', 'comparisons', 'reports']) {
    assert.deepEqual(await readdir(join(app.dataDir, bucket)), [])
  }
  assert.ok(!(await readFile(join(app.dataDir, 'documents', app.legacy.id + '.json'), 'utf8')).includes(connection.key))
})

test('authentication, malformed replies and response limits return safe errors without reflecting credentials or upstream text', async () => {
  const reasoning = await testModelConnection(connection, { fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: '', reasoning_content: 'Reasoning within the small test token limit.' } }] })) })
  assert.equal(reasoning.state, 'passed')
  for (const response of [
    new Response(connection.key, { status: 401 }),
    new Response('<html>private upstream diagnostic</html>'),
    new Response(JSON.stringify({ data: 'not a conversation' })),
    new Response('x'.repeat(65537)),
  ]) {
    await assert.rejects(testModelConnection(connection, { fetchImpl: async () => response }), error => error.status === 422 && !error.message.includes(connection.key) && !error.message.includes('private upstream'))
  }
})

test('timeout, cancellation and revocation stop connection probes; a later explicit probe can start again', async () => {
  const hang = async (_url, { signal }) => new Promise((_resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }) })
  await assert.rejects(testModelConnection(connection, { timeoutMs: 5, fetchImpl: hang }), /测试超时/)
  const provider = createSettingsProvider({ text: connection }), session = modelSession(provider, { fetchImpl: hang })
  const pending = session.test(connection), rejected = assert.rejects(pending, /测试已停止/)
  await assert.rejects(session.test(connection), { status: 429 })
  session.revoke({ scope: 'all' }); await rejected
  assert.equal(provider.read().text.key, '')
  const next = modelSession(provider, { fetchImpl: async () => reply() })
  assert.equal((await next.test(connection)).state, 'passed')
  assert.equal(provider.read().text.key, '')
})

test('changing current settings cancels an old test and remembering is rejected where OS protection is unavailable', async () => {
  const provider = createSettingsProvider({ text: connection }), started = Promise.withResolvers()
  const session = modelSession(provider, { fetchImpl: async (_url, { signal }) => { started.resolve(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) } })
  const pending = session.test({ ...connection, key: '' }), stopped = assert.rejects(pending, /测试已停止/)
  await started.promise
  session.update({ ...connection, model: 'new-model', key: '' }); await stopped
  assert.equal(session.get().connectionTest.state, 'untested')
  assert.throws(() => session.update({ ...connection, remember: true }), { status: 409 })
  assert.throws(() => session.update({ ...connection, remember: 'true' }), { status: 422 })
})
