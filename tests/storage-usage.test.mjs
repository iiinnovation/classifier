import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, mkdir, readdir, lstat, rm, symlink, link } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createStore } from '../apps/api/src/store.mjs'
import { migrateLibrary } from '../apps/api/src/storage-maintenance.mjs'
import { storageUsage } from '../apps/api/src/storage-usage.mjs'
import { testApp } from './helpers/test-app.mjs'

async function fixture(t, storage = 'json') {
  const root = await mkdtemp(join(tmpdir(), 'classifier-storage-usage-')), json = join(root, 'json'), store = await createStore(json)
  let current = store
  t.after(async () => { current.close?.(); await rm(root, { recursive: true, force: true }) })
  const document = { id: randomUUID(), createdAt: new Date().toISOString(), title: '含中文原文', sections: [], references: [] }
  const note = { id: randomUUID(), createdAt: document.createdAt, topicId: randomUUID(), documentId: document.id, field: '笔记', content: '当前正文', evidence: [], archived: true, history: [{ content: '第一版', evidence: [] }, { content: '第二版', evidence: [] }] }
  const topic = { id: note.topicId, createdAt: document.createdAt, title: '用量测试', documents: [{ documentId: document.id }] }
  await store.write('documents', document); await store.write('topics', topic); await store.write('notes', note); await store.saveOriginal(document.id, Buffer.from('原始文件 bytes'))
  let directory = json
  if (storage === 'sqlite') { directory = join(root, 'sqlite'); await migrateLibrary(json, directory, join(root, 'migration-backup')); current = await createStore(directory) }
  const backups = join(root, 'managed-backups'); await mkdir(join(backups, 'previous'), { recursive: true }); await writeFile(join(backups, 'previous', 'kept.bin'), 'saved backup')
  await mkdir(join(directory, 'quarantine'), { recursive: true }); await writeFile(join(directory, 'quarantine', 'retained.bin'), 'bad original bytes')
  return { root, directory, backups, document, note, topic, inspectRecordBodies: current.inspectRecordBodies }
}
async function inventory(directory) {
  const entries = {}
  async function walk(path, prefix = '') {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const full = join(path, item.name), key = prefix + item.name
      if (item.isDirectory()) await walk(full, key + '/')
      // SQLite's existing shared-memory coordination bytes may change during a
      // SELECT. Still check its presence/length, and every persistent file hash.
      else if (item.isFile()) entries[key] = { size: (await lstat(full)).size, ...(key === 'library.sqlite-shm' ? {} : { hash: createHash('sha256').update(await readFile(full)).digest('hex') }) }
    }
  }
  await walk(directory); return entries
}

for (const storage of ['json', 'sqlite']) test(`${storage} usage reconciles file categories, history and managed backups without modifying data`, async t => {
  const f = await fixture(t, storage), before = await inventory(f.directory), backupBefore = await inventory(f.backups)
  const value = await storageUsage(f.directory, { managedBackupDir: f.backups, inspectRecordBodies: f.inspectRecordBodies })
  assert.equal(value.complete, true); assert.equal(value.storage, storage); assert.equal(value.readOnly, true)
  assert.equal(value.library.bytes, Object.values(before).reduce((sum, file) => sum + file.size, 0))
  assert.equal(value.library.bytes, value.library.categories.reduce((sum, group) => sum + group.bytes, 0))
  assert.equal(value.library.files, Object.keys(before).length)
  assert.equal(value.library.categories.find(group => group.id === 'originals').bytes, Buffer.byteLength('原始文件 bytes'))
  assert.equal(value.library.categories.find(group => group.id === 'quarantine').bytes, Buffer.byteLength('bad original bytes'))
  assert.equal(value.managedBackups.bytes, Buffer.byteLength('saved backup'))
  assert.equal(value.records.count, 3); assert.equal(value.records.archived, 1); assert.equal(value.records.historyVersions, 2)
  const { history, ...current } = f.note
  assert.equal(value.records.currentBytes, Buffer.byteLength(JSON.stringify(f.document)) + Buffer.byteLength(JSON.stringify(f.topic)) + Buffer.byteLength(JSON.stringify(current)))
  assert.equal(value.records.historyBytes, history.reduce((sum, version) => sum + Buffer.byteLength(JSON.stringify(version)), 0))
  assert.deepEqual(await inventory(f.directory), before); assert.deepEqual(await inventory(f.backups), backupBefore)
  assert.ok(value.unmeasured.some(text => text.includes('ZIP')))
  assert.ok(value.notices.some(text => text.includes('归档') && text.includes('不释放空间')))
})

for (const storage of ['json', 'sqlite']) test(`${storage} corrupt records remain counted as files while content estimates are explicitly incomplete`, async t => {
  const f = await fixture(t, storage), raw = '{broken record', id = randomUUID()
  if (storage === 'json') await writeFile(join(f.directory, 'notes', id + '.json'), raw)
  else {
    const db = new DatabaseSync(join(f.directory, 'library.sqlite')); db.exec('PRAGMA ignore_check_constraints=ON')
    db.prepare('INSERT INTO records(bucket,id,body) VALUES(?,?,?)').run('notes', id, raw); db.close()
  }
  const before = await inventory(f.directory), value = await storageUsage(f.directory, { inspectRecordBodies: f.inspectRecordBodies })
  assert.equal(value.complete, false); assert.equal(value.records.complete, false); assert.equal(value.records.count, 3)
  assert.ok(value.issues.some(issue => issue.code === 'RECORD_UNREADABLE'))
  assert.deepEqual(await inventory(f.directory), before, 'usage must not create quarantine copies or rewrite damaged bytes')
})

test('usage excludes symlink targets, counts hardlinks by path, and preserves explicit unmeasured scopes', async t => {
  const f = await fixture(t), outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'secret'), Buffer.alloc(8192))
  await symlink(outside, join(f.directory, 'external')); await symlink(join(outside, 'secret'), join(f.directory, 'originals', 'linked'))
  await link(join(f.directory, 'originals', f.document.id), join(f.directory, 'originals', 'hardlinked'))
  const value = await storageUsage(f.directory)
  assert.equal(value.complete, false); assert.equal(value.managedBackups.available, false); assert.equal(value.managedBackups.bytes, null)
  assert.equal(value.library.categories.find(group => group.id === 'originals').bytes, Buffer.byteLength('原始文件 bytes') * 2)
  assert.equal(value.issues.filter(issue => issue.code === 'SYMLINK_SKIPPED').length, 2)
  assert.ok(!JSON.stringify(value).includes('secret'))
  const overlapping = await storageUsage(f.directory, { managedBackupDir: f.root })
  assert.ok(overlapping.issues.some(issue => issue.code === 'OVERLAPPING_SCOPE')); assert.equal(overlapping.managedBackups.available, false)
})

test('usage scan limits return partial amounts without presenting incomplete record counts as complete', async t => {
  const f = await fixture(t)
  for (const limits of [{ entries: 1 }, { milliseconds: -1 }, { recordBytes: 1 }]) {
    const value = await storageUsage(f.directory, { limits })
    assert.equal(value.complete, false); assert.equal(value.records.complete, false)
    assert.ok(value.issues.some(issue => ['SCAN_LIMIT', 'RECORD_SCAN_LIMIT'].includes(issue.code)))
  }
  const missing = join(f.root, 'no-backups-yet'), value = await storageUsage(f.directory, { managedBackupDir: missing })
  assert.equal(value.managedBackups.available, true); assert.equal(value.managedBackups.bytes, 0)
  await assert.rejects(lstat(missing), { code: 'ENOENT' })
})

test('storage usage API is read-only, uncached and never accepts caller-supplied filesystem scopes', async t => {
  const app = await testApp(); t.after(() => app.close())
  const response = await app.request('/api/storage-usage?root=/&managedBackupDir=/')
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store')
  const value = await response.json(); assert.equal(value.records.count, 1); assert.equal(value.managedBackups.available, false)
  assert.ok(value.library.bytes > 0); assert.ok(!JSON.stringify(value).includes(app.dataDir))
  for (const method of ['POST', 'DELETE']) assert.equal((await app.request('/api/storage-usage', { method })).status, 404)
  assert.equal((await app.request(`/api/documents/${app.legacy.id}`)).status, 200)
})
