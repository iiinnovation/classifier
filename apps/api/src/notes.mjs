import { randomUUID, createHash } from 'node:crypto'
import { HttpError } from './http.mjs'
import { requireId } from './store.mjs'
import { evidenceVersion, captureEvidence } from './evidence.mjs'
import { modelConfigured } from './qa.mjs'

export const noteFields = ['研究问题', '材料或对象', '方法', '主要发现', '局限', '待验证问题']
const statuses = ['recorded', 'not_reported', 'not_applicable', 'not_found']
const kinds = ['source', 'inference', 'user']
const allowedCreate = ['id', 'field', 'content', 'status', 'kind', 'origin', 'referenceIds', 'documentVersion']
const allowedEdit = ['revision', 'field', 'content', 'status', 'kind', 'referenceIds', 'documentVersion', 'reviewState', 'archived', 'restoreRevision']
function keys(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(422, '笔记需要有效对象。')
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new HttpError(422, '笔记包含不可编辑的字段。')
}
function text(value, limit, name, empty = false) {
  if (typeof value !== 'string' || value.length > limit || (!empty && !value.trim())) throw new HttpError(422, `${name}不能为空或超过 ${limit} 字。`)
  return value.trim()
}
function validateContent(note) {
  note.field = text(note.field, 80, '笔记字段')
  note.content = text(note.content, 10000, '笔记内容', note.status !== 'recorded')
  if (!statuses.includes(note.status) || !kinds.includes(note.kind)) throw new HttpError(422, '无效的笔记状态或判断类型。')
  if (note.kind === 'inference' && note.origin.generatedKind !== 'inference') throw new HttpError(422, '模型归纳需要来自已读取证据的模型回答。')
  if (note.status === 'recorded' && note.kind !== 'user' && !note.evidence.length) throw new HttpError(422, '原文报告或模型归纳需要关联原文证据。')
}
function currentEvidence(document, ids, version) {
  if (!Array.isArray(ids) || ids.length > 12 || ids.some(id => typeof id !== 'string')) throw new HttpError(422, '最多关联 12 个有效原文片段。')
  if (ids.length && version !== evidenceVersion(document)) throw new HttpError(409, '原文版本已变化，请重新打开文献并选择证据。')
  const references = [...new Set(ids)].map(id => document.references.find(reference => reference.id === id))
  if (references.some(reference => !reference)) throw new HttpError(422, '引用片段不属于当前文献。')
  return captureEvidence(document, references)
}
function snapshot(note) {
  const { history, requestHash, ...value } = note
  return structuredClone(value)
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

export function createNotes(store, topics, runs, qaOptions = {}) {
  async function context(topicId, documentId, requireLinked = false) {
    const topic = await topics.get(topicId), document = await store.document(documentId)
    const linked = topic.documents.some(link => link.documentId === document.id)
    if (requireLinked && !linked) throw new HttpError(409, '请先将文献关联到当前研究主题。')
    return { topic, document, linked }
  }
  async function present(note, full = false, document = null) {
    document ||= await store.document(note.documentId)
    const version = evidenceVersion(document)
    const decorate = value => ({ ...value, evidence: value.evidence.map(item => ({ ...item, matchesCurrent: item.documentVersion === version && item.documentId === document.id })) })
    const value = decorate(snapshot(note))
    if (full) value.history = note.history.map(decorate)
    else value.historyCount = note.history.length
    value.documentTitle = document.title
    return value
  }
  async function get(id) {
    const note = await store.read('notes', id)
    if (!note) throw new HttpError(404, '未找到阅读笔记。')
    return present(note, true)
  }
  async function list(topicId, documentId = null) {
    const topic = await topics.get(topicId)
    const notes = (await store.list('notes')).filter(note => note.topicId === topic.id && (!documentId || note.documentId === documentId))
    const documents = new Map()
    for (const id of new Set(notes.map(note => note.documentId))) documents.set(id, await store.document(id))
    return Promise.all(notes.map(async note => ({ ...await present(note, false, documents.get(note.documentId)), linked: topic.documents.some(link => link.documentId === note.documentId) })))
  }
  async function forDocument(topicId, documentId) {
    const { linked } = await context(topicId, documentId)
    const suggestions = (await store.list('runs')).filter(run => run.purpose === 'note-suggestion' && run.topicId === topicId && run.documentId === documentId).slice(0, 10)
    return { notes: await list(topicId, documentId), linked, fields: noteFields, suggestions }
  }
  async function create(topicId, documentId, body) {
    keys(body, allowedCreate)
    const id = body.id === undefined ? randomUUID() : requireId(body.id)
    const requestHash = createHash('sha256').update(JSON.stringify(canonical([topicId, documentId, { ...body, id }]))).digest('hex')
    const existing = await store.read('notes', id)
    if (existing) {
      if (existing.requestHash !== requestHash) throw new HttpError(409, '笔记已存在，请使用编辑操作。')
      return present(existing, true)
    }
    const { topic, document } = await context(topicId, documentId, true)
    const origin = body.origin || { type: 'manual' }
    let evidence = [], provenance, content = '', kind = 'user'
    if (origin.type === 'answer') {
      keys(origin, ['type', 'runId', 'claimIndex', 'referenceId'])
      const run = await store.read('runs', requireId(origin.runId))
      if (!run || run.documentId !== document.id || (run.topicId && run.topicId !== topic.id) || run.status !== 'completed' || !run.result) throw new HttpError(422, '问答证据不属于当前文献或尚未完成。')
      let references
      if (origin.claimIndex !== undefined) {
        if (!Number.isInteger(origin.claimIndex) || origin.claimIndex < 0 || run.result.mode !== 'model') throw new HttpError(422, '无效的模型结论。')
        const claim = run.result.claims[origin.claimIndex]
        if (!claim) throw new HttpError(422, '未找到模型结论。')
        content = claim.text; kind = claim.kind
        references = claim.referenceIds.map(id => run.result.references.find(reference => reference.id === id))
      } else {
        const reference = run.result.references.find(reference => reference.id === origin.referenceId)
        if (!reference) throw new HttpError(422, '本次问答没有读取该片段。')
        content = reference.text; kind = 'source'; references = [reference]
      }
      if (references.some(reference => !reference)) throw new HttpError(422, '问答的引用证据不完整。')
      evidence = captureEvidence({ ...document, title: run.documentTitle }, references, run.documentVersion || null)
      provenance = { ...origin, generatedKind: kind, originalContent: content }
      if (body.referenceIds !== undefined) throw new HttpError(422, '从问答创建时使用该回答的原始证据，保存后可重新选择。')
    } else {
      keys(origin, ['type'])
      if (!['manual', 'reference'].includes(origin.type)) throw new HttpError(422, '无效的笔记来源。')
      evidence = currentEvidence(document, body.referenceIds || [], body.documentVersion)
      if (origin.type === 'reference') {
        if (!evidence.length) throw new HttpError(422, '请先选择原文。')
        content = evidence.map(item => item.reference.text).join('\n\n'); kind = 'source'
      }
      provenance = { type: origin.type, originalContent: content }
    }
    const now = new Date().toISOString()
    const note = { id, topicId: topic.id, documentId: document.id, field: body.field ?? '主要发现', content: body.content ?? content, kind: body.kind ?? kind,
      status: body.status ?? 'recorded', evidence, origin: provenance, reviewState: 'pending', reviewedAt: null, archived: false,
      revision: 1, history: [], createdAt: now, updatedAt: now, requestHash }
    note.editedByUser = provenance.type !== 'manual' && (note.content !== content || note.kind !== kind)
    validateContent(note)
    const saved = await store.update('notes', id, current => {
      if (current && current.requestHash !== requestHash) throw new HttpError(409, '该笔记 ID 已被使用。')
      return current || note
    }, { allowCreate: true })
    return present(saved, true, document)
  }
  async function edit(id, body) {
    keys(body, allowedEdit)
    if (!Number.isInteger(body.revision) || body.revision < 1 || Object.keys(body).length < 2) throw new HttpError(422, '请提供笔记版本和需要修改的字段。')
    const saved = await store.update('notes', id, async current => {
      if (current.revision !== body.revision) throw new HttpError(409, '笔记已在其他页面修改。当前输入已保留，请载入已保存版本后再编辑。')
      const document = await store.document(current.documentId)
      const next = { ...current }
      if (body.restoreRevision !== undefined) {
        if (Object.keys(body).length !== 2) throw new HttpError(422, '恢复版本时不能同时修改其他字段。')
        const previous = current.history.find(item => item.revision === body.restoreRevision)
        if (!previous) throw new HttpError(422, '未找到历史版本。')
        for (const key of ['field', 'content', 'kind', 'status', 'evidence', 'archived']) next[key] = structuredClone(previous[key])
      } else {
        for (const key of ['field', 'content', 'kind', 'status']) if (Object.hasOwn(body, key)) next[key] = body[key]
        if (body.archived !== undefined) {
          if (typeof body.archived !== 'boolean') throw new HttpError(422, '无效的归档状态。')
          next.archived = body.archived
        }
        if (body.referenceIds !== undefined) next.evidence = currentEvidence(document, body.referenceIds, body.documentVersion)
      }
      validateContent(next)
      const changed = ['field', 'content', 'kind', 'status', 'evidence'].some(key => JSON.stringify(next[key]) !== JSON.stringify(current[key]))
      if (body.reviewState !== undefined && !['pending', 'checked'].includes(body.reviewState)) throw new HttpError(422, '无效的核对状态。')
      if (body.reviewState === 'checked') {
        if (changed || !next.evidence.length || next.evidence.some(item => item.documentVersion !== evidenceVersion(document))) throw new HttpError(409, '请先保存修改并核对当前版本的原文，再标记核对完成。')
      }
      next.reviewState = changed || body.restoreRevision !== undefined ? 'pending' : body.reviewState || current.reviewState
      next.reviewedAt = next.reviewState === 'checked' ? current.reviewedAt || new Date().toISOString() : null
      next.editedByUser = current.editedByUser || changed
      next.revision++; next.updatedAt = new Date().toISOString()
      next.history = [...current.history, snapshot(current)]
      return next
    })
    return present(saved, true)
  }
  async function suggest(topicId, documentId, body) {
    keys(body, ['field'])
    const field = text(body.field, 80, '建议字段')
    const { topic } = await context(topicId, documentId, true)
    if (!modelConfigured(qaOptions.config)) throw new HttpError(409, '尚未配置问答模型，可手动记录或从原文创建笔记。')
    return runs.start(documentId, `围绕研究问题“${topic.question}”，为阅读笔记字段“${field}”提出简洁建议。只使用已读取原文，逐项引用，区分原文报告与归纳；未找到、未报告和不适用须明确说明，不补写信息。`, { purpose: 'note-suggestion', topicId, field })
  }
  return { get, list, forDocument, create, edit, suggest }
}
