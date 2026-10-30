import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { createModelSettingsStore } from '../apps/desktop/model-settings-store.mjs'
import { createPersistentSettingsProvider } from '../apps/desktop/persistent-settings-provider.mjs'
import { taskSettings } from '../apps/api/src/settings.mjs'
import { modelSession } from '../apps/api/src/model-session.mjs'

const text = { url: 'https://settings.invalid/chat', model: 'fixture', key: 'protected-test-secret-only' }
function vault() {
  const master = randomBytes(32)
  return { name: 'test-vault', available: () => true,
    async encrypt(key) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', master, iv), bytes = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]) },
    async decrypt(bytes) { const decipher = createDecipheriv('aes-256-gcm', master, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8') },
  }
}
async function fixture(t) { const profile = await mkdtemp(join(tmpdir(), 'classifier-model-settings-')); t.after(() => rm(profile, { recursive: true, force: true })); return profile }

test('session settings stay in memory, remembered credentials are encrypted outside libraries and explicit forget survives reopen', async t => {
  const profile = await fixture(t), crypto = vault(), store = await createModelSettingsStore(profile, crypto)
  assert.equal(store.snapshot().remember, false)
  await store.update({ text, vision: {} }, { remember: false })
  assert.deepEqual(await readdir(profile), [])
  assert.equal(store.snapshot().text.key, text.key)
  assert.equal((await createModelSettingsStore(profile, crypto)).snapshot().text.key, '')
  await store.update({ text, vision: {} }, { remember: true })
  const raw = await readFile(join(profile, 'model-settings.json'), 'utf8')
  assert.ok(!raw.includes(text.key)); assert.ok(raw.includes(text.url))
  const reopened = await createModelSettingsStore(profile, crypto)
  assert.equal(reopened.snapshot().text.key, text.key); assert.equal(reopened.snapshot().remember, true)
  await reopened.revoke('vision'); assert.equal(reopened.snapshot().text.key, text.key)
  await reopened.clear()
  assert.equal((await createModelSettingsStore(profile, crypto)).snapshot().text.key, '')
  assert.deepEqual(await readdir(profile), [])
})

test('unavailable OS protection and damaged settings never fall back to plaintext or block session connections', async t => {
  const profile = await fixture(t), crypto = vault(), unavailable = { ...crypto, available: () => false }
  const store = await createModelSettingsStore(profile, unavailable)
  await assert.rejects(store.update({ text, vision: {} }, { remember: true }), { status: 409 })
  assert.deepEqual(await readdir(profile), [])
  await store.update({ text, vision: {} }, { remember: false })
  assert.equal(store.snapshot().text.key, text.key)
  const file = join(profile, 'model-settings.json'), bad = '{broken-settings'
  await writeFile(file, bad)
  const broken = await createModelSettingsStore(profile, crypto)
  assert.equal(broken.snapshot().text.key, ''); assert.ok(broken.snapshot().settingsWarning)
  await broken.update({ text, vision: {} }, { remember: false })
  assert.ok(broken.snapshot().settingsWarning)
  assert.equal(await readFile(file, 'utf8'), bad)
  await assert.rejects(broken.update({ text, vision: {} }, { remember: true }), { status: 409 })
  await broken.clear(); await broken.update({ text, vision: {} }, { remember: true })
  assert.equal((await createModelSettingsStore(profile, crypto)).snapshot().text.key, text.key)
})

test('failed protected writes do not switch runtime settings or destroy the prior saved credential', async t => {
  const profile = await fixture(t), crypto = vault(), original = await createModelSettingsStore(profile, crypto)
  await original.update({ text, vision: {} }, { remember: true })
  const failed = await createModelSettingsStore(profile, crypto, { writeFile: async () => { throw new Error('ENOSPC') } })
  const provider = createPersistentSettingsProvider(failed.snapshot(), (action, value) => failed[action](value.configuration, { remember: value.remember }))
  await assert.rejects(provider.update({ text: { ...text, key: 'replacement-secret' } }, { remember: true }), { status: 503 })
  assert.equal(provider.read().text.key, text.key)
  assert.equal((await createModelSettingsStore(profile, crypto)).snapshot().text.key, text.key)
})

test('protected credentials remain bound to their saved endpoint and model', async t => {
  const profile = await fixture(t), crypto = vault(), store = await createModelSettingsStore(profile, crypto)
  await store.update({ text, vision: {} }, { remember: true })
  const file = join(profile, 'model-settings.json'), value = JSON.parse(await readFile(file, 'utf8'))
  value.text.url = 'https://changed.invalid/chat'
  await writeFile(file, JSON.stringify(value))
  const changed = await createModelSettingsStore(profile, crypto)
  assert.equal(changed.snapshot().text.key, '')
  assert.ok(changed.snapshot().settingsWarning)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).text.url, value.text.url)
})

test('failed forget stops new model use, preserves in-flight snapshots and reports that saved settings need another cleanup', async t => {
  const profile = await fixture(t), crypto = vault(), store = await createModelSettingsStore(profile, crypto)
  await store.update({ text, vision: {} }, { remember: true })
  let denyCleanup = true
  const { unlink } = await import('node:fs/promises')
  const failed = await createModelSettingsStore(profile, crypto, { unlink: async path => { if (denyCleanup) throw new Error('EACCES'); return unlink(path) } })
  const provider = createPersistentSettingsProvider(failed.snapshot(), (action, value) => action === 'clear' ? failed.clear() : failed.update(value.configuration, { remember: value.remember }))
  const old = taskSettings(provider)
  await assert.rejects(modelSession(provider).update({ clear: true }), { status: 503 })
  assert.equal(provider.read().text.key, '')
  assert.equal(old.text.key, text.key); assert.equal(old.authorization.text.aborted, false)
  assert.match(provider.read().settingsWarning, /重开可能恢复/)
  denyCleanup = false
  await modelSession(provider).update({ ...text, remember: false })
  assert.equal(provider.read().settingsWarning, '')
  assert.equal((await createModelSettingsStore(profile, crypto)).snapshot().text.key, '')
})

test('revocation during a slow protected save cancels old snapshots and clears saved credentials before success', async t => {
  const profile = await fixture(t), crypto = vault(), entered = Promise.withResolvers(), release = Promise.withResolvers()
  const store = await createModelSettingsStore(profile, { ...crypto, encrypt: async key => { entered.resolve(); await release.promise; return crypto.encrypt(key) } })
  const provider = createPersistentSettingsProvider(store.snapshot(), (action, value) => action === 'update' ? store.update(value.configuration, { remember: value.remember }) : store.revoke(value.scope))
  const old = taskSettings(provider), session = modelSession(provider)
  const updating = session.update({ ...text, remember: true })
  const rejected = assert.rejects(updating, /授权已撤销/)
  await entered.promise
  const revoking = session.revoke({ scope: 'all' })
  assert.equal(old.authorization.text.aborted, true)
  release.resolve(); await rejected; await revoking
  assert.equal(provider.read().text.key, '')
  assert.equal((await createModelSettingsStore(profile, crypto)).snapshot().text.key, '')
  assert.deepEqual(await readdir(profile), [])
  await session.update({ ...text, remember: false })
  assert.equal(taskSettings(provider).authorization.text.aborted, false)
  assert.equal(old.authorization.text.aborted, true)
})
