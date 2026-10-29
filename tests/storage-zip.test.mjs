import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile, writeFile, access, symlink, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { crc32, deflateRawSync } from 'node:zlib'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createStore } from '../apps/api/src/store.mjs'
import { acquireDataLock } from '../apps/api/src/data-lock.mjs'
import { migrateLibrary, backupLibrary, verifyBackup } from '../apps/api/src/storage-maintenance.mjs'
import { backupZipLibrary, verifyZipBackup, restoreZipLibrary } from '../apps/api/src/storage-zip.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
async function root(t) { const path = await mkdtemp(join(tmpdir(), 'classifier-zip-test-')); t.after(() => rm(path, { recursive: true, force: true })); return path }
const manifest = files => ({ backupVersion: 1, storage: 'json', formatVersion: 0, createdAt: '2026-10-23T00:00:00.000Z', files })

// Build intentionally malformed archives without a ZIP writer sanitizing names
// or repairing metadata. Payloads stay small even for forged size/count fields.
function rawZip(entries, { count = entries.length } = {}) {
  const local = [], central = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name), bytes = Buffer.from(entry.bytes || ''), comment = Buffer.from(entry.comment || ''), method = entry.method ?? 8
    const compressed = method === 0 ? bytes : deflateRawSync(bytes), header = Buffer.alloc(30), index = Buffer.alloc(46)
    const size = entry.size ?? bytes.length, checksum = entry.crc ?? crc32(bytes), flags = 0x800 | (entry.flags || 0)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(flags, 6); header.writeUInt16LE(method, 8)
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(size, 22); header.writeUInt16LE(name.length, 26)
    index.writeUInt32LE(0x02014b50); index.writeUInt16LE(0x314, 4); index.writeUInt16LE(20, 6); index.writeUInt16LE(flags, 8); index.writeUInt16LE(method, 10)
    index.writeUInt32LE(checksum, 16); index.writeUInt32LE(compressed.length, 20); index.writeUInt32LE(size, 24); index.writeUInt16LE(name.length, 28)
    index.writeUInt16LE(comment.length, 32)
    index.writeUInt32LE(entry.attributes ?? (0o100600 << 16) >>> 0, 38); index.writeUInt32LE(offset, 42)
    local.push(header, name, compressed); central.push(index, name, comment); offset += header.length + name.length + compressed.length
  }
  const table = Buffer.concat(central), end = Buffer.alloc(22), zip64 = []
  end.writeUInt32LE(0x06054b50)
  if (count > 0xffff) {
    const record = Buffer.alloc(56), locator = Buffer.alloc(20)
    record.writeUInt32LE(0x06064b50); record.writeBigUInt64LE(44n, 4); record.writeUInt16LE(45, 12); record.writeUInt16LE(45, 14)
    record.writeBigUInt64LE(BigInt(count), 24); record.writeBigUInt64LE(BigInt(count), 32); record.writeBigUInt64LE(BigInt(table.length), 40); record.writeBigUInt64LE(BigInt(offset), 48)
    locator.writeUInt32LE(0x07064b50); locator.writeBigUInt64LE(BigInt(offset + table.length), 8); locator.writeUInt32LE(1, 16)
    zip64.push(record, locator)
  }
  end.writeUInt16LE(Math.min(count, 0xffff), 8); end.writeUInt16LE(Math.min(count, 0xffff), 10); end.writeUInt32LE(table.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, table, ...zip64, end])
}
const archiveManifest = value => ({ name: 'backup-manifest.json', bytes: JSON.stringify(value) })

for (const storage of ['json', 'sqlite']) test(`${storage} ZIP snapshots preserve originals, history and journals independently of later edits`, async t => {
  const parent = await root(t), legacy = join(parent, 'json'), id = randomUUID(), topicId = randomUUID(), noteId = randomUUID()
  const original = Buffer.from('原文证据\n'.repeat(40000)), createdAt = new Date().toISOString()
  const document = { id, createdAt, title: '研究文献', sections: [], references: [], source: { sha256: digest(original) } }
  const topic = { id: topicId, title: 'Research', createdAt, documents: [{ documentId: id }] }
  const note = { id: noteId, documentId: id, topicId, createdAt, content: 'preserved evidence', evidence: [], history: [{ revision: 1, content: 'earlier evidence', evidence: [] }] }
  const json = await createStore(legacy); await json.saveOriginal(id, original)
  await json.write('documents', document); await json.write('topics', topic); await json.write('notes', note)
  const source = storage === 'sqlite' ? join(parent, 'sqlite') : legacy
  if (storage === 'sqlite') await migrateLibrary(legacy, source, join(parent, 'before'))
  await mkdir(join(source, 'quarantine'), { recursive: true }); await writeFile(join(source, 'quarantine', '材料.txt'), 'retained damaged bytes')
  await writeFile(join(source, '.env'), 'MODEL_KEY=private-secret'); await writeFile(join(source, 'settings.json'), '{"apiKey":"private-secret"}')
  const archive = join(parent, 'backup.zip'), progress = []
  const result = await backupZipLibrary(source, archive, { onProgress: event => progress.push(event.phase) })
  assert.equal(result.storage, storage); assert.ok(progress.includes('zip-pack')); assert.ok(progress.includes('zip-check'))
  const verified = await verifyZipBackup(archive)
  assert.ok(!verified.files.some(file => /\.env|settings|data-lock/.test(file.path)))
  if (storage === 'json') assert.ok(verified.files.some(file => file.path.startsWith('.file-operations/')))
  const live = await createStore(source)
  try { await live.update('notes', noteId, value => ({ ...value, content: 'newer edits' })) } finally { live.close?.() }
  const restored = join(parent, 'restored'); await restoreZipLibrary(archive, restored)
  const copy = await createStore(restored)
  try {
    assert.deepEqual(await copy.document(id), document); assert.deepEqual(await copy.read('notes', noteId), note)
    assert.deepEqual(await copy.original(id), original)
  } finally { copy.close?.() }
  assert.equal(await readFile(join(restored, 'quarantine', '材料.txt'), 'utf8'), 'retained damaged bytes')
  await assert.rejects(access(join(restored, '.env')))
  await backupLibrary(restored, join(parent, 'directory-backup'))
  assert.equal((await verifyBackup(join(parent, 'directory-backup'))).storage, storage)
  const unchanged = await createStore(source)
  try { assert.equal((await unchanged.read('notes', noteId)).content, 'newer edits') } finally { unchanged.close?.() }
})

test('ZIP export refuses an active source, existing targets, internal destinations and symlink inputs', async t => {
  const parent = await root(t), source = join(parent, 'source'); await createStore(source)
  const target = join(parent, 'backup.zip'), owner = await acquireDataLock(source)
  try { await assert.rejects(backupZipLibrary(source, target), { code: 'DATA_DIRECTORY_LOCKED' }) } finally { owner.release() }
  await assert.rejects(access(target))
  await writeFile(target, 'existing file'); await assert.rejects(backupZipLibrary(source, target), /已存在/)
  assert.equal(await readFile(target, 'utf8'), 'existing file')
  await assert.rejects(backupZipLibrary(source, join(source, 'backup.zip')), /来源目录之外/)
  const alias = join(parent, 'alias.zip'); await symlink(target, alias)
  await assert.rejects(verifyZipBackup(alias), /普通 ZIP/)
  await assert.rejects(restoreZipLibrary(alias, join(parent, 'unsafe')), /普通 ZIP/)
})

const badArchives = [
  ['parent escape', [{ name: '../sentinel.txt' }]],
  ['absolute path', [{ name: '/tmp/sentinel.txt' }]],
  ['Windows drive', [{ name: 'C:/sentinel.txt' }]],
  ['backslash path', [{ name: 'originals\\sentinel.txt' }]],
  ['alternate data stream', [{ name: 'originals/file:stream' }]],
  ['reserved Windows name', [{ name: 'quarantine/CON.txt' }]],
  ['trailing dot alias', [{ name: 'quarantine/file.' }]],
  ['unexpected secret', [{ name: '.env', bytes: 'secret' }]],
  ['duplicate path', [{ name: 'quarantine/a' }, { name: 'quarantine/a' }]],
  ['case alias', [{ name: 'quarantine/A' }, { name: 'quarantine/a' }]],
  ['Unicode alias', [{ name: 'quarantine/é' }, { name: 'quarantine/e\u0301' }]],
  ['implicit directory case alias', [{ name: 'quarantine/A/one' }, { name: 'quarantine/a/two' }]],
  ['file as parent directory', [{ name: 'quarantine/a' }, { name: 'quarantine/a/b' }]],
  ['symlink', [{ name: 'originals/link', attributes: (0o120777 << 16) >>> 0 }]],
  ['FIFO', [{ name: 'quarantine/fifo', attributes: (0o010600 << 16) >>> 0 }]],
  ['encryption', [{ name: 'quarantine/secret', flags: 1 }]],
  ['unsupported compression', [{ name: 'quarantine/unsupported', method: 99 }]],
  ['unlisted file', [{ name: 'quarantine/unlisted', bytes: 'hidden bytes' }]],
]
for (const [label, entries] of badArchives) test(`ZIP rejects ${label} without publishing or changing outside files`, async t => {
  const parent = await root(t), source = join(parent, 'bad.zip'), sentinel = join(parent, 'sentinel.txt'), target = join(parent, 'restored')
  await writeFile(sentinel, 'preserved'); await writeFile(source, rawZip([archiveManifest(manifest([])), ...entries]))
  await assert.rejects(verifyZipBackup(source))
  await assert.rejects(restoreZipLibrary(source, target))
  await assert.rejects(access(target)); assert.equal(await readFile(sentinel, 'utf8'), 'preserved')
})

test('ZIP rejects truncated archives, missing files, wrong hashes and corrupted CRCs', async t => {
  const parent = await root(t), source = join(parent, 'bad.zip'), path = 'quarantine/evidence', bytes = 'evidence'
  const value = manifest([{ path, size: bytes.length, sha256: digest(bytes) }])
  for (const entries of [
    [], [archiveManifest(value)],
    [archiveManifest({ ...value, files: [{ ...value.files[0], sha256: '0'.repeat(64) }] }), { name: path, bytes }],
    [{ ...archiveManifest(value), crc: 1 }, { name: path, bytes }],
    [archiveManifest(value), { name: path, bytes, crc: 1 }],
  ]) {
    await writeFile(source, rawZip(entries)); await assert.rejects(verifyZipBackup(source))
  }
  const complete = rawZip([archiveManifest(value), { name: path, bytes }])
  await writeFile(source, complete.subarray(0, -8)); await assert.rejects(verifyZipBackup(source))
  const corrupt = Buffer.from(complete), localHeader = corrupt.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 4)
  corrupt.writeUInt32LE(0, localHeader)
  await writeFile(source, corrupt); await assert.rejects(verifyZipBackup(source), /local file header/i)
})

test('ZIP enforces declared count, manifest size, total expansion and actual inflate size limits', async t => {
  const parent = await root(t), source = join(parent, 'limits.zip')
  for (const bytes of [
    rawZip([archiveManifest(manifest([]))], { count: 200002 }),
    rawZip([{ ...archiveManifest(manifest([])), size: 32 * 1024 ** 2 + 1 }]),
    rawZip([archiveManifest(manifest([])), ...Array.from({ length: 6 }, (_, i) => ({ name: 'quarantine/large-' + i, size: 0xfffffff0 }))]),
    rawZip([{ name: 'backup-manifest.json', bytes: 'x'.repeat(65536), size: 3 }]),
  ]) {
    await writeFile(source, bytes); await assert.rejects(verifyZipBackup(source))
  }
})

test('ZIP supports ZIP64 metadata and explicit directories without preserving executable permissions', async t => {
  const parent = await root(t), source = join(parent, 'zip64.zip'), path = 'quarantine/evidence', bytes = 'data'
  const value = manifest([{ path, size: bytes.length, sha256: digest(bytes) }])
  await writeFile(source, rawZip([archiveManifest(value), { name: 'quarantine/', method: 0, attributes: (0o040755 << 16) >>> 0 }, { name: path, bytes, attributes: (0o100777 << 16) >>> 0 }], { count: 3 }))
  const target = join(parent, 'restored'); await restoreZipLibrary(source, target)
  assert.equal(await readFile(join(target, path), 'utf8'), bytes)
  assert.equal((await stat(join(target, path))).mode & 0o777, 0o600)
  // A ZIP64 end record with a small real count is emitted by common ZIP tools.
  const standard = rawZip([archiveManifest(value), { name: path, bytes }], { count: 200002 })
  const marker = standard.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06]))
  standard.writeBigUInt64LE(2n, marker + 24); standard.writeBigUInt64LE(2n, marker + 32)
  await writeFile(source, standard); assert.equal((await verifyZipBackup(source)).files.length, 1)
})

test('ZIP bounds directory metadata before retaining excessive comments or path indexes', async t => {
  const parent = await root(t), source = join(parent, 'metadata.zip'), comment = 'x'.repeat(65535)
  await writeFile(source, rawZip([archiveManifest(manifest([])), ...Array.from({ length: 513 }, (_, i) => ({ name: 'quarantine/comment-' + i, comment }))]))
  await assert.rejects(verifyZipBackup(source), /目录元数据超过/)
})

test('ZIP CLI creates verifies and restores a backup through the production commands', async t => {
  const parent = await root(t), source = join(parent, 'source'), store = await createStore(source), id = randomUUID()
  await store.write('topics', { id, title: 'CLI research', createdAt: new Date().toISOString(), documents: [] })
  const cli = fileURLToPath(new URL('../tools/storage-maintenance.mjs', import.meta.url)), archive = join(parent, 'backup.zip')
  const run = async args => JSON.parse((await promisify(execFile)(process.execPath, [cli, ...args])).stdout)
  const result = await run(['backup-zip', source, archive])
  assert.equal(result.destination, await realpath(archive))
  assert.equal((await run(['verify-zip', archive])).storage, 'json')
  const restored = join(parent, 'restored'); await run(['restore-zip', archive, restored])
  assert.equal((await (await createStore(restored)).read('topics', id)).title, 'CLI research')
})
