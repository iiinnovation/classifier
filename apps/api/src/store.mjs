import { mkdir, readFile, writeFile, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HttpError } from './http.mjs'

const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
export function requireId(id) {
  if (typeof id !== 'string' || !idPattern.test(id)) throw new HttpError(400, '无效的记录 ID。')
  return id.toLowerCase()
}

export async function createStore(root) {
  for (const bucket of ['documents', 'runs', 'originals', 'imports', 'topics', 'notes', 'comparisons']) await mkdir(join(root, bucket), { recursive: true })
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
    async saveOriginal(id, bytes) { await writeFile(join(root, 'originals', requireId(id)), bytes, { mode: 0o600 }) },
  }
  // A process restart cannot resume an upstream model request; record interruption explicitly.
  for (const bucket of ['runs', 'imports']) for (const run of await list(bucket)) {
    if (['queued', 'running'].includes(run.status)) {
      await write(bucket, { ...run, status: 'interrupted', error: '服务重启中断了本次任务，请重新提交。', finishedAt: new Date().toISOString() })
    }
  }
  return store
}
