import { createWriteStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, rm, link, unlink } from 'node:fs/promises'
import { dirname, join, win32 } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { crc32 } from 'node:zlib'
import yauzl from 'yauzl'
import yazl from 'yazl'
import { recordBuckets, storageLayout } from './storage-layout.mjs'
import { backupLibrary, verifyBackup, backupLimits, allowedBackupPath, validateBackupManifest, durable, publish, stageFor, syncPublishedDestination } from './storage-maintenance.mjs'

const manifestName = 'backup-manifest.json'
const roots = new Set([...recordBuckets, 'originals', 'quarantine', '.file-operations'])
const archiveByteLimit = backupLimits.bytes + 256 * 1024 ** 2
const alias = path => path.normalize('NFC').toLowerCase()
const invalid = detail => new Error('ZIP 备份无效：' + detail)

function checkName(name, directory = false) {
  const path = directory ? name.slice(0, -1) : name
  // Reject aliases that Windows or common macOS filesystems would interpret
  // differently. Extraction never delegates destination paths to the ZIP reader.
  if (!path || path.length > 4096 || path.split('/').length > 64 || win32.isAbsolute(path) || /[\\:\x00-\x1f\x7f]/.test(path) || path.split('/').some(part =>
    !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) ||
    (directory ? !roots.has(path.split('/')[0]) : path !== manifestName && !allowedBackupPath(path))) throw invalid('文件路径不受支持。')
  return path
}

async function openArchive(source) {
  const info = await lstat(source)
  if (!info.isFile() || info.size > archiveByteLimit) throw invalid('请选择大小未超限的普通 ZIP 文件。')
  return yauzl.openPromise(source, { autoClose: false, strictFileNames: true, validateEntrySizes: true })
}

function reservePath(tree, path, directory) {
  let node = tree
  for (const part of path.split('/')) {
    if (node.file) throw invalid('文件与目录路径冲突。')
    const key = alias(part)
    let child = node.children.get(key)
    if (child && child.name !== part) throw invalid('包含大小写／Unicode 路径冲突。')
    if (!child) { child = { name: part, children: new Map() }; node.children.set(key, child) }
    node = child
  }
  if (node.entry || !directory && node.children.size) throw invalid('包含重复路径或文件与目录冲突。')
  node.entry = true; node.file = !directory
}

async function archiveEntries(zip) {
  if (!Number.isSafeInteger(zip.entryCount) || zip.entryCount > backupLimits.files + 1) throw invalid('文件数量超限。')
  const entries = new Map(), tree = { children: new Map() }
  let bytes = 0, metadataBytes = 0
  for await (const entry of zip.eachEntry()) {
    metadataBytes += 46 + entry.fileNameLength + entry.extraFieldLength + entry.fileCommentLength
    if (metadataBytes > backupLimits.manifestBytes) throw invalid('目录元数据超过 32 MiB 限制。')
    const directory = entry.fileName.endsWith('/'), path = checkName(entry.fileName, directory)
    const type = (entry.externalFileAttributes >>> 16) & 0xf000
    reservePath(tree, path, directory)
    if (entries.size >= backupLimits.files + 1 || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 ||
      !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0) throw invalid('文件数量或大小超限。')
    if (entry.generalPurposeBitFlag & 0x41 || ![0, 8].includes(entry.compressionMethod)) throw invalid('不支持加密或此压缩方式。')
    if (type && type !== (directory ? 0x4000 : 0x8000) || !directory && (entry.externalFileAttributes & 0x10)) throw invalid('不允许符号链接或特殊文件。')
    if (directory && (entry.uncompressedSize !== 0 || entry.crc32 !== 0)) throw invalid('目录包含文件内容。')
    bytes += entry.uncompressedSize
    if (bytes > backupLimits.bytes + backupLimits.manifestBytes) throw invalid('展开大小超过 20 GiB 限制。')
    entries.set(path, { entry, directory })
  }
  const manifest = entries.get(manifestName)
  if (!manifest || manifest.directory || manifest.entry.uncompressedSize > backupLimits.manifestBytes) throw invalid('缺少根目录备份清单或清单超限。')
  return entries
}

async function copyEntry(zip, entry, output, expectedHash) {
  let bytes = 0, checksum = 0
  const digest = createHash('sha256')
  const check = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length
      if (bytes > entry.uncompressedSize) return callback(invalid('实际展开大小超出声明。'))
      checksum = crc32(chunk, checksum); digest.update(chunk); callback(null, chunk)
    },
    flush(callback) {
      if (bytes !== entry.uncompressedSize || checksum !== entry.crc32 || expectedHash && digest.digest('hex') !== expectedHash) return callback(invalid('文件大小、CRC 或 SHA-256 校验失败。'))
      callback()
    },
  })
  // Open and validate the source header before creating an output file. A bad
  // local header must not leave an unowned writable stream or file descriptor.
  const input = await zip.openReadStreamPromise(entry)
  await pipeline(input, check, typeof output === 'function' ? output() : output)
}

async function extractArchive(source, destination, onProgress) {
  const zip = await openArchive(source)
  try {
    const entries = await archiveEntries(zip), chunks = []
    await copyEntry(zip, entries.get(manifestName).entry, new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk); callback() } }))
    let manifest
    try { manifest = validateBackupManifest(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
    catch { throw invalid('备份清单格式或文件清单无效。') }
    const expected = new Map(manifest.files.map(file => [file.path, file]))
    for (const [path, { entry, directory }] of entries) {
      if (directory || path === manifestName) continue
      if (!expected.has(path) || expected.get(path).size !== entry.uncompressedSize) throw invalid('ZIP 内容与备份清单不一致。')
    }
    for (const file of manifest.files) if (!entries.has(file.path) || entries.get(file.path).directory) throw invalid('缺少清单中的文件。')
    let completed = 0
    for (const file of [{ path: manifestName }, ...manifest.files]) {
      const target = join(destination, file.path)
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await copyEntry(zip, entries.get(file.path).entry, () => createWriteStream(target, { flags: 'wx', mode: 0o600 }), file.sha256)
      await durable(target)
      if (file.path !== manifestName) await onProgress({ phase: 'zip-check', totalFiles: manifest.files.length, completedFiles: ++completed })
    }
    const verified = await verifyBackup(destination), layout = await storageLayout(destination)
    if (layout.storage !== verified.storage) throw invalid('恢复格式与备份声明不一致。')
    return verified
  } finally { zip.close() }
}

export async function verifyZipBackup(source, { onProgress = async () => {} } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'classifier-zip-check-'))
  try { return await extractArchive(source, workspace, onProgress) }
  finally { await rm(workspace, { recursive: true, force: true }) }
}

export async function backupZipLibrary(root, destination, { onProgress = async () => {} } = {}) {
  const { stage, target } = await stageFor(destination, root), snapshot = join(stage, 'snapshot'), archive = join(stage, 'backup.zip')
  try {
    await onProgress({ phase: 'zip-snapshot' })
    const { manifest } = await backupLibrary(root, snapshot)
    const zip = new yazl.ZipFile()
    zip.on('error', error => zip.outputStream.destroy(error))
    const output = pipeline(zip.outputStream, createWriteStream(archive, { flags: 'wx', mode: 0o600 }))
    try {
      for (const file of [{ path: manifestName }, ...manifest.files]) {
        checkName(file.path)
        zip.addFile(join(snapshot, file.path), file.path, { mode: 0o100600, compressionLevel: 3 })
      }
      await onProgress({ phase: 'zip-pack' })
      zip.end()
      await output
    } catch (error) { zip.outputStream.destroy(error); await output.catch(() => {}); throw error }
    // Read the completed archive through the same checks used on import before
    // publishing. The user's destination is created atomically without overwrite.
    await verifyZipBackup(archive, { onProgress })
    await durable(archive)
    await link(archive, target); await syncPublishedDestination(target); await unlink(archive)
    await rm(stage, { recursive: true, force: true }).catch(() => {})
    return { destination: target, storage: manifest.storage, files: manifest.files.length, createdAt: manifest.createdAt }
  } catch (error) { error.message += '；来源保留，备份暂存目录为 ' + stage; throw error }
}

export async function restoreZipLibrary(source, destination, { onProgress = async () => {} } = {}) {
  const { stage, target } = await stageFor(destination, source)
  try {
    const manifest = await extractArchive(source, stage, onProgress), layout = await storageLayout(stage)
    if (layout.storage !== manifest.storage) throw invalid('恢复格式与备份声明不一致。')
    await publish(stage, target)
    return { destination: target, storage: manifest.storage, files: manifest.files.length }
  } catch (error) { if (!error.publishedDestination) error.message += '；来源 ZIP 保留，恢复暂存目录为 ' + stage; throw error }
}
