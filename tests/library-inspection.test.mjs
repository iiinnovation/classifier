import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createStore } from '../apps/api/src/store.mjs'
import { acquireDataLock } from '../apps/api/src/data-lock.mjs'
import { inspectLibrary } from '../apps/api/src/library-inspection.mjs'
import { migrateLibrary } from '../apps/api/src/storage-maintenance.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'classifier-inspect-')), source = join(root, 'library')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await createStore(source), id = randomUUID(), bytes = Buffer.from('private research text')
  const document = { id, title: 'private title', createdAt: new Date().toISOString(), source: { sha256: createHash('sha256').update(bytes).digest('hex') } }
  await store.write('documents', document); await store.saveOriginal(id, bytes)
  return { root, source, store, document, bytes }
}

for (const storage of ['json', 'sqlite']) test(`inspection reads ${storage} without changing queued jobs or exposing research text`, async t => {
  const fixtureData = await fixture(t), { root, store } = fixtureData
  const run = { id: randomUUID(), createdAt: new Date().toISOString(), status: 'running' }
  await store.write('runs', run)
  let source = fixtureData.source
  if (storage === 'sqlite') { source = join(root, 'sqlite'); await migrateLibrary(fixtureData.source, source, join(root, 'backup')) }
  const path = storage === 'sqlite' ? join(source, 'library.sqlite') : join(source, 'runs', run.id + '.json')
  const before = await readFile(path)
  const result = await inspectLibrary(source)
  assert.equal(result.storage, storage); assert.equal(result.records, 2); assert.equal(result.originals, 1)
  assert.deepEqual(result.issues, [])
  assert.deepEqual(await readFile(path), before)
  assert.ok(!JSON.stringify(result).includes('private'))
})

test('inspection lists damaged records temporary files and missing originals without deleting any bytes', async t => {
  const { source, document, store } = await fixture(t)
  const broken = join(source, 'notes', randomUUID() + '.json'), temporary = join(source, 'notes', randomUUID() + '.json.recovery.tmp')
  await writeFile(broken, '{private broken content'); await writeFile(temporary, 'uncommitted private note')
  await writeFile(join(source, 'documents', '.DS_Store'), 'metadata')
  await store.removeOriginal(document.id)
  const result = await inspectLibrary(source)
  assert.deepEqual(result.issues.map(issue => issue.code).sort(), ['ignored-file', 'interrupted-write', 'invalid-record', 'missing-original'])
  assert.ok(!JSON.stringify(result).includes('private'))
  assert.equal(await readFile(broken, 'utf8'), '{private broken content')
  assert.equal(await readFile(temporary, 'utf8'), 'uncommitted private note')
})

test('inspection detects changed and unmatched originals and refuses active libraries', async t => {
  const { source, document } = await fixture(t)
  await writeFile(join(source, 'originals', document.id), 'changed')
  await writeFile(join(source, 'originals', randomUUID()), 'unmatched')
  const owner = await acquireDataLock(source)
  try { await assert.rejects(inspectLibrary(source), { code: 'DATA_DIRECTORY_LOCKED' }) } finally { owner.release() }
  const result = await inspectLibrary(source)
  assert.deepEqual(result.issues.map(issue => issue.code).sort(), ['original-mismatch', 'unmatched-original'])
})

test('inspection reports corrupt SQLite and future formats without modifying the database', async t => {
  const { root, source } = await fixture(t), target = join(root, 'sqlite')
  await migrateLibrary(source, target, join(root, 'backup'))
  const bytes = Buffer.from('invalid database'), database = join(target, 'library.sqlite')
  await writeFile(database, bytes)
  assert.equal((await inspectLibrary(target)).issues[0].code, 'invalid-database')
  assert.deepEqual(await readFile(database), bytes)
  await writeFile(join(target, 'library-manifest.json'), JSON.stringify({ formatVersion: 999 }))
  assert.equal((await inspectLibrary(target)).issues[0].code, 'invalid-layout')
})

test('inspection does not follow original or manifest symlinks', async t => {
  const { source, root, document, store } = await fixture(t), outside = join(root, 'outside')
  await writeFile(outside, 'private external content'); await store.removeOriginal(document.id)
  await symlink(outside, join(source, 'originals', document.id))
  assert.equal((await inspectLibrary(source)).issues[0].code, 'unsafe-path')
  await symlink(outside, join(source, 'library-manifest.json'))
  assert.equal((await inspectLibrary(source)).issues[0].code, 'unsafe-path')
  assert.equal(await readFile(outside, 'utf8'), 'private external content')
})

test('inspection CLI emits a checklist and returns 2 for damaged material', async t => {
  const { source, document, store } = await fixture(t)
  const cli = new URL('../tools/storage-maintenance.mjs', import.meta.url)
  const { fileURLToPath } = await import('node:url')
  const args = [fileURLToPath(cli), 'inspect', source]
  assert.equal(JSON.parse((await promisify(execFile)(process.execPath, args)).stdout).issueCount, 0)
  await store.removeOriginal(document.id)
  await assert.rejects(promisify(execFile)(process.execPath, args), error => {
    assert.equal(error.code, 2)
    assert.equal(JSON.parse(error.stdout).issues[0].code, 'missing-original')
    return true
  })
})
