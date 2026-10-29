import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, readFile, writeFile, access, mkdir, symlink, chmod, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createStore } from '../apps/api/src/store.mjs'
import { createApp } from '../apps/api/src/server.mjs'
import { prepareMigration, resumeMigration, migrationStatus, backupLibrary, restoreLibrary } from '../apps/api/src/storage-maintenance.mjs'
import { acquireDataLock } from '../apps/api/src/data-lock.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'classifier-migration-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'legacy'), target = join(root, 'sqlite'), backup = join(root, 'backup')
  const store = await createStore(source), id = randomUUID(), text = Buffer.from('Preserve original bytes and evidence history'), createdAt = new Date().toISOString()
  const document = { id, title: 'Migration recovery', createdAt, schemaVersion: 2, sections: [], source: { sha256: createHash('sha256').update(text).digest('hex') }, references: [{ id: 'ref_00001', text: text.toString() }] }
  await store.saveOriginal(id, text); await store.write('documents', document)
  const notes = []
  for (let i = 0; i < 205; i++) {
    const note = { id: randomUUID(), documentId: id, createdAt, revision: 2, content: 'Note ' + i, history: [{ revision: 1, content: 'Earlier ' + i, evidence: [] }], evidence: [{ documentId: id, reference: { id: 'ref_00001', text: text.toString() } }] }
    await store.write('notes', note); notes.push(note)
  }
  const prepared = await prepareMigration(source, target, backup)
  return { root, source, target, backup, store, document, text, notes, prepared }
}
async function crashAt(t, stage, phase) {
  const child = fork(new URL('./helpers/migration-child.mjs', import.meta.url), [stage, phase], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''; child.stderr.on('data', data => { stderr += data })
  const exited = once(child, 'exit')
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited } })
  const progress = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Migration checkpoint timed out: ' + stderr)) }, 15000)
    child.on('message', value => { clearTimeout(timeout); value.type === 'checkpoint' ? resolve(value.progress) : reject(new Error(JSON.stringify(value))) })
    child.once('exit', code => { clearTimeout(timeout); reject(new Error('Exited before checkpoint: ' + code + ' ' + stderr)) })
    child.once('error', error => { clearTimeout(timeout); reject(error) })
  })
  child.kill('SIGKILL'); const [, signal] = await exited
  assert.equal(signal, 'SIGKILL')
  return progress
}

for (const phase of ['validated', 'records', 'file-published', 'files', 'publishing', 'published', 'complete']) {
  test('D1 migration resumes after SIGKILL at ' + phase + ' without duplicating records or altering history', { timeout: 30000 }, async t => {
    const f = await fixture(t), original = await readFile(join(f.source, 'documents', f.document.id + '.json'))
    const progress = await crashAt(t, f.prepared.stage, phase)
    const status = await migrationStatus(f.prepared.stage)
    assert.equal(status.migrationId, f.prepared.migrationId)
    assert.equal(status.totalRecords, 206)
    if (phase === 'records') { assert.equal(progress.completedRecords, 100); assert.equal(status.completedRecords, 100) }
    if (phase === 'file-published') assert.equal(status.completedFiles, 0)
    if (phase !== 'complete') await assert.rejects(createApp({ dataDir: status.directory }), /迁移尚未完成/)
    if (!['published', 'complete'].includes(phase)) await assert.rejects(access(f.target))
    // The source can change after the snapshot. Resume must never mix those
    // later changes into the already selected migration snapshot.
    await f.store.write('documents', { ...f.document, title: 'Changed after snapshot' })
    const result = await resumeMigration(f.prepared.stage)
    assert.equal(result.migrationId, f.prepared.migrationId)
    const migrated = await createStore(f.target)
    try {
      assert.deepEqual(await migrated.document(f.document.id), f.document)
      assert.equal((await migrated.list('notes')).length, f.notes.length)
      for (const note of f.notes) assert.deepEqual(await migrated.read('notes', note.id), note)
      assert.deepEqual(await migrated.original(f.document.id), f.text)
      await migrated.update('documents', f.document.id, value => ({ ...value, title: 'Edit after migration' }))
    } finally { migrated.close() }
    assert.equal((await resumeMigration(f.target)).alreadyCompleted, true)
    const reopened = await createStore(f.target)
    try { assert.equal((await reopened.document(f.document.id)).title, 'Edit after migration') } finally { reopened.close() }
    assert.deepEqual(await readFile(join(f.backup, 'documents', f.document.id + '.json')), original)
    assert.equal((await f.store.document(f.document.id)).title, 'Changed after snapshot')
    assert.equal((await migrationStatus(f.prepared.stage)).phase, 'complete')
    if (phase === 'published') {
      await backupLibrary(f.target, join(f.root, 'after'))
      await restoreLibrary(join(f.root, 'after'), join(f.root, 'restored'))
      const restored = await createStore(join(f.root, 'restored'))
      try { assert.equal((await restored.list('notes')).length, 205) } finally { restored.close() }
    }
  })
}

test('D1 resume refuses changed snapshots, progress identity and destination conflicts', async t => {
  const f = await fixture(t), manifestPath = join(f.backup, 'backup-manifest.json'), bytes = await readFile(manifestPath)
  await writeFile(manifestPath, Buffer.concat([bytes, Buffer.from('\n')]))
  await assert.rejects(resumeMigration(f.prepared.stage), /备份清单已变化/)
  await writeFile(manifestPath, bytes)
  const owner = await acquireDataLock(f.prepared.stage)
  try { await assert.rejects(resumeMigration(f.prepared.stage), { code: 'DATA_DIRECTORY_LOCKED' }) } finally { owner.release() }
  await mkdir(f.target); await writeFile(join(f.target, 'keep.txt'), 'Unrelated target')
  await assert.rejects(resumeMigration(f.prepared.stage), /目标目录已存在/)
  assert.equal(await readFile(join(f.target, 'keep.txt'), 'utf8'), 'Unrelated target')
  await rm(f.target, { recursive: true })
  const descriptor = join(f.prepared.stage, 'migration-state.json'), state = JSON.parse(await readFile(descriptor, 'utf8'))
  await writeFile(descriptor, JSON.stringify({ ...state, records: state.records + 1 }))
  await assert.rejects(migrationStatus(f.prepared.stage), /身份不一致/)
  await writeFile(descriptor, JSON.stringify(state))
  await resumeMigration(f.prepared.stage)
})

test('D1 resumed migration refuses corrupted committed records and unexpected original files', async t => {
  const f = await fixture(t)
  await crashAt(t, f.prepared.stage, 'records')
  const db = new DatabaseSync(join(f.prepared.stage, 'library.sqlite'))
  db.prepare("UPDATE records SET body=? WHERE bucket='documents'").run(JSON.stringify({ ...f.document, title: 'Unexpected edit' })); db.close()
  await assert.rejects(resumeMigration(f.prepared.stage), /已迁移记录被修改/)
  await assert.rejects(access(f.target))
  const g = await fixture(t)
  await crashAt(t, g.prepared.stage, 'file-published')
  await writeFile(join(g.prepared.stage, 'originals', g.document.id), 'Unexpected bytes')
  await assert.rejects(resumeMigration(g.prepared.stage), /迁移目标文件与备份不一致/)
  assert.equal(await readFile(join(g.prepared.stage, 'originals', g.document.id), 'utf8'), 'Unexpected bytes')
})

test('D1 resume rejects symlink database paths and preserves external bytes', async t => {
  const f = await fixture(t), database = join(f.prepared.stage, 'library.sqlite'), saved = await readFile(database)
  const external = join(f.root, 'external.sqlite'); await writeFile(external, saved)
  await rm(database); await symlink(external, database)
  await assert.rejects(resumeMigration(f.prepared.stage), /数据库路径无效/)
  assert.deepEqual(await readFile(external), saved)
})

test('D1 migration resumes after a real original-directory permission failure and preserves partial work', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const f = await fixture(t), originals = join(f.prepared.stage, 'originals')
  await mkdir(originals); await chmod(originals, 0o500)
  try { await assert.rejects(resumeMigration(f.prepared.stage), error => error.code === 'EACCES' || error.code === 'EPERM') }
  finally { await chmod(originals, 0o700) }
  const status = await migrationStatus(f.prepared.stage)
  assert.equal(status.completedRecords, 206)
  assert.equal(status.completedFiles, 0)
  const attempts = await readdir(join(f.prepared.stage, 'migration-work'))
  assert.ok(attempts.length > 0)
  await resumeMigration(f.prepared.stage)
  const kept = await readdir(join(f.target, 'migration-work'))
  assert.ok(attempts.every(name => kept.includes(name)))
  assert.deepEqual(await readFile(join(f.target, 'originals', f.document.id)), f.text)
})

test('D1 two resume requests cannot own the same migration concurrently', async t => {
  const f = await fixture(t), started = Promise.withResolvers(), release = Promise.withResolvers()
  const first = resumeMigration(f.prepared.stage, { onProgress: async progress => {
    if (progress.phase === 'validated') { started.resolve(); await release.promise }
  } })
  await started.promise
  try { await assert.rejects(resumeMigration(f.prepared.stage), { code: 'DATA_DIRECTORY_LOCKED' }) }
  finally { release.resolve(); await first }
  assert.equal((await migrationStatus(f.prepared.stage)).phase, 'complete')
})
