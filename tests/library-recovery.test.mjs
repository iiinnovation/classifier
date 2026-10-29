import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, access, symlink, readdir } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createStore } from '../apps/api/src/store.mjs'
import { acquireDataLock } from '../apps/api/src/data-lock.mjs'
import { migrateLibrary, backupLibrary, verifyBackup } from '../apps/api/src/storage-maintenance.mjs'
import { backupZipLibrary } from '../apps/api/src/storage-zip.mjs'
import { inspectLibrary } from '../apps/api/src/library-inspection.mjs'
import { previewLibraryRecovery, recoverLibrary, preserveLibrary } from '../apps/api/src/library-recovery.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
async function fixture(t, storage = 'json', format = 'directory') {
  const root = await mkdtemp(join(tmpdir(), 'classifier-recovery-')); t.after(() => rm(root, { recursive: true, force: true }))
  const sourceJson = join(root, 'json'), store = await createStore(sourceJson), id = randomUUID(), goodId = randomUUID(), otherId = randomUUID(), docId = randomUUID(), createdAt = new Date().toISOString()
  const original = Buffer.from('original research'), document = { id: docId, title: 'Document', createdAt, sections: [], references: [], source: { sha256: sha(original) } }
  const record = { id, documentId: docId, createdAt, content: 'backup note', evidence: [], revision: 2, history: [{ revision: 1, content: 'earlier note', evidence: [] }] }
  await store.saveOriginal(docId, original); await store.write('documents', document)
  await store.write('notes', record); await store.write('notes', { ...record, id: goodId }); await store.write('notes', { ...record, id: otherId })
  let source = sourceJson
  if (storage === 'sqlite') { source = join(root, 'sqlite'); await migrateLibrary(sourceJson, source, join(root, 'migration-backup')) }
  const backup = join(root, format === 'zip' ? 'backup.zip' : 'backup')
  if (format === 'zip') await backupZipLibrary(source, backup); else await backupLibrary(source, backup)
  async function damage(bucket, target, bytes = storage === 'json' ? '{private damaged record' : '{}') {
    if (storage === 'json') await writeFile(join(source, bucket, target + '.json'), bytes)
    else { const db = new DatabaseSync(join(source, 'library.sqlite')); db.prepare('UPDATE records SET body=? WHERE bucket=? AND id=?').run(bytes, bucket, target); db.close() }
    return bytes
  }
  async function raw(bucket, target, from = source) {
    if (storage === 'json') return readFile(join(from, bucket, target + '.json'), 'utf8')
    const db = new DatabaseSync(join(from, 'library.sqlite'), { readOnly: true })
    try { return db.prepare('SELECT body FROM records WHERE bucket=? AND id=?').get(bucket, target).body } finally { db.close() }
  }
  return { root, source, backup, format, id, goodId, otherId, docId, original, document, record, damage, raw,
    preview: () => previewLibraryRecovery(source, backup, { format }),
    apply: (plan, selections, suffix = '') => recoverLibrary(source, backup, join(root, 'recovered' + suffix), join(root, 'preserved' + suffix), { format, revision: plan.revision, selections }),
  }
}

for (const storage of ['json', 'sqlite']) for (const format of ['directory', 'zip']) test(`${storage} selective recovery from ${format} preserves newer unrelated edits and unselected damaged bytes`, async t => {
  const f = await fixture(t, storage, format), damaged = await f.damage('notes', f.id)
  await f.damage('notes', f.otherId); await writeFile(join(f.source, 'originals', f.docId), 'bad original')
  const current = await createStore(f.source)
  await current.update('notes', f.goodId, value => ({ ...value, content: 'newer unrelated edit' })); current.close?.()
  const plan = await f.preview()
  assert.equal(plan.itemCount, 3); assert.ok(!JSON.stringify(plan).includes('private'))
  const selections = ['notes/' + f.id, 'originals/' + f.docId].map(target => plan.items.find(item => item.target === target).choices[0].key)
  const result = await f.apply(plan, selections)
  assert.equal(result.restored, 2); assert.equal(result.remainingDamagedRecords, 1)
  assert.equal(await f.raw('notes', f.id), damaged); assert.equal(await readFile(join(f.source, 'originals', f.docId), 'utf8'), 'bad original')
  const restored = await createStore(result.destination)
  try {
    assert.deepEqual(await restored.read('notes', f.id), f.record)
    assert.equal((await restored.read('notes', f.goodId)).content, 'newer unrelated edit')
    assert.deepEqual(await restored.original(f.docId), f.original)
    await assert.rejects(restored.read('notes', f.otherId), { code: 'RECORD_CORRUPT' })
  } finally { restored.close?.() }
  assert.equal(await f.raw('notes', f.id, result.preservation), damaged)
  assert.equal(await readFile(join(result.preservation, 'originals', f.docId), 'utf8'), 'bad original')
  const preservation = JSON.parse(await readFile(join(result.preservation, 'preservation-manifest.json'), 'utf8'))
  assert.equal(preservation.databaseIntegrityNotGuaranteed, true)
  await assert.rejects(verifyBackup(result.preservation))
  const report = JSON.parse(await readFile(join(result.destination, result.report), 'utf8'))
  assert.equal(report.selections.length, 2); assert.ok(!JSON.stringify(report).includes('private damaged record'))
})

test('JSON recovery lets the user choose interrupted versions without automatically replacing a healthy saved record', async t => {
  const f = await fixture(t), bytes = JSON.stringify({ ...f.record, revision: 3, content: 'interrupted newer edit' })
  const temporary = join(f.source, 'notes', f.id + '.json.' + randomUUID() + '.tmp')
  await writeFile(temporary, bytes)
  const plan = await f.preview(), item = plan.items.find(item => item.target === 'notes/' + f.id)
  assert.equal(item.currentReadable, true); assert.equal(item.choices.length, 1); assert.equal(item.choices[0].from, 'temporary')
  const result = await f.apply(plan, [item.choices[0].key])
  assert.equal((await createStore(f.source)).read instanceof Function, true)
  assert.equal(JSON.parse(await f.raw('notes', f.id)).content, 'backup note')
  assert.equal(await readFile(temporary, 'utf8'), bytes)
  assert.equal(await readFile(join(result.destination, 'notes', f.id + '.json'), 'utf8'), bytes)
  await assert.rejects(access(join(result.destination, 'notes', temporary.split('/').at(-1))))
  assert.equal((await (await createStore(result.destination)).health()).issueCount, 0)
})

test('record recovery bundles its matching original and never substitutes an unrelated original version', async t => {
  const f = await fixture(t)
  await f.damage('documents', f.docId); await writeFile(join(f.source, 'originals', f.docId), 'newer or damaged bytes')
  const plan = await f.preview(), candidate = plan.items.find(item => item.target === 'documents/' + f.docId).choices[0]
  assert.equal(candidate.includesOriginal, true)
  const result = await f.apply(plan, [candidate.key])
  const restored = await createStore(result.destination)
  assert.deepEqual(await restored.document(f.docId), f.document); assert.deepEqual(await restored.original(f.docId), f.original)
  const another = await fixture(t)
  await writeFile(join(another.source, 'documents', another.docId + '.json'), JSON.stringify({ ...another.document, source: { sha256: sha('genuinely newer original') } }))
  await writeFile(join(another.source, 'originals', another.docId), 'damaged')
  assert.equal((await another.preview()).items.find(item => item.target === 'originals/' + another.docId).choices.length, 0)
})

test('preview revisions reject changed selected bytes or changed backups but retain later unrelated edits', async t => {
  const f = await fixture(t); await f.damage('notes', f.id)
  const plan = await f.preview(), selection = plan.items[0].choices[0].key
  await f.damage('notes', f.id, '{different damage')
  await assert.rejects(f.apply(plan, [selection]), /发生变化/); await assert.rejects(access(join(f.root, 'preserved')))
  const updated = await f.preview(), current = await createStore(f.source)
  await current.update('notes', f.goodId, value => ({ ...value, content: 'edit while preview is open' }))
  const result = await f.apply(updated, [updated.items[0].choices[0].key])
  assert.equal((await (await createStore(result.destination)).read('notes', f.goodId)).content, 'edit while preview is open')
  const g = await fixture(t); await g.damage('notes', g.id)
  const originalPlan = await g.preview(), path = join(g.backup, 'notes', g.id + '.json')
  const bytes = JSON.stringify({ ...g.record, content: 'changed valid backup' }); await writeFile(path, bytes)
  const manifestPath = join(g.backup, 'backup-manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const file = manifest.files.find(file => file.path === 'notes/' + g.id + '.json'); file.size = Buffer.byteLength(bytes); file.sha256 = sha(bytes)
  await writeFile(manifestPath, JSON.stringify(manifest))
  await assert.rejects(g.apply(originalPlan, [originalPlan.items[0].choices[0].key]), /发生变化/)
})

test('recovery rejects ambiguous choices and active ownership before preserving or writing new libraries', async t => {
  const f = await fixture(t); await f.damage('notes', f.id)
  const temporary = f.id + '.json.' + randomUUID() + '.tmp'; await writeFile(join(f.source, 'notes', temporary), JSON.stringify(f.record))
  const plan = await f.preview(), choices = plan.items[0].choices.map(item => item.key)
  await assert.rejects(f.apply(plan, choices), /同一记录/)
  await assert.rejects(f.apply(plan, ['0'.repeat(64)]), /未知项目/)
  await assert.rejects(f.apply(plan, [choices[0], choices[0]]), /有效/)
  await assert.rejects(access(join(f.root, 'preserved')))
  const owner = await acquireDataLock(f.source)
  try {
    await assert.rejects(f.preview(), { code: 'DATA_DIRECTORY_LOCKED' })
    await assert.rejects(f.apply(plan, [choices[0]]), { code: 'DATA_DIRECTORY_LOCKED' })
    await assert.rejects(preserveLibrary(f.source, join(f.root, 'busy-preserved')), { code: 'DATA_DIRECTORY_LOCKED' })
  } finally { owner.release() }
})

test('raw preservation copies corrupt SQLite and sidecar bytes without claiming database repair or copying credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'classifier-preserve-')); t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source'); await mkdir(source)
  await writeFile(join(source, 'library-manifest.json'), JSON.stringify({ formatVersion: 1, storage: 'sqlite', state: 'ready' }))
  const files = ['library.sqlite', 'library.sqlite-wal', 'library.sqlite-shm', 'library.sqlite-journal']
  for (const name of files) await writeFile(join(source, name), 'private corrupt ' + name)
  await writeFile(join(source, '.env'), 'API_KEY=secret')
  const result = await preserveLibrary(source, join(root, 'preserved'))
  assert.equal(result.manifest.databaseIntegrityNotGuaranteed, true)
  for (const name of files) assert.deepEqual(await readFile(join(source, name)), await readFile(join(result.destination, name)))
  await assert.rejects(access(join(result.destination, '.env')))
})

test('preservation refuses symlinks and a recovery destination failure leaves originals and the complete preservation copy intact', async t => {
  const f = await fixture(t), external = join(f.root, 'external.txt')
  await writeFile(external, 'external'); await symlink(external, join(f.source, 'notes', randomUUID() + '.json'))
  await assert.rejects(preserveLibrary(f.source, join(f.root, 'unsafe')), /符号链接/)
  assert.equal(await readFile(external, 'utf8'), 'external')
  const g = await fixture(t); await g.damage('notes', g.id)
  const plan = await g.preview(), target = join(g.root, 'recovered'); await mkdir(target); await writeFile(join(target, 'sentinel'), 'existing library')
  await assert.rejects(g.apply(plan, [plan.items[0].choices[0].key]), /已存在/)
  assert.equal(await readFile(join(target, 'sentinel'), 'utf8'), 'existing library')
  assert.equal(await g.raw('notes', g.id, join(g.root, 'preserved')), '{private damaged record')
})

test('recovery CLI previews choices and applies an explicit selection file without changing the source', async t => {
  const f = await fixture(t), damaged = await f.damage('notes', f.id)
  const cli = fileURLToPath(new URL('../tools/storage-maintenance.mjs', import.meta.url)), run = async args => JSON.parse((await promisify(execFile)(process.execPath, [cli, ...args])).stdout)
  const plan = await run(['recovery-preview', f.source, f.backup])
  plan.selections = [plan.items[0].choices[0].key]
  const selectionFile = join(f.root, 'selection.json'); await writeFile(selectionFile, JSON.stringify(plan))
  const destination = join(f.root, 'cli-recovered'), preservation = join(f.root, 'cli-preserved')
  const result = await run(['recover', f.source, f.backup, destination, preservation, selectionFile])
  assert.equal(result.restored, 1); assert.equal(await f.raw('notes', f.id), damaged)
  assert.deepEqual(await (await createStore(result.destination)).read('notes', f.id), f.record)
})

for (const storage of ['json', 'sqlite']) test(`${storage} selected originals supersede old removal intent only in the recovered copy`, async t => {
  const f = await fixture(t, storage), operationId = randomUUID(), operation = { id: operationId, documentId: f.docId, path: 'originals/' + f.docId, operation: 'remove', state: 'pending', createdAt: new Date().toISOString() }
  await writeFile(join(f.source, 'originals', f.docId), 'damaged original')
  if (storage === 'json') await writeFile(join(f.source, '.file-operations', operationId + '.json'), JSON.stringify(operation))
  else {
    const db = new DatabaseSync(join(f.source, 'library.sqlite'))
    db.prepare('INSERT INTO file_operations(id,operation,document_id,path,state,created_at) VALUES(?,?,?,?,?,?)').run(operationId, 'remove', f.docId, operation.path, 'pending', operation.createdAt); db.close()
  }
  const plan = await f.preview(), item = plan.items.find(item => item.type === 'original'), result = await f.apply(plan, [item.choices[0].key])
  const recovered = await createStore(result.destination)
  try { assert.deepEqual(await recovered.original(f.docId), f.original) } finally { recovered.close?.() }
  assert.equal(result.supersededFileOperations, 1)
  assert.ok((await inspectLibrary(result.destination)).issues.some(issue => issue.code === 'superseded-file-operation' && issue.severity === 'info'))
  if (storage === 'json') assert.equal(JSON.parse(await readFile(join(f.source, '.file-operations', operationId + '.json'), 'utf8')).state, 'pending')
  else { const db = new DatabaseSync(join(f.source, 'library.sqlite'), { readOnly: true }); assert.equal(db.prepare('SELECT state FROM file_operations WHERE id=?').get(operationId).state, 'pending'); db.close() }
})

test('SIGKILL before recovery publication preserves source bytes and a verified preservation copy, then permits a fresh retry', async t => {
  const f = await fixture(t), damaged = await f.damage('notes', f.id), plan = await f.preview()
  plan.selections = [plan.items[0].choices[0].key]
  const selection = join(f.root, 'selection.json'), destination = join(f.root, 'crash-target'), preservation = join(f.root, 'crash-preserved')
  await writeFile(selection, JSON.stringify(plan))
  const child = spawn(process.execPath, [fileURLToPath(new URL('./helpers/recovery-crash.mjs', import.meta.url)), f.source, f.backup, destination, preservation, selection], { stdio: 'ignore' })
  const [code, signal] = await once(child, 'exit')
  assert.equal(signal, 'SIGKILL', 'child exit code: ' + code)
  assert.equal(await f.raw('notes', f.id), damaged)
  assert.equal(await readFile(join(preservation, 'notes', f.id + '.json'), 'utf8'), damaged)
  const partials = (await readdir(f.root)).filter(name => name.startsWith('crash-target.partial-'))
  assert.equal(partials.length, 1); await assert.rejects(access(destination))
  const result = await f.apply(plan, plan.selections)
  assert.deepEqual(await (await createStore(result.destination)).read('notes', f.id), f.record)
  assert.equal(await f.raw('notes', f.id), damaged)
})
