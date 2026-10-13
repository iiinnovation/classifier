import test from 'node:test'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { createImports, parseInWorker } from '../apps/api/src/imports.mjs'
import { createRuns } from '../apps/api/src/runs.mjs'
import { createSettingsProvider } from '../apps/api/src/settings.mjs'
import { createStore } from '../apps/api/src/store.mjs'
import { testApp, upload } from './helpers/test-app.mjs'

test('parser completion removes the caller abort listener', async () => {
  const controller = new AbortController()
  await parseInWorker({ fileName: 'test.txt', bytes: Buffer.from('research results') }, { signal: controller.signal })
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  controller.abort()
})

test('isolated parser completion and cancellation remove the caller abort listener', async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController()
    const parsing = parseInWorker({ fileName: 'test.txt', bytes: Buffer.from('research results') }, { isolate: true, signal: controller.signal })
    if (cancel) { controller.abort(new Error('cancel isolated parser')); await assert.rejects(parsing, /cancel isolated parser/) }
    else await parsing
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  }
})

test('isolated parser launch failure settles promptly without waiting for exit', { timeout: 5000 }, async () => {
  const executable = process.execPath
  let parsing
  try {
    process.execPath = '/nonexistent-classifier-runtime'
    parsing = parseInWorker({ fileName: 'test.txt', bytes: Buffer.from('research') }, { isolate: true })
  } finally { process.execPath = executable }
  await assert.rejects(parsing, error => error.code === 'ENOENT')
})

for (const kind of ['imports', 'runs']) {
  test(`${kind} shutdown waits for an admitted task still writing its queued record`, async () => {
    const queued = Promise.withResolvers(), release = Promise.withResolvers(), records = []
    const store = { async write(collection, record) {
      if (record.status === 'queued') { queued.resolve(); await release.promise }
      records.push(structuredClone(record))
    } }
    const manager = kind === 'imports' ? createImports(store, {}, createSettingsProvider()) : createRuns(store)
    let workCalls = 0
    const starting = kind === 'imports'
      ? manager.start({ fileName: 'test.txt', bytes: Buffer.from('research') })
      : manager.startJob({}, async () => { workCalls++; return {} })
    await queued.promise
    let stopped = false
    const stopping = manager.stop().then(() => { stopped = true })
    try {
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(stopped, false, 'shutdown must wait for the in-flight admission write')
    } finally { release.resolve(); await starting; await stopping }
    assert.equal(records.at(-1).status, 'cancelled')
    assert.equal(workCalls, 0, 'shutdown must not begin a model call')
  })
}

test('shutdown rejects an import still resolving its topic', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const manager = createImports({ write: async () => {} }, { async get() { entered.resolve(); await release.promise; return { id: 'topic' } } })
  const starting = manager.start({ topicId: 'topic', fileName: 'test.txt', bytes: Buffer.from('research') })
  await entered.promise
  await manager.stop()
  release.resolve()
  await assert.rejects(starting, error => error.status === 503)
})

for (const action of ['cancel', 'stop']) {
  test(`import ${action} during original write removes the file and does not commit a document`, async () => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers(), records = [], removed = []
    const store = {
      async write(bucket, record) { records.push([bucket, structuredClone(record)]) },
      async saveOriginal(id) { entered.resolve(id); await release.promise },
      async removeOriginal(id) { removed.push(id) },
    }
    const imports = createImports(store, {}, createSettingsProvider())
    const job = await imports.start({ fileName: 'research.txt', bytes: Buffer.from('Research content') })
    const originalId = await entered.promise
    if (action === 'cancel') assert.equal(imports.cancel(job.id), true)
    const stopping = imports.stop()
    release.resolve()
    await stopping
    assert.deepEqual(removed, [originalId])
    assert.equal(records.some(([bucket]) => bucket === 'documents'), false)
    assert.equal(records.at(-1)[1].status, 'cancelled')
  })
}

test('shutdown waits for an import that has begun committing its document', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), records = []
  const store = {
    async write(bucket, record) {
      if (bucket === 'documents') { entered.resolve(); await release.promise }
      records.push([bucket, structuredClone(record)])
    },
    async saveOriginal() {},
  }
  const imports = createImports(store, {}, createSettingsProvider())
  const job = await imports.start({ fileName: 'research.txt', bytes: Buffer.from('Research content') })
  await entered.promise
  assert.equal(imports.cancel(job.id), false)
  let stopped = false
  const stopping = imports.stop().then(() => { stopped = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(stopped, false)
  release.resolve()
  await stopping
  assert.equal(records.at(-1)[1].status, 'completed')
})

test('shutdown during synchronous original write removes it before returning', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), writes = [], removed = []
  const app = await testApp({ storeFactory: async dataDir => {
    const store = await createStore(dataDir)
    return { ...store,
      async saveOriginal(id, bytes) { await store.saveOriginal(id, bytes); entered.resolve(id); await release.promise },
      async removeOriginal(id) { removed.push(id); await store.removeOriginal(id) },
      async write(bucket, record) { if (bucket === 'documents') writes.push(record.id); return store.write(bucket, record) },
    }
  } })
  const request = app.request('/api/documents', upload('Research content', 'research.txt')).catch(() => null)
  let closing
  try {
    const originalId = await entered.promise
    closing = app.close()
    await new Promise(resolve => setImmediate(resolve))
    release.resolve()
    await Promise.all([closing, request])
    assert.deepEqual(removed, [originalId])
    assert.deepEqual(writes, [])
  } finally {
    release.resolve()
    if (!closing) await app.close()
    else await closing
  }
})
