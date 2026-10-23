import { lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { requireId } from './store.mjs'

function invalidOperation() { return Object.assign(new Error('文件操作日志无效，未执行文件操作。'), { code: 'INVALID_FILE_OPERATION' }) }
function unsafePath() { return Object.assign(new Error('文件操作路径不是普通文件或实际目录。'), { code: 'UNSAFE_FILE_OPERATION_PATH' }) }

export function validateFileOperation(operation) {
  try {
    if (!operation || requireId(operation.id) !== operation.id || requireId(operation.documentId) !== operation.documentId ||
      !['write', 'remove'].includes(operation.operation) || !['pending', 'done', 'failed'].includes(operation.state) ||
      operation.path !== `originals/${operation.documentId}` ||
      operation.operation === 'write' && !/^[a-f0-9]{64}$/.test(operation.expectedSha256)) throw invalidOperation()
  } catch { throw invalidOperation() }
}

export async function requireDirectory(path) {
  if (!(await lstat(path)).isDirectory()) throw unsafePath()
}

export async function fileOperationPath(root, operation) {
  validateFileOperation(operation)
  await requireDirectory(join(root, 'originals'))
  const path = join(root, operation.path)
  try { if (!(await lstat(path)).isFile()) throw unsafePath() }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  return path
}

export async function readFileOperation(directory, name) {
  const path = join(directory, name), entry = await lstat(path)
  if (!entry.isFile() || entry.size > 64 * 1024) throw invalidOperation()
  const operation = JSON.parse(await readFile(path, 'utf8'))
  validateFileOperation(operation)
  if (name !== operation.id + '.json') throw invalidOperation()
  return operation
}

export async function writeFileOperation(directory, operation) {
  const target = join(directory, requireId(operation.id) + '.json'), temporary = target + '.' + randomUUID() + '.tmp'
  await requireDirectory(directory)
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(operation)); await handle.sync() }
    finally { await handle.close() }
    await rename(temporary, target)
    // Windows does not support opening directories for fsync through this API.
    if (process.platform !== 'win32') {
      const handle = await open(directory, 'r')
      try { await handle.sync() } finally { await handle.close() }
    }
  } catch (error) { await unlink(temporary).catch(() => {}); throw error }
}
