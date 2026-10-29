import { HttpError } from './http.mjs'
import { requireId } from './store.mjs'
import { deletionPreview } from './deletion-preview.mjs'
import { deletionRevision } from './sqlite-deletions.mjs'

const targets = new Set(['documents', 'topics', 'notes', 'comparisons', 'reports'])
const scope = preview => deletionRevision({ removes: preview.removes, links: preview.links, preserves: preview.preserves, removedTasks: preview.tasks.filter(task => task.removesRecord).map(task => ({ bucket: task.bucket, id: task.id })) })

// The HTTP admission barrier drains already accepted mutations and excludes new
// ones while this function waits for related background workers to finish.
export async function executeDeletion(store, runs, imports, { bucket, id, body, synchronousImports = 0 }) {
  id = requireId(id)
  if (!targets.has(bucket) || !body || body.confirmed !== true || body.policy !== 'retain-copied-evidence-v1' || !/^[a-f0-9]{64}$/.test(body.revision || '')) throw new HttpError(400, '请读取影响范围并明确确认普通删除。')
  const operationId = requireId(body.operationId)
  if (!store.commitDeletion) throw new HttpError(422, '当前 JSON 库仅支持删除预览，请显式备份并迁移到 SQLite 后操作。')
  const repeated = store.deletionReceipt(operationId, bucket, id, body.revision)
  if (repeated) return store.commitDeletion({ target: { bucket, id }, revision: body.revision }, operationId)
  const before = await deletionPreview(store, { bucket, id, synchronousImports })
  if (!before.complete || before.revision !== body.revision) throw new HttpError(409, '资料或影响范围已变化，请刷新后重新确认。')
  const active = before.tasks.filter(task => task.active)
  if (active.length && body.stopTasks !== true) throw new HttpError(409, '删除涉及活动任务，请明确确认停止相关任务后再删除。')
  await Promise.all([
    runs.cancelAndWait(active.filter(task => task.bucket === 'runs').map(task => task.id)),
    imports.cancelAndWait(active.filter(task => task.bucket === 'imports').map(task => task.id)),
  ])
  const current = await deletionPreview(store, { bucket, id, synchronousImports: 0 })
  if (!current.complete || current.tasks.some(task => task.active) || scope(before) !== scope(current)) throw new HttpError(409, '停止任务后资料范围发生变化，请刷新后重新确认。')
  return store.commitDeletion({ ...current, confirmedRevision: body.revision }, operationId)
}
