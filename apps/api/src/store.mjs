import { mkdir, readFile, writeFile, readdir, rename, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { HttpError } from './http.mjs'
import { storageLayout } from './storage-layout.mjs'
import { fileOperationPath, readFileOperation, requireDirectory, writeFileOperation } from './file-operations.mjs'

const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
export function requireId(id) {
  if (typeof id !== 'string' || !idPattern.test(id)) throw new HttpError(400, '无效的记录 ID。')
  return id.toLowerCase()
}

export async function createStore(root) {
  const layout = await storageLayout(root)
  if (layout.storage === 'sqlite') return (await import('./sqlite-store.mjs')).createSqliteStore(root)
  for (const bucket of ['documents', 'runs', 'originals', 'imports', 'topics', 'notes', 'comparisons', 'reports']) await mkdir(join(root, bucket), { recursive: true })
  const operationDirectory = join(root, '.file-operations')
  await mkdir(operationDirectory, { recursive: true, mode: 0o700 })
  await requireDirectory(operationDirectory)
  const path = (bucket, id) => join(root, bucket, `${requireId(id)}.json`)
  async function read(bucket, id) {
    try { return JSON.parse(await readFile(path(bucket, id), 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }
  async function write(bucket, record) {
    const target = path(bucket, record.id)
    const temp = `${target}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(record, null, 2), { mode: 0o600 })
    await rename(temp, target)
    return record
  }
  async function list(bucket) {
    const names = (await readdir(join(root, bucket))).filter(name => name.endsWith('.json'))
    const values = await Promise.all(names.map(name => read(bucket, name.slice(0, -5))))
    return values.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  const updates = new Map()
  async function update(bucket, id, change, { allowCreate = false } = {}) {
    const key = path(bucket, id)
    const task = (updates.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
      const current = await read(bucket, id)
      if (!current && !allowCreate) throw new HttpError(404, '未找到记录。')
      return write(bucket, await change(current))
    })
    updates.set(key, task)
    try { return await task } finally { if (updates.get(key) === task) updates.delete(key) }
  }
  const store = {
    read, write, list, update,
    async document(id) {
      const value = await read('documents', id)
      if (!value) throw new HttpError(404, '未找到文档。')
      return value
    },
    async original(id) { return readFile(join(root, 'originals', requireId(id))) },
    async saveOriginal(id, bytes) {
      id = requireId(id); const operation = { id: randomUUID(), operation: 'write', documentId: id, path: `originals/${id}`, expectedSha256: createHash('sha256').update(bytes).digest('hex'), state: 'pending', createdAt: new Date().toISOString() }
      await writeFileOperation(operationDirectory, operation)
      try {
        await writeFile(await fileOperationPath(root, operation), bytes, { mode: 0o600 })
        operation.state = 'done'; operation.completedAt = new Date().toISOString()
      } catch (error) { operation.state = 'failed'; operation.error = error.code || error.message; throw error }
      finally { await writeFileOperation(operationDirectory, operation) }
    },
    async removeOriginal(id) {
      id = requireId(id); const operation = { id: randomUUID(), operation: 'remove', documentId: id, path: `originals/${id}`, state: 'pending', createdAt: new Date().toISOString() }
      await writeFileOperation(operationDirectory, operation)
      try { await unlink(await fileOperationPath(root, operation)); operation.state = 'done'; operation.completedAt = new Date().toISOString() }
      catch (error) { if (error.code === 'ENOENT') { operation.state = 'done'; operation.completedAt = new Date().toISOString() } else { operation.state = 'failed'; operation.error = error.code || error.message; throw error } }
      finally { await writeFileOperation(operationDirectory, operation) }
    },
  }
  async function hash(path) { const digest = createHash('sha256'); const bytes = await readFile(path); digest.update(bytes); return digest.digest('hex') }
  for (const name of await readdir(operationDirectory)) {
    if (!name.endsWith('.json')) continue
    let operation
    try { operation = await readFileOperation(operationDirectory, name) }
    catch {
      // Keep damaged/unsafe logs intact for offline inspection. One bad log
      // must not prevent access to the rest of the library or be replayed.
      continue
    }
    if (operation.state !== 'pending') continue
    try {
      const path = await fileOperationPath(root, operation)
      if (operation.operation === 'write') {
        if (await hash(path) === operation.expectedSha256) operation.state = 'done'
        else operation.state = 'failed', operation.error = 'INCOMPLETE_WRITE'
      } else if (operation.operation === 'remove') {
        try { await unlink(path); operation.state = 'done' } catch (error) { if (error.code === 'ENOENT') operation.state = 'done'; else throw error }
      } else operation.state = 'failed', operation.error = 'UNKNOWN_OPERATION'
    } catch (error) { operation.state = 'failed'; operation.error = error.code || error.message }
    operation.recoveredAt = new Date().toISOString()
    await writeFileOperation(operationDirectory, operation)
  }
  // A process restart cannot resume an upstream model request; record interruption explicitly.
  for (const bucket of ['runs', 'imports']) for (const run of await list(bucket)) {
    if (['queued', 'running'].includes(run.status)) {
      await write(bucket, { ...run, status: 'interrupted', error: '服务重启中断了本次任务，请重新提交。', finishedAt: new Date().toISOString() })
    }
  }
  return store
}
