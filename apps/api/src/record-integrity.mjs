import { mkdir, lstat, open, readFile, link, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { HttpError } from './http.mjs'
import { requireId } from './store.mjs'
import { recordBuckets } from './storage-layout.mjs'
import { validateRecordShape } from './record-shape.mjs'

export const recordSizeLimit = 32 * 1024 ** 2
export function encodeRecord(record, pretty = false) {
  const bytes = JSON.stringify(record, null, pretty ? 2 : undefined)
  if (Buffer.byteLength(bytes) > recordSizeLimit) throw new HttpError(413, '记录及历史超过 32 MiB，未保存。已保存版本仍保留，请备份后将新内容分开保存。')
  return bytes
}
export const recordDigest = bytes => createHash('sha256').update(bytes).digest('hex')
export const isRecordFault = error => ['RECORD_CORRUPT', 'RECORD_UNAVAILABLE'].includes(error?.code)
export function recordFault(bucket, id, reason = 'INVALID_RECORD') {
  return Object.assign(new HttpError(503, '这条记录损坏或无法安全读取，原件已保留。请在资料库检查中核对并选择恢复。'), { code: reason === 'READ_FAILED' ? 'RECORD_UNAVAILABLE' : 'RECORD_CORRUPT', bucket, id, reason })
}
export function decodeRecord(bucket, id, bytes) {
  try {
    if (!recordBuckets.includes(bucket) || Buffer.byteLength(bytes) > recordSizeLimit) throw new Error()
    const value = JSON.parse(bytes)
    if (!value || Array.isArray(value) || typeof value !== 'object' || requireId(value.id) !== requireId(id) || typeof value.createdAt !== 'string') throw new Error()
    validateRecordShape(bucket, value)
    return value
  } catch { throw recordFault(bucket, id) }
}
export async function availableRecord(store, bucket, id) {
  try { const value = await store.read(bucket, id); return { value, state: value ? 'available' : await store.deletion?.(bucket, id) ? 'deleted' : 'missing' } }
  catch (error) { if (!isRecordFault(error)) throw error; return { value: null, state: error.code === 'RECORD_UNAVAILABLE' ? 'unavailable' : 'corrupt' } }
}

export function createSourceReader(store) {
  const pending = new Map()
  return (bucket, id) => {
    const key = bucket + '/' + requireId(id)
    if (!pending.has(key)) pending.set(key, availableRecord(store, bucket, id))
    return pending.get(key)
  }
}

async function directory(path) {
  await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  if (!(await lstat(path)).isDirectory()) throw new Error('UNSAFE_QUARANTINE_PATH')
}
async function preserveFile(path, bytes) {
  const temporary = path + '.' + randomUUID() + '.tmp'
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    try { await link(temporary, path) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (!(await lstat(path)).isFile() || recordDigest(await readFile(path)) !== recordDigest(bytes)) throw new Error('QUARANTINE_CONFLICT')
    }
  } finally { await unlink(temporary).catch(() => {}) }
}

// Isolation preserves the live bytes in place and makes a content-addressed
// copy. It never substitutes an empty record, moves an original, or guesses
// which interrupted edit should become the saved version.
export function createRecordIntegrity(root) {
  const faults = new Map(), preserving = new Map()
  async function isolate(bucket, id, bytes, path, reason = 'INVALID_RECORD') {
    const sha256 = bytes === null ? null : recordDigest(bytes)
    const faultId = recordDigest(JSON.stringify([bucket, path, sha256, reason]))
    const fault = { faultId, bucket, id, path, reason, sha256, preserved: false, detectedAt: new Date().toISOString() }
    const previous = faults.get(path)
    if (previous?.faultId === faultId && previous.preserved) return previous
    if (previous?.faultId === faultId && preserving.has(faultId)) return preserving.get(faultId)
    faults.set(path, fault)
    if (bytes === null) return fault
    const work = preserving.get(faultId) || (async () => {
      try {
        await directory(join(root, 'quarantine'))
        await directory(join(root, 'quarantine', 'records'))
        const relative = `quarantine/records/${faultId}.bin`
        await preserveFile(join(root, relative), bytes)
        const metadata = { version: 1, faultId, bucket, id, path, reason, sha256, bytes: Buffer.byteLength(bytes), rawPath: relative }
        await preserveFile(join(root, 'quarantine', 'records', faultId + '.json'), JSON.stringify(metadata))
        if (process.platform !== 'win32') {
          const handle = await open(join(root, 'quarantine', 'records'), 'r')
          try { await handle.sync() } finally { await handle.close() }
        }
        fault.preserved = true; fault.quarantinePath = relative
      } catch { fault.preservationError = '保全副本未能完成；原始文件保留，请检查目录权限及磁盘空间。' }
      return fault
    })()
    preserving.set(faultId, work)
    try { return await work } finally { if (preserving.get(faultId) === work) preserving.delete(faultId) }
  }
  return {
    isolate,
    clear(path) { faults.delete(path) },
    async parse(bucket, id, bytes, path) {
      try { const value = decodeRecord(bucket, id, bytes); faults.delete(path); return value }
      catch (error) { await isolate(bucket, id, bytes, path); throw error }
    },
    health() { const issues = [...faults.values()]; return { issueCount: issues.length, issues: issues.slice(0, 1000), truncated: issues.length > 1000 } },
  }
}
