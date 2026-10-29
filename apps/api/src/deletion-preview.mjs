import { createHash } from 'node:crypto'
import { HttpError } from './http.mjs'
import { requireId } from './store.mjs'
import { recordBuckets } from './storage-layout.mjs'
import { deletionConfirmationRevision } from './sqlite-deletions.mjs'

const targets = ['documents', 'topics', 'notes', 'comparisons', 'reports']
const active = new Set(['queued', 'running'])
const containers = new Set(['documents', 'documentVersions', 'evidence', 'sources', 'content', 'cells', 'analyses', 'rows', 'noteSources', 'baseNotes', 'baseCells', 'result', 'blocks'])
const lower = value => typeof value === 'string' ? value.toLowerCase() : null
const emptyRefs = () => Object.fromEntries(targets.map(bucket => [bucket, new Set()]))
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const history = value => Array.isArray(value.history) ? value.history : []

// Follow stored identities, never UUID-like text in a paragraph or an unknown
// extension. A copied source is a reference even when its live source is gone.
function references(value) {
  const result = emptyRefs(), pending = [[value, '']]
  const add = (bucket, id) => { if (typeof id === 'string') result[bucket].add(lower(id)) }
  while (pending.length) {
    const next = pending.pop()
    if (next.iterator) { const item = next.iterator.next(); if (!item.done) pending.push(next, [item.value, next.context]); continue }
    const [item, context] = next
    if (!item || typeof item !== 'object') continue
    if (Array.isArray(item)) { pending.push({ iterator: item.values(), context }); continue }
    for (const [key, bucket] of [['documentId', 'documents'], ['topicId', 'topics'], ['noteId', 'notes'], ['comparisonId', 'comparisons'], ['reportId', 'reports']]) add(bucket, item[key])
    for (const id of Array.isArray(item.documentIds) ? item.documentIds : []) add('documents', id)
    if (context === 'documentVersions' || context === 'documents') add('documents', item.id)
    if (context === 'noteSources' || context === 'baseNotes') add('notes', item.id)
    if (context === 'sources' && item.type === 'note') add('notes', item.id)
    if (context === 'sources' && item.type === 'comparison') add('comparisons', item.id)
    if (context === 'blocks' && item.origin?.type === 'material') {
      const source = /^(note|comparison|passages):([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.exec(item.origin.sourceKey || '')
      if (source) add({ note: 'notes', comparison: 'comparisons', passages: 'documents' }[source[1].toLowerCase()], source[2])
    }
    for (const key of containers) if (item[key] && typeof item[key] === 'object') pending.push([item[key], key])
  }
  return result
}
const intersects = (references, selected) => targets.some(bucket => [...references[bucket]].some(id => selected[bucket].has(id)))
const summary = (bucket, record) => ({ bucket, id: record.id, title: record.title || record.field || record.fileName || '未命名记录', historyVersions: history(record).length, recordRevision: digest(record), ...(record.revision === undefined ? {} : { revision: record.revision }) })
async function snapshot(store) {
  return Object.fromEntries(await Promise.all(recordBuckets.map(async bucket => [bucket, (await store.list(bucket)).sort((a, b) => a.id.localeCompare(b.id))])))
}

export async function deletionPreview(store, { bucket, id, action = 'delete', topicId = null, synchronousImports = 0 }) {
  if (!targets.includes(bucket) || !['delete', 'detach'].includes(action) || action === 'detach' && (bucket !== 'documents' || !topicId) || action === 'delete' && topicId !== null) throw new HttpError(400, '无效的影响预览范围。')
  id = requireId(id)
  if (topicId !== null) topicId = requireId(topicId)
  // Direct reads keep a damaged target distinct from a genuinely absent one.
  if (!await store.read(bucket, id)) throw new HttpError(404, '未找到预览目标。')
  const before = await snapshot(store), data = await snapshot(store), health = await store.health()
  const revision = deletionConfirmationRevision(data), changed = deletionConfirmationRevision(before) !== revision
  const record = data[bucket].find(value => lower(value.id) === id)
  if (!record) throw new HttpError(409, '预览期间目标发生变化，请重新查看。')
  const topic = topicId && data.topics.find(value => lower(value.id) === topicId)
  if (action === 'detach' && !topic) throw new HttpError(404, '未找到研究主题。')
  if (action === 'detach' && !topic.documents.some(link => lower(link.documentId) === id)) throw new HttpError(409, '文献已不在该主题中。')

  const selected = emptyRefs(), removed = []
  if (action === 'delete') {
    selected[bucket].add(id); removed.push({ bucket, record })
    if (bucket === 'topics') for (const kind of ['notes', 'comparisons', 'reports']) for (const value of data[kind]) if (lower(value.topicId) === id) {
      selected[kind].add(lower(value.id)); removed.push({ bucket: kind, record: value })
    }
  }
  const research = ['notes', 'comparisons', 'reports'].flatMap(kind => data[kind].filter(value => action !== 'detach' || lower(value.topicId) === topicId).map(value => ({ kind, value, current: references(value), historical: history(value).map(references) })))
  function referenceClosure(includeHistory) {
    const affected = emptyRefs()
    for (const kind of targets) for (const selectedId of selected[kind]) affected[kind].add(selectedId)
    if (action === 'detach') affected.documents.add(id)
    let changed = true
    while (changed) {
      changed = false
      for (const entry of research) if (!affected[entry.kind].has(lower(entry.value.id)) && (intersects(entry.current, affected) || includeHistory && entry.historical.some(refs => intersects(refs, affected)))) {
        affected[entry.kind].add(lower(entry.value.id)); changed = true
      }
    }
    return affected
  }
  const affected = referenceClosure(true), currentAffected = referenceClosure(false)
  const links = []
  for (const value of data.topics) for (const link of value.documents) {
    const matches = action === 'detach' ? lower(value.id) === topicId && lower(link.documentId) === id : selected.topics.has(lower(value.id)) || selected.documents.has(lower(link.documentId))
    if (matches) links.push({ topicId: value.id, title: value.title, documentId: link.documentId })
  }

  const retainedDocuments = new Set(), sourceRecords = emptyRefs()
  for (const { record: value } of removed) for (const version of [value, ...history(value)]) {
    const refs = references(version)
    for (const kind of targets) for (const sourceId of refs[kind]) if (!selected[kind].has(sourceId)) sourceRecords[kind].add(sourceId)
  }
  for (const documentId of sourceRecords.documents) retainedDocuments.add(documentId)
  if (action === 'detach') retainedDocuments.add(id)
  const retainedResearch = []
  for (const { kind, value, current: currentReferences, historical } of research) {
    if (selected[kind].has(lower(value.id))) continue
    const current = intersects(currentReferences, affected)
    const historicalVersions = historical.filter(refs => intersects(refs, affected)).length
    const retainedSource = sourceRecords[kind].has(lower(value.id))
    if (current || historicalVersions || retainedSource) retainedResearch.push({ ...summary(kind, value), currentReference: current, historicalVersions, retainedSource })
  }
  const tasks = []
  for (const kind of ['runs', 'imports']) for (const value of data[kind]) {
    let related = intersects(references(value), currentAffected)
    if (action === 'detach') related &&= lower(value.topicId) === topicId || currentAffected.comparisons.has(lower(value.comparisonId)) || currentAffected.reports.has(lower(value.reportId))
    // Suggestion jobs keep their comparison/report identity while their input
    // snapshots may exist only in the running worker until completion.
    if (related) tasks.push({ bucket: kind, id: value.id, purpose: value.purpose || 'import', status: value.status, active: active.has(value.status), removesRecord: [['documentId', 'documents'], ['topicId', 'topics'], ['noteId', 'notes'], ['comparisonId', 'comparisons'], ['reportId', 'reports']].some(([field, bucket]) => selected[bucket].has(lower(value[field]))) })
  }
  const blockers = []
  if (health.issueCount) blockers.push({ code: 'INCOMPLETE_LIBRARY', message: '资料库存在损坏或未验证的记录，以下范围可能不完整，请先检查并恢复。', issueCount: health.issueCount })
  if (changed) blockers.push({ code: 'LIBRARY_CHANGED', message: '资料在预览期间发生变化，请刷新影响范围。' })
  if (tasks.some(task => task.active)) blockers.push({ code: 'ACTIVE_TASKS', message: '存在相关在途任务；执行删除前必须停止并等待任务结束，防止内容被重新写回。' })
  if (synchronousImports) blockers.push({ code: 'SYNCHRONOUS_IMPORTS', message: '正在同步导入文献，最终关联尚未提交，请等待导入结束后刷新。', count: synchronousImports })
  const executionAvailable = action === 'delete' && typeof store.commitDeletion === 'function'
  return {
    previewVersion: 1, policy: 'retain-copied-evidence-v1', action, target: summary(bucket, record), ...(topic ? { topic: summary('topics', topic) } : {}),
    readOnly: true, executionAvailable, complete: !health.issueCount && !changed && !synchronousImports, revision,
    removes: removed.map(({ bucket, record }) => summary(bucket, record)), links,
    preserves: {
      documents: [...retainedDocuments].sort().map(documentId => { const document = data.documents.find(value => lower(value.id) === documentId); return document ? summary('documents', document) : { bucket: 'documents', id: documentId, title: '来源文献不可用', unavailable: true, historyVersions: 0 } }),
      research: retainedResearch,
    },
    tasks, blockers,
    counts: { records: removed.length, historyVersions: removed.reduce((count, item) => count + history(item.record).length, 0), taskRecords: tasks.filter(task => task.removesRecord).length, topicLinks: links.length, originalDocuments: selected.documents.size, retainedResearch: retainedResearch.length, activeTasks: tasks.filter(task => task.active).length, synchronousImports },
    notices: [
      '当前仅预览影响，不会删除或修改任何研究记录，也不会停止任务。',
      ...(action === 'delete' ? [executionAvailable ? '确认后会删除上述记录及直接所属任务记录；相关活动任务先停止并等待结束。其他研究中的引用摘录继续保留。' : '当前 JSON 资料库仅支持预览；请通过资料库菜单显式备份并迁移到 SQLite 后使用删除。'] : []),
      ...(executionAvailable ? ['普通删除不可直接撤销；若需要恢复，请先保留删除前的备份。执行删除后，旧测试版本不能直接打开此库，回退需从兼容备份恢复到新目录。'] : []),
      action === 'detach' ? '移出主题只解除关联，原文件及已保存研究内容保留。' : bucket === 'documents' ? '按当前方案删除原文件和解析全文，已引用摘录及历史副本仍保留；这不等于彻底清除内容。' : bucket === 'topics' ? '主题及其笔记、比较、成果和自身历史属于删除范围；共享文献库中的原文件保留。' : '目标记录及自身历史属于删除范围；原始文献和其他研究中复制的材料保留。',
      '备份、隔离副本和已导出的文件可能仍含内容，不会随普通删除被清除。',
    ],
  }
}
