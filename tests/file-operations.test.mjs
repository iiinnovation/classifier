import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink, lstat, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { createStore } from '../apps/api/src/store.mjs'
import { initializeDatabase } from '../apps/api/src/sqlite-store.mjs'
import { migrateLibrary } from '../apps/api/src/storage-maintenance.mjs'
import { inspectLibrary } from '../apps/api/src/library-inspection.mjs'

async function root(t) { const value = await mkdtemp(join(tmpdir(), 'classifier-file-op-')); t.after(() => rm(value, { recursive: true, force: true })); return value }

async function sqliteLibrary(directory, legacy = false) {
  await mkdir(directory)
  const db = legacy ? new DatabaseSync(join(directory, 'library.sqlite')) : initializeDatabase(join(directory, 'library.sqlite'))
  if (legacy) db.exec('CREATE TABLE records(bucket TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),generation INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(bucket,id)); PRAGMA user_version=1;')
  db.close()
  await writeFile(join(directory, 'library-manifest.json'), JSON.stringify({ formatVersion: 1, storage: 'sqlite', state: 'ready', recordVersion: 1 }))
}

async function appendOperation(directory, storage, operation) {
  if (storage === 'json') await writeFile(join(directory, '.file-operations', operation.id + '.json'), JSON.stringify(operation))
  else {
    const db = new DatabaseSync(join(directory, 'library.sqlite'))
    try { db.prepare('INSERT INTO file_operations(id,operation,document_id,path,expected_sha256,state,created_at) VALUES(?,?,?,?,?,?,?)').run(operation.id, operation.operation, operation.documentId, operation.path, operation.expectedSha256 ?? null, operation.state, operation.createdAt) }
    finally { db.close() }
  }
}

const pendingRemove = id => ({ id: randomUUID(), operation: 'remove', documentId: id, path: `originals/${id}`, state: 'pending', createdAt: new Date().toISOString() })

test('JSON original writes and deletes leave redacted durable operation records', async t => {
  const directory = await root(t), store = await createStore(directory), id = randomUUID()
  await store.saveOriginal(id, Buffer.from('private original text'))
  const entries = await readdir(join(directory, '.file-operations')), operation = JSON.parse(await readFile(join(directory, '.file-operations', entries[0]), 'utf8'))
  assert.equal(operation.state, 'done'); assert.equal(operation.operation, 'write'); assert.equal(operation.documentId, id); assert.equal(operation.path, `originals/${id}`)
  assert.ok(!JSON.stringify(operation).includes('private'))
  await store.removeOriginal(id)
  const operations = await Promise.all((await readdir(join(directory, '.file-operations'))).map(name => readFile(join(directory, '.file-operations', name), 'utf8').then(JSON.parse)))
  assert.equal(operations.filter(operation => operation.operation === 'remove')[0].state, 'done')
})

test('pending JSON file operations recover idempotently on store startup and inspect reports failed operations', async t => {
  const directory = await root(t), store = await createStore(directory), id = randomUUID()
  await store.saveOriginal(id, Buffer.from('source'))
  const pending = { id: randomUUID(), operation: 'remove', documentId: id, path: `originals/${id}`, state: 'pending', createdAt: new Date().toISOString() }
  await writeFile(join(directory, '.file-operations', pending.id + '.json'), JSON.stringify(pending))
  const reopened = await createStore(directory)
  assert.equal((await inspectLibrary(directory)).fileOperations.pending, 0)
  assert.equal((await inspectLibrary(directory)).fileOperations.done, 2)
  await reopened.saveOriginal(id, Buffer.from('replacement'))
  const failed = { id: randomUUID(), operation: 'write', documentId: id, path: `originals/${id}`, expectedSha256: '0'.repeat(64), state: 'failed', error: 'EIO', createdAt: new Date().toISOString() }
  await writeFile(join(directory, '.file-operations', failed.id + '.json'), JSON.stringify(failed))
  const result = await inspectLibrary(directory)
  assert.equal(result.fileOperations.failed, 1); assert.ok(result.issues.some(issue => issue.code === 'failed-file-operation'))
})

test('SQLite file operation journal survives migration and startup recovery', async t => {
  const directory = await root(t), json = await createStore(join(directory, 'json')), id = randomUUID()
  await json.saveOriginal(id, Buffer.from('migrated original')); await json.write('documents', { id, title: 'document', createdAt: new Date().toISOString(), source: {} })
  const target = join(directory, 'sqlite'); await migrateLibrary(join(directory, 'json'), target, join(directory, 'backup'))
  const sqlite = await createStore(target); await sqlite.saveOriginal(id, Buffer.from('updated original')); sqlite.close()
  const reopened = await createStore(target), result = await inspectLibrary(target)
  assert.equal(result.fileOperations.pending, 0); assert.ok(result.fileOperations.done >= 1); reopened.close()
})

test('legacy SQLite v1 libraries add the journal without changing existing records or generations', async t => {
  const directory = join(await root(t), 'legacy'); await sqliteLibrary(directory, true)
  const topic = { id: randomUUID(), title: 'legacy research', createdAt: new Date().toISOString(), documents: [] }
  const db = new DatabaseSync(join(directory, 'library.sqlite'))
  db.prepare('INSERT INTO records(bucket,id,body,generation) VALUES(?,?,?,?)').run('topics', topic.id, JSON.stringify(topic), 7)
  db.close()
  for (let attempt = 0; attempt < 2; attempt++) {
    const store = await createStore(directory)
    try {
      assert.deepEqual(await store.read('topics', topic.id), topic)
      const id = randomUUID(); await store.saveOriginal(id, Buffer.from('original')); await store.removeOriginal(id)
    } finally { store.close() }
  }
  const check = new DatabaseSync(join(directory, 'library.sqlite'), { readOnly: true })
  try {
    assert.equal(check.prepare("SELECT generation FROM records WHERE bucket='topics' AND id=?").get(topic.id).generation, 7)
    assert.equal(check.prepare('SELECT count(*) AS count FROM file_operations').get().count, 4)
  } finally { check.close() }
})

for (const storage of ['json', 'sqlite']) {
  test(`${storage} recovery rejects paths outside the designated original and keeps other recovery working`, async t => {
    const parent = await root(t), directory = join(parent, 'library')
    if (storage === 'sqlite') await sqliteLibrary(directory)
    const store = await createStore(directory), id = randomUUID(), otherId = randomUUID()
    await store.saveOriginal(id, Buffer.from('preserve this original'))
    await store.saveOriginal(otherId, Buffer.from('valid pending removal'))
    store.close?.()
    const sentinel = join(parent, 'sentinel.txt'); await writeFile(sentinel, 'outside file')
    const unsafe = [
      { ...pendingRemove(id), path: '../sentinel.txt' },
      { ...pendingRemove(id), path: sentinel },
      { ...pendingRemove(otherId), path: `originals/${id}` },
      { ...pendingRemove(id), documentId: '../sentinel.txt' },
    ]
    for (const operation of unsafe) await appendOperation(directory, storage, operation)
    await appendOperation(directory, storage, pendingRemove(otherId))
    const reopened = await createStore(directory)
    try {
      assert.equal(await readFile(sentinel, 'utf8'), 'outside file')
      assert.equal((await reopened.original(id)).toString(), 'preserve this original')
      await assert.rejects(reopened.original(otherId), { code: 'ENOENT' })
    } finally { reopened.close?.() }
    const inspection = await inspectLibrary(directory)
    assert.ok(inspection.issues.some(issue => issue.code === 'invalid-file-operation'))
  })

  for (const link of ['file', 'directory']) test(`${storage} recovery refuses an original ${link} symlink`, async t => {
    const parent = await root(t), directory = join(parent, 'library'), outside = join(parent, 'outside'), id = randomUUID()
    if (storage === 'sqlite') await sqliteLibrary(directory)
    const store = await createStore(directory); store.close?.()
    await mkdir(outside); await writeFile(join(outside, id), 'external original')
    if (link === 'file') await symlink(join(outside, id), join(directory, 'originals', id))
    else {
      await rename(join(directory, 'originals'), join(directory, 'originals-saved'))
      await symlink(outside, join(directory, 'originals'), 'dir')
    }
    await appendOperation(directory, storage, pendingRemove(id))
    const reopened = await createStore(directory)
    try {
      assert.equal(await readFile(join(outside, id), 'utf8'), 'external original')
      assert.ok((await lstat(link === 'file' ? join(directory, 'originals', id) : join(directory, 'originals'))).isSymbolicLink())
    } finally { reopened.close?.() }
    assert.equal((await inspectLibrary(directory)).fileOperations.failed, 1)
  })

  test(`${storage} pending original writes recover by hash and remain idempotent`, async t => {
    const parent = await root(t), directory = join(parent, 'library'), id = randomUUID()
    if (storage === 'sqlite') await sqliteLibrary(directory)
    const store = await createStore(directory); await store.saveOriginal(id, Buffer.from('source')); store.close?.()
    await appendOperation(directory, storage, { ...pendingRemove(id), operation: 'write', expectedSha256: createHash('sha256').update('source').digest('hex') })
    await appendOperation(directory, storage, { ...pendingRemove(id), operation: 'write', expectedSha256: '0'.repeat(64) })
    for (let attempt = 0; attempt < 2; attempt++) {
      const reopened = await createStore(directory)
      try { assert.equal((await reopened.original(id)).toString(), 'source') } finally { reopened.close?.() }
      const result = await inspectLibrary(directory)
      assert.deepEqual(result.fileOperations, { done: 2, failed: 1, pending: 0 })
    }
  })
}

test('damaged JSON logs and symlink logs stay intact and visible without preventing startup or valid recovery', async t => {
  const directory = await root(t), store = await createStore(directory), id = randomUUID(), topic = { id: randomUUID(), title: 'accessible research', createdAt: new Date().toISOString() }
  await store.write('topics', topic); await store.saveOriginal(id, Buffer.from('pending removal'))
  const logs = join(directory, '.file-operations'), damaged = ['', '{"state":', 'null', '[]']
  const files = []
  for (const bytes of damaged) {
    const name = randomUUID() + '.json'; files.push(name); await writeFile(join(logs, name), bytes)
  }
  const external = join(directory, 'sentinel.json'), operation = pendingRemove(id), link = join(logs, operation.id + '.json')
  await writeFile(external, JSON.stringify(operation)); await symlink(external, link)
  await writeFile(join(logs, randomUUID() + '.tmp'), '{"interrupted":')
  await appendOperation(directory, 'json', pendingRemove(id))
  for (let attempt = 0; attempt < 2; attempt++) {
    const reopened = await createStore(directory)
    assert.deepEqual(await reopened.read('topics', topic.id), topic)
    await assert.rejects(reopened.original(id), { code: 'ENOENT' })
    for (let i = 0; i < damaged.length; i++) assert.equal(await readFile(join(logs, files[i]), 'utf8'), damaged[i])
    assert.equal(await readFile(external, 'utf8'), JSON.stringify(operation)); assert.ok((await lstat(link)).isSymbolicLink())
    const result = await inspectLibrary(directory)
    assert.equal(result.issues.filter(issue => issue.code === 'invalid-file-operation').length, damaged.length + 1)
  }
})

for (const fault of ['error', 'crash']) test(`JSON journal preserves recoverable pending intent after ${fault} before final publication`, async t => {
  const directory = await root(t), id = randomUUID()
  const child = spawn(process.execPath, [fileURLToPath(new URL('./helpers/file-operation-fault.mjs', import.meta.url)), directory, id, fault], { stdio: 'ignore' })
  const [code, signal] = await once(child, 'exit')
  if (fault === 'crash') assert.equal(signal, 'SIGKILL')
  else assert.equal(code, 0)
  const logs = join(directory, '.file-operations'), entries = (await readdir(logs)).filter(name => name.endsWith('.json'))
  assert.equal(entries.length, 1)
  assert.equal(JSON.parse(await readFile(join(logs, entries[0]), 'utf8')).state, 'pending')
  const reopened = await createStore(directory)
  assert.equal((await reopened.original(id)).toString(), 'crash boundary original')
  assert.equal(JSON.parse(await readFile(join(logs, entries[0]), 'utf8')).state, 'done')
})
