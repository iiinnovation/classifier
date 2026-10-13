import { randomUUID, createHash } from 'node:crypto'
import { HttpError } from './http.mjs'
import { requireId } from './store.mjs'
import { evidenceVersion, captureEvidence } from './evidence.mjs'
import { modelConfigured } from './qa.mjs'
import { generateReport } from './report-model.mjs'
import { reportMarkdown } from './report-export.mjs'
import { environmentSettings, taskSettings } from './settings.mjs'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const snapshot = value => { const { history, requestHash, ...rest } = value; return structuredClone(rest) }
const keyOf = source => `${source.type}:${source.id || source.documentId}`
const unique = values => [...new Map(values.map(item => [item.id, item])).values()]
const evidenceId = item => hash([item.documentId, item.reference.id, item.documentVersion])
function keys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new HttpError(422, '成果数据包含无效字段。')
}
function text(value, max, label, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw new HttpError(422, `${label}格式或长度不正确。`)
  return value.trim()
}
function revision(value, expected) {
  if (!Number.isInteger(expected) || expected < 1) throw new HttpError(422, '需要有效的成果版本。')
  if (value.revision !== expected) throw new HttpError(409, '成果已被修改，当前输入仍保留。请核对最新版本后再保存。')
}
function blocks(value, evidence, previous = [], { generated = false, materialOrigins = new Map() } = {}) {
  if (!Array.isArray(value) || value.length > 40) throw new HttpError(422, '成果最多包含 40 个段落。')
  const allowed = new Set(evidence.map(item => item.id))
  const result = value.map(item => {
    keys(item, generated ? ['section', 'text', 'kind', 'citationIds'] : ['id', 'section', 'text', 'kind', 'citationIds'])
    const id = generated || !item.id ? randomUUID() : requireId(item.id)
    const old = previous.find(block => block.id === id)
    // Material origins are supplied only by the server's assembly operation.
    const origin = generated ? { type: 'model' } : materialOrigins.get(id) || old?.origin || { type: 'manual' }
    if (!['source', 'inference', 'user', 'question'].includes(item.kind) || (generated && item.kind === 'user')) throw new HttpError(422, '段落判断类型无效。')
    if (item.kind === 'inference' && origin.type !== 'model' && origin.generatedKind !== 'inference') throw new HttpError(422, '模型归纳只能来自模型草稿或对应材料。')
    if (!Array.isArray(item.citationIds) || item.citationIds.length > 24 || item.citationIds.some(id => !allowed.has(id))) throw new HttpError(422, '段落引用了未选择或无效的证据。')
    const block = { id, section: text(item.section, 120, '章节标题'), text: text(item.text, 4000, '段落正文', !generated), kind: item.kind, citationIds: [...new Set(item.citationIds)] }
    if (['source', 'inference'].includes(block.kind) && !block.citationIds.length) throw new HttpError(422, '原文报告和模型归纳需要原文引用。')
    const unchanged = old && ['section', 'text', 'kind', 'citationIds'].every(key => JSON.stringify(old[key]) === JSON.stringify(block[key]))
    return { ...block, origin, reviewState: unchanged ? old.reviewState : 'pending' }
  })
  if (new Set(result.map(item => item.id)).size !== result.length || result.reduce((sum, item) => sum + item.text.length, 0) > 30000) throw new HttpError(422, '段落 ID 重复或正文超过 30000 字符。')
  return result
}

function materialParagraphs(source) {
  const states = { unfilled: '未填写', not_found: '未找到', not_reported: '未报告', not_applicable: '不适用' }
  const comparabilities = { unchecked: '待判断', comparable: '可比较', conditional: '有条件可比', not_comparable: '不可直接比较' }
  const relations = { agreement: '共同点', difference: '差异', conflict: '相互冲突', insufficient: '材料不足' }
  let items
  if (source.type === 'note') items = source.content.map(item => ({ ...item, documentId: source.documentIds[0], identity: 'note' }))
  else if (source.type === 'passages') items = source.evidence.map(item => ({ identity: item.id, text: item.reference.text, kind: 'source', citationIds: [item.id] }))
  else {
    const dimension = id => source.content.columns.find(col => col.id === id)
    items = [
      ...source.content.cells.map(cell => ({ ...cell, identity: `cell:${cell.documentId}:${cell.columnId}`, context: [source.content.question, dimension(cell.columnId)], field: dimension(cell.columnId)?.name, text: cell.value })),
      ...source.content.analyses.map(analysis => ({ ...analysis, identity: `analysis:${analysis.columnId}`, context: [source.content.question, dimension(analysis.columnId)], field: relations[analysis.relation], text: analysis.value, kind: analysis.origin.type === 'model' ? 'inference' : 'user' })),
    ]
  }
  return items.map(item => {
    const kind = ['source', 'inference'].includes(item.kind) && item.citationIds.length ? item.kind : 'user'
    const prefix = item.documentId ? `${source.documents.find(doc => doc.id === item.documentId)?.title || item.documentId} · ` : ''
    const bodyText = [item.text || states[item.status] || '材料不足', item.conditions && `适用条件：${item.conditions}`, item.comparability && `可比性：${comparabilities[item.comparability]}${item.reason ? `；${item.reason}` : ''}`].filter(Boolean).join('\n')
    const section = source.type === 'note' ? item.field : `${source.title}${item.field ? ` · ${item.field}` : ''}`
    const citationIds = [...new Set(item.citationIds)]
    // Exclude editable bibliography and review-only revision changes; keep the
    // original key through manual edits so repeating assembly preserves them.
    const itemKey = hash([source.key, item.identity, item.field || null, item.context || null, bodyText, kind, [...citationIds].sort()])
    return { section: section.slice(0, 120), text: prefix + bodyText, kind, citationIds,
      legacyText: source.type === 'note' ? bodyText : prefix + bodyText,
      origin: { type: 'material', sourceKey: source.key, itemKey, generatedKind: kind } }
  })
}

function assembledItems(value) {
  const known = new Set(value.blocks.filter(block => block.origin.type === 'material' && block.origin.itemKey).map(block => block.origin.itemKey))
  const legacySources = new Set()
  for (const block of value.blocks.filter(block => block.origin.type === 'material' && !block.origin.itemKey)) {
    // Older reports lack item keys. Their first saved block/source snapshots
    // identify the imported item even after the user has rewritten its text.
    const first = value.history.find(version => version.blocks.some(item => item.id === block.id)) || value
    const original = first.blocks.find(item => item.id === block.id)
    const source = first.sources.find(item => item.key === block.origin.sourceKey)
    const matches = source ? materialParagraphs(source).filter(item => item.section === original.section && item.kind === original.kind && (item.text === original.text || item.legacyText === original.text) && hash([...item.citationIds].sort()) === hash([...original.citationIds].sort())) : []
    if (matches.length) matches.forEach(item => known.add(item.origin.itemKey))
    else legacySources.add(block.origin.sourceKey) // Preserve unidentifiable legacy edits without adding duplicates.
  }
  return { known, legacySources }
}

export function createReports(store, topics, comparisons, runs, qaOptions = {}, settingsProvider = environmentSettings()) {
  async function raw(id) {
    const value = await store.read('reports', id)
    if (!value) throw new HttpError(404, '未找到研究成果。')
    return value
  }
  async function catalog(topicId) {
    const topic = await topics.detail(topicId)
    const notes = (await store.list('notes')).filter(item => item.topicId === topicId && !item.archived)
    const tables = (await store.list('comparisons')).filter(item => item.topicId === topicId && !item.archived)
    return { documents: topic.documents.map(item => item.document), materials: [
      ...notes.map(note => ({ type: 'note', id: note.id, revision: note.revision, title: `笔记 · ${note.field}`, preview: note.content, documentIds: [note.documentId] })),
      ...tables.map(table => ({ type: 'comparison', id: table.id, revision: table.revision, title: `比较表 · ${table.title}`, preview: table.question, documentIds: table.documentIds })),
    ] }
  }
  async function selectSources(topicId, selectors, previous = []) {
    if (!Array.isArray(selectors) || selectors.length > 20) throw new HttpError(422, '每份成果最多选择 20 组研究材料。')
    const topic = await topics.get(topicId), sources = [], documents = new Map()
    async function document(id) { if (!documents.has(id)) documents.set(id, await store.document(id)); return documents.get(id) }
    for (const originalSelector of selectors) {
      keys(originalSelector, ['type', 'id', 'revision', 'documentId', 'documentVersion', 'referenceIds', 'retain'])
      const selector = { ...originalSelector }
      if (selector.id !== undefined) selector.id = requireId(selector.id)
      if (selector.documentId !== undefined) selector.documentId = requireId(selector.documentId)
      const key = keyOf(selector)
      if (sources.some(item => item.key === key)) throw new HttpError(422, '研究材料不能重复。')
      if (selector.retain === true) {
        keys(selector, ['type', 'id', 'documentId', 'retain'])
        const old = previous.find(item => item.key === key)
        if (!old) throw new HttpError(422, '未找到已保存材料。')
        sources.push(structuredClone(old)); continue
      }
      let source, evidence = []
      if (selector.type === 'note') {
        const note = await store.read('notes', requireId(selector.id))
        if (!note || note.topicId !== topicId || note.archived) throw new HttpError(422, '所选笔记不属于当前主题或已归档。')
        if (note.revision !== selector.revision) throw new HttpError(409, '笔记已更新，请重新选择。')
        source = { type: 'note', id: note.id, revision: note.revision, title: `笔记 · ${note.field}`, documentIds: [note.documentId], content: [{ field: note.field, text: note.content, kind: note.kind, status: note.status, reviewState: note.reviewState, citationIds: note.evidence.map(evidenceId) }] }
        evidence = note.evidence
      } else if (selector.type === 'comparison') {
        const table = await comparisons.get(requireId(selector.id))
        if (table.topicId !== topicId || table.archived) throw new HttpError(422, '所选比较表不属于当前主题或已归档。')
        if (table.revision !== selector.revision) throw new HttpError(409, '比较表已更新，请重新选择。')
        source = { type: 'comparison', id: table.id, revision: table.revision, title: `比较表 · ${table.title}`, documentIds: table.documentIds, content: { question: table.question, columns: table.columns, cells: table.cells.map(({ evidence, noteSources, ...cell }) => ({ ...cell, citationIds: evidence.map(evidenceId) })), analyses: table.analyses.map(({ evidence, ...analysis }) => ({ ...analysis, citationIds: evidence.map(evidenceId) })) } }
        evidence = [...table.cells.flatMap(cell => cell.evidence), ...table.analyses.flatMap(analysis => analysis.evidence)]
        if (table.cells.some(cell => cell.noteChanged) || table.analyses.some(item => item.outdated)) throw new HttpError(409, '比较表依据已变化，请先复核比较内容。')
      } else if (selector.type === 'passages') {
        const doc = await document(requireId(selector.documentId))
        if (selector.documentVersion !== evidenceVersion(doc)) throw new HttpError(409, '原文已变化，请重新选择片段。')
        if (!Array.isArray(selector.referenceIds) || !selector.referenceIds.length || selector.referenceIds.length > 12) throw new HttpError(422, '每篇文献请选择 1–12 个原文片段。')
        const refs = [...new Set(selector.referenceIds)].map(id => doc.references.find(ref => ref.id === id))
        if (refs.some(ref => !ref)) throw new HttpError(422, '原文片段不属于所选文献。')
        source = { type: 'passages', documentId: doc.id, documentVersion: evidenceVersion(doc), title: doc.title, documentIds: [doc.id], content: { referenceIds: refs.map(ref => ref.id) } }
        evidence = captureEvidence(doc, refs)
      } else throw new HttpError(422, '研究材料类型无效。')
      if (source.documentIds.some(id => !topic.documents.some(link => link.documentId === id))) throw new HttpError(409, '新选材料的文献必须仍关联当前主题。')
      source.documents = []
      for (const id of source.documentIds) {
        const doc = await document(id)
        source.documents.push({ id, title: doc.title, fileName: doc.fileName, bibliography: structuredClone(doc.bibliography || {}) })
      }
      const captured = []
      for (const item of evidence) {
        const doc = await document(item.documentId)
        if (item.documentVersion !== evidenceVersion(doc)) throw new HttpError(409, '所选材料的原文已变化，请先更新来源。')
        const { matchesCurrent, ...original } = item
        captured.push({ ...structuredClone(original), id: evidenceId(item), bibliography: structuredClone(doc.bibliography || {}) })
      }
      source.evidence = unique(captured); source.key = key
      sources.push(source)
    }
    if (unique(sources.flatMap(source => source.evidence)).length > 120 || JSON.stringify(sources).length > 240000) throw new HttpError(422, '所选材料过多，请缩小范围。')
    return sources
  }
  async function present(value, full = false) {
    const records = new Map(), docs = new Map()
    async function doc(id) { if (!docs.has(id)) docs.set(id, await store.read('documents', id)); return docs.get(id) }
    async function sourceChanged(source) {
      if (source.type === 'passages') return !await doc(source.documentId) || evidenceVersion(await doc(source.documentId)) !== source.documentVersion
      if (!records.has(source.key)) records.set(source.key, await store.read(source.type === 'note' ? 'notes' : 'comparisons', source.id))
      const record = records.get(source.key)
      if (!record || record.revision !== source.revision || record.archived) return true
      if (source.type === 'comparison') {
        const table = await comparisons.get(source.id)
        if (table.cells.some(cell => cell.noteChanged) || table.analyses.some(item => item.outdated)) return true
      }
      return false
    }
    async function decorate(record) {
      const evidence = []
      for (const item of record.evidence) {
        const current = await doc(item.documentId)
        evidence.push({ ...item, matchesCurrent: Boolean(current && evidenceVersion(current) === item.documentVersion) })
      }
      const byId = new Map(evidence.map(item => [item.id, item]))
      const sources = []
      for (const source of record.sources) sources.push({ ...source, changed: await sourceChanged(source) || source.evidence.some(item => !byId.get(item.id)?.matchesCurrent) })
      const changed = sources.some(item => item.changed)
      return { ...snapshot(record), evidence, sources, blocks: record.blocks.map(block => ({ ...block, outdated: changed || block.citationIds.some(id => !byId.get(id)?.matchesCurrent) })) }
    }
    const result = await decorate(value)
    result.suggestions = (await store.list('runs')).filter(run => run.purpose === 'report-suggestion' && run.reportId === value.id).slice(0, 10)
    if (full) { result.history = []; for (const old of value.history) result.history.push(await decorate(old)) }
    else result.historyCount = value.history.length
    return result
  }
  const summary = value => ({ id: value.id, topicId: value.topicId, title: value.title, revision: value.revision, archived: value.archived, updatedAt: value.updatedAt, createdAt: value.createdAt, blockCount: value.blocks.length })
  async function list(topicId) { await topics.get(topicId); return (await store.list('reports')).filter(value => value.topicId === topicId).map(summary) }
  async function get(id, full = false) { return present(await raw(id), full) }
  async function create(topicId, body) {
    keys(body, ['id', 'title', 'question', 'sources'])
    const id = body.id ? requireId(body.id) : randomUUID(), requestHash = hash([topicId, body])
    const existing = await store.read('reports', id)
    if (existing) {
      if (existing.requestHash !== requestHash) throw new HttpError(409, '成果已存在，请打开后编辑。')
      return present(existing)
    }
    const topic = await topics.get(topicId), now = new Date().toISOString()
    const sources = await selectSources(topicId, body.sources || [])
    const value = { id, topicId, title: text(body.title, 200, '成果标题'), question: text(body.question ?? topic.question, 4000, '研究问题'), sources, evidence: unique(sources.flatMap(source => source.evidence)),
      blocks: [], archived: false, revision: 1, history: [], requestHash, createdAt: now, updatedAt: now }
    const saved = await store.update('reports', id, current => {
      if (current && current.requestHash !== requestHash) throw new HttpError(409, '成果 ID 已被使用。')
      return current || value
    }, { allowCreate: true })
    return present(saved)
  }
  async function mutate(id, expected, update) {
    const saved = await store.update('reports', id, async current => {
      revision(current, expected)
      const next = await update(structuredClone(current))
      if (next === null) return current
      next.history = [...current.history, snapshot(current)]; next.revision = current.revision + 1; next.updatedAt = new Date().toISOString()
      return next
    })
    return present(saved)
  }
  async function edit(id, body) {
    keys(body, ['revision', 'title', 'question', 'blocks', 'sources', 'archived', 'restoreRevision', 'reviewBlockId'])
    return mutate(id, body.revision, async value => {
      if (body.restoreRevision !== undefined) {
        if (Object.keys(body).length !== 2) throw new HttpError(422, '恢复时不能同时修改正文。')
        const old = value.history.find(item => item.revision === body.restoreRevision)
        if (!old) throw new HttpError(422, '未找到成果历史版本。')
        return { ...structuredClone(old), requestHash: value.requestHash }
      }
      if (body.archived !== undefined) { if (typeof body.archived !== 'boolean') throw new HttpError(422, '归档状态无效。'); value.archived = body.archived }
      if (body.title !== undefined) value.title = text(body.title, 200, '成果标题')
      if (body.question !== undefined) {
        const question = text(body.question, 4000, '研究问题')
        if (question !== value.question) value.blocks.forEach(block => { block.reviewState = 'pending' })
        value.question = question
      }
      if (body.sources !== undefined) {
        value.sources = await selectSources(value.topicId, body.sources, value.sources)
        value.evidence = unique([...value.evidence, ...value.sources.flatMap(source => source.evidence)])
        value.blocks.forEach(block => { block.reviewState = 'pending' })
      }
      if (body.blocks !== undefined) value.blocks = blocks(body.blocks, value.evidence, value.blocks)
      // Retain evidence needed by the current sources or text; older versions remain in history.
      const used = new Set([...value.sources.flatMap(source => source.evidence.map(item => item.id)), ...value.blocks.flatMap(block => block.citationIds)])
      value.evidence = value.evidence.filter(item => used.has(item.id))
      if (body.reviewBlockId !== undefined) {
        if (Object.keys(body).length !== 2) throw new HttpError(422, '请先保存修改，再核对段落。')
        const block = value.blocks.find(item => item.id === body.reviewBlockId)
        if (!block || !block.text) throw new HttpError(422, '请选择有正文的段落。')
        if ((await present(value)).blocks.find(item => item.id === block.id).outdated) throw new HttpError(409, '材料或原文已变化，请先复核并更新引用。')
        block.reviewState = 'checked'
      }
      return value
    })
  }
  async function ensureCurrent(value) {
    const shown = await present(value), topic = await topics.get(value.topicId)
    if (shown.sources.some(source => source.changed) || value.sources.some(source => source.documentIds.some(id => !topic.documents.some(link => link.documentId === id)))) throw new HttpError(409, '研究材料或原文已变化，或文献已移出主题，请更新所选材料后重新生成。')
  }
  async function assemble(id, body) {
    keys(body, ['revision'])
    return mutate(id, body.revision, async value => {
      if (value.archived) throw new HttpError(409, '请先恢复已归档的成果。')
      if (!value.sources.length) throw new HttpError(422, '请先选择研究材料。')
      const { known, legacySources } = assembledItems(value)
      const added = []
      for (const source of value.sources) {
        if (legacySources.has(source.key)) continue
        for (const item of materialParagraphs(source)) {
          if (known.has(item.origin.itemKey)) continue
          known.add(item.origin.itemKey)
          added.push({ ...item, id: randomUUID() })
        }
      }
      if (!added.length) return null
      const all = [...value.blocks, ...added]
      value.blocks = blocks(all.map(({ id, section, text, kind, citationIds }) => ({ id, section, text, kind, citationIds })), value.evidence, value.blocks, { materialOrigins: new Map(added.map(item => [item.id, item.origin])) })
      return value
    })
  }
  async function suggest(id, body) {
    keys(body, ['revision'])
    const value = await raw(id); revision(value, body.revision)
    if (value.archived) throw new HttpError(409, '请先恢复已归档的成果。')
    const configuration = taskSettings(settingsProvider, qaOptions)
    if (!modelConfigured(configuration.text)) throw new HttpError(409, '尚未配置模型，可以继续手工整理研究成果。')
    if (!value.sources.length) throw new HttpError(422, '请先选择研究材料。')
    await ensureCurrent(value)
    const evidence = unique(value.sources.flatMap(source => source.evidence))
    const input = { title: value.title, question: value.question, partial: true, sources: value.sources.map(({ evidence, ...source }) => ({ ...source, citationIds: evidence.map(item => item.id) })), evidence: evidence.map(item => ({ id: item.id, documentId: item.documentId, title: item.documentTitle, locator: item.reference.title, text: item.reference.text, needsReview: Boolean(item.reference.needsReview) })) }
    if (JSON.stringify(input).length > 100000) throw new HttpError(422, '生成材料超过 100000 字符，请缩小所选范围。')
    return runs.startJob({ purpose: 'report-suggestion', configurationRevision: configuration.revision, topicId: value.topicId, reportId: value.id, reportTitle: value.title, baseRevision: value.revision }, async options => {
      const result = await generateReport(input, { ...qaOptions, config: configuration.text, ...options }); keys(result, ['blocks'])
      if (!result.blocks?.length) throw new HttpError(422, '模型没有返回研究段落。')
      return { blocks: blocks(result.blocks, evidence, [], { generated: true }), evidence }
    })
  }
  async function adopt(id, body) {
    keys(body, ['revision', 'runId'])
    const run = await store.read('runs', requireId(body.runId))
    if (!run || run.reportId !== id || run.purpose !== 'report-suggestion' || run.status !== 'completed' || !run.result) throw new HttpError(422, '未找到可采用的本成果草稿。')
    return mutate(id, body.revision, async value => {
      if (value.archived || value.revision !== run.baseRevision) throw new HttpError(409, '成果已变化，旧草稿不会覆盖人工修改。请重新生成或手工整理。')
      await ensureCurrent(value)
      value.blocks = structuredClone(run.result.blocks).map(block => ({ ...block, origin: { type: 'model', runId: run.id } }))
      value.evidence = unique([...value.sources.flatMap(source => source.evidence), ...run.result.evidence])
      return value
    })
  }
  async function markdown(id, expected) { const value = await get(id); revision(value, expected); return { title: value.title, markdown: reportMarkdown(value) } }
  return { catalog, list, get, create, edit, assemble, suggest, adopt, markdown }
}
