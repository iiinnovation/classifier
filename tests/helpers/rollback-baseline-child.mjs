import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const [root, application] = process.argv.slice(2)
const moduleAt = name => import(pathToFileURL(join(application, 'apps/api/src', name + '.mjs')).href)
const { createStore } = await moduleAt('store'), { createApp } = await moduleAt('server')
const { initializeDatabase } = await moduleAt('sqlite-store')
const { backupLibrary } = await moduleAt('storage-maintenance')
const { backupZipLibrary } = await moduleAt('storage-zip')
const { backupCompatibility, restoreUnavailableLibrary } = await moduleAt('library-recovery')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
async function snapshot(directory) {
  const output = {}
  async function walk(folder = '') {
    for (const name of (await readdir(join(directory, folder))).sort()) {
      // Lock ownership and SQLite shared-memory coordination are not research
      // content. Preserve all original record/database/WAL bytes otherwise.
      if (name.startsWith('.classifier-lock') || name === 'library.sqlite-shm') continue
      const path = join(folder, name), info = await stat(join(directory, path))
      if (info.isDirectory()) await walk(path)
      else if (name !== 'library.sqlite-wal' || info.size) output[path] = digest(await readFile(join(directory, path)))
    }
  }
  await walk(); return output
}
const cases = [
  ['json', 'directory', 'format'], ['json', 'zip', 'format'],
  ['sqlite', 'directory', 'format'], ['sqlite', 'zip', 'format'],
  ['sqlite', 'directory', 'record'], ['sqlite', 'zip', 'database'],
]
const results = []
for (const [storage, format, boundary] of cases) {
  const name = [storage, format, boundary].join('-'), directory = join(root, name), source = join(directory, 'newer-library')
  const backup = join(directory, 'compatible-backup'), restored = join(directory, 'restored'), preservation = join(directory, 'preserved')
  await mkdir(source, { recursive: true })
  const manifest = { formatVersion: 1, recordVersion: 1, storage: 'sqlite', state: 'ready' }
  if (storage === 'sqlite') { initializeDatabase(join(source, 'library.sqlite')).close(); await writeFile(join(source, 'library-manifest.json'), JSON.stringify(manifest)) }
  const store = await createStore(source), createdAt = new Date().toISOString(), bytes = Buffer.from('Compatible backup evidence')
  const document = { id: randomUUID(), createdAt, title: 'Source', sections: [], references: [], source: { sha256: digest(bytes), byteLength: bytes.length } }
  const note = { id: randomUUID(), documentId: document.id, createdAt, content: 'Before upgrade', evidence: [], history: [{ content: 'Earlier saved version', evidence: [] }] }
  const job = { id: randomUUID(), createdAt, status: 'completed' }
  try { await store.saveOriginal(document.id, bytes); await store.write('documents', document); await store.write('notes', note); await store.write('runs', job) }
  finally { store.close?.() }
  if (format === 'zip') await backupZipLibrary(source, backup); else await backupLibrary(source, backup)
  const newer = await createStore(source)
  try {
    await newer.write('notes', { ...note, content: 'Edits after the backup', history: [...note.history, { content: note.content, evidence: [] }] })
    await newer.write('runs', { ...job, status: 'running' })
  } finally { newer.close?.() }
  // A future-format fixture is deliberate; this is NOT evidence that an
  // unreleased future binary has been tested with this rollback baseline.
  if (boundary === 'database') {
    const db = new DatabaseSync(join(source, 'library.sqlite')); db.exec('PRAGMA user_version=2'); db.close()
  } else await writeFile(join(source, 'library-manifest.json'), JSON.stringify({ ...manifest, [boundary === 'record' ? 'recordVersion' : 'formatVersion']: 2 }))
  await mkdir(join(source, 'future-content')); await writeFile(join(source, 'future-content', 'unknown-format.bin'), 'Unknown future content must remain in place')
  const original = await snapshot(source)
  await assert.rejects(createApp({ dataDir: source }), /版本|格式/)
  assert.deepEqual(await snapshot(source), original, 'refusal must precede task updates or research writes')
  const preview = await backupCompatibility(backup, { format })
  const result = await restoreUnavailableLibrary(source, backup, restored, preservation, { format, revision: preview.revision })
  assert.equal(result.storage, storage)
  assert.deepEqual(await snapshot(source), original, 'restore must retain the newer library including unknown paths')
  const recovered = await createStore(restored)
  try {
    assert.deepEqual(await recovered.read('notes', note.id), note)
    assert.deepEqual(await recovered.read('runs', job.id), job)
    assert.deepEqual(await recovered.original(document.id), bytes)
    await recovered.update('notes', note.id, value => ({ ...value, content: 'Continue work in the restored library' }))
  } finally { recovered.close?.() }
  const reopened = await createStore(restored)
  try { assert.equal((await reopened.read('notes', note.id)).content, 'Continue work in the restored library') } finally { reopened.close?.() }
  const preserved = JSON.parse(await readFile(join(preservation, 'preservation-manifest.json'), 'utf8'))
  for (const file of preserved.files) assert.equal(digest(await readFile(join(preservation, file.path))), file.sha256)
  assert.deepEqual(await snapshot(source), original)
  results.push({ name, storage, backupFormat: format, rejectedBoundary: boundary, passed: true, refusedBeforeTaskUpdates: true, recoveredSnapshotAndHistory: true, newerLibraryPreserved: true, unknownPathsPreserved: true, restoredLibraryEditableAfterRestart: true })
}
process.parentPort.postMessage({ type: 'completed', result: { cases: results, runtime: process.versions, source: application, futureVersionsAreFixtures: true } })
process.parentPort.on('message', () => process.exit(0))
