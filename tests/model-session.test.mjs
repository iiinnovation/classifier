import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { modelSession } from '../apps/api/src/model-session.mjs'
import { createSettingsProvider, environmentSettings, taskSettings } from '../apps/api/src/settings.mjs'
import { testApp, json } from './helpers/test-app.mjs'

test('runtime model settings keep keys out of responses and retain them only for the same endpoint', () => {
  const provider = createSettingsProvider(), settings = modelSession(provider)
  assert.equal(settings.get().hasKey, false)
  const first = settings.update({ url: 'https://model.invalid/chat', model: 'fixture', key: 'secret-test-only' })
  assert.equal(first.hasKey, true)
  assert.ok(!JSON.stringify(first).includes('secret-test-only'))
  const snapshot = taskSettings(provider)
  settings.update({ url: 'https://model.invalid/chat', model: 'updated', key: '' })
  assert.equal(provider.read().text.key, 'secret-test-only')
  assert.throws(() => settings.update({ url: 'https://other.invalid/chat', model: 'updated', key: '' }), /重新填写密钥/)
  for (const url of ['http://remote.invalid/chat', 'file:///tmp/model', 'https://user:password@host.invalid/chat', 'https://model.invalid/chat?key=secret', 'https://model.invalid/chat#secret']) assert.throws(() => settings.update({ url, model: 'fixture', key: 'secret' }))
  settings.update({ url: 'http://127.0.0.1:1234/v1/chat/completions', model: 'local', key: 'local' })
  settings.update({ clear: true })
  assert.equal(settings.get().hasKey, false)
  assert.equal(snapshot.text.key, 'secret-test-only')
})

test('environment model overrides are runtime-only and can explicitly disconnect', () => {
  const env = { CLASSIFIER_MODEL_API_URL: 'https://env.invalid/chat', CLASSIFIER_MODEL_API_KEY: 'env-secret', CLASSIFIER_MODEL: 'fixture' }
  const provider = environmentSettings(env), session = modelSession(provider)
  assert.equal(provider.read().text.url, env.CLASSIFIER_MODEL_API_URL)
  session.update({ clear: true })
  assert.equal(provider.read().text.key, '')
  assert.equal(env.CLASSIFIER_MODEL_API_KEY, 'env-secret')
  assert.equal(environmentSettings(env).read().text.key, 'env-secret')
})

test('settings presentation redacts credentials embedded in externally provided endpoints', () => {
  const env = { CLASSIFIER_MODEL_API_URL: 'https://user:password@env.invalid/chat?key=query-secret#fragment-secret', CLASSIFIER_MODEL_API_KEY: 'env-secret', CLASSIFIER_MODEL: 'fixture' }
  const provider = environmentSettings(env), value = modelSession(provider).get()
  assert.equal(value.url, 'https://env.invalid/chat')
  assert.ok(!/password|query-secret|fragment-secret|env-secret/.test(JSON.stringify(value)))
  assert.equal(provider.read().text.url, env.CLASSIFIER_MODEL_API_URL)
})

test('blank-key updates preserve the original endpoint when the displayed URL is unchanged', () => {
  const originalUrl = 'https://model.invalid:443/chat?api-version=2025-01-01'
  const provider = createSettingsProvider({ text: { url: originalUrl, model: 'fixture', key: 'synthetic-key' } })
  const session = modelSession(provider)
  const displayed = session.get().url
  assert.equal(displayed, 'https://model.invalid/chat')
  session.update({ url: displayed, model: 'fixture-v2', key: '' })
  assert.equal(provider.read().text.url, originalUrl)
  assert.equal(provider.read().text.key, 'synthetic-key')
})

test('model settings HTTP is same-origin guarded and never persists credentials to the library', async t => {
  const provider = createSettingsProvider(), app = await testApp({ settingsProvider: provider })
  t.after(() => app.close())
  const settings = '/api/settings/text-model'
  const cross = await app.request(settings, { ...json('PATCH', { clear: true }), headers: { origin: 'https://foreign.invalid', 'content-type': 'application/json' } })
  assert.equal(cross.status, 403)
  const response = await app.request(settings, json('PATCH', { url: 'https://model.invalid/chat', model: 'fixture', key: 'never-persist-this-test-key' }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.ok(!(await response.text()).includes('never-persist'))
  assert.equal((await (await app.request('/health')).json()).modelConfigured, true)
  const read = await app.request(settings)
  assert.equal(read.headers.get('cache-control'), 'no-store')
  assert.ok(!(await read.text()).includes('never-persist'))
  for (const bucket of ['runs', 'topics', 'comparisons', 'reports', 'notes']) for (const name of await readdir(join(app.dataDir, bucket))) assert.ok(!(await readFile(join(app.dataDir, bucket, name), 'utf8')).includes('never-persist'))
  await app.request(settings, json('PATCH', { clear: true }))
  assert.equal((await (await app.request('/health')).json()).modelConfigured, false)
})
