import test from 'node:test'
import assert from 'node:assert/strict'
import { createSettingsProvider, taskSettings } from '../apps/api/src/settings.mjs'
import { testApp, json } from './helpers/test-app.mjs'

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
