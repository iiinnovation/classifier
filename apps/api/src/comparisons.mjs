import { randomUUID, createHash } from 'node:crypto'
import { HttpError } from './http.mjs'
import { requireId } from './store.mjs'
import { evidenceVersion, captureEvidence } from './evidence.mjs'
import { documentSummary } from './topics.mjs'
import { modelConfigured } from './qa.mjs'
import { comparisonReferences } from './comparison-retrieval.mjs'
import { generateComparison } from './comparison-model.mjs'

const statuses = ['unfilled', 'recorded', 'not_reported', 'not_found', 'not_applicable']
const comparabilities = ['unchecked', 'comparable', 'conditional', 'not_comparable']
const relations = ['agreement', 'difference', 'conflict', 'insufficient']
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const scope = table => hash([table.question, table.documentIds, table.columns])
const cellKey = (documentId, columnId) => `${documentId}:${columnId}`
function keys(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) throw new HttpError(422, '比较数据包含无效字段。')
}
function text(value, max, label, empty = true) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw new HttpError(422, `${label}格式或长度不正确。`)
  return value.trim()
}
function ids(value, min, max, label) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new HttpError(422, `${label}需要 ${min}–${max} 项。`)
  const result = value.map(requireId)
  if (new Set(result).size !== result.length) throw new HttpError(422, `${label}不能重复。`)
  return result
}
function emptyCell(documentId, columnId) {
  return { documentId, columnId, value: '', status: 'unfilled', kind: 'user', conditions: '', comparability: 'unchecked', reason: '', evidence: [], noteSources: [], origin: { type: 'manual' }, reviewState: 'pending' }
}
function findCell(table, documentId, columnId) { return table.cells.find(cell => cell.documentId === documentId && cell.columnId === columnId) || emptyCell(documentId, columnId) }
function snapshot(table) { const { history, requestHash, ...value } = table; return structuredClone(value) }
function uniqueEvidence(evidence) { return [...new Map(evidence.map(item => [`${item.documentId}:${item.reference.id}:${item.documentVersion}`, item])).values()] }
function validateCell(cell) {
  cell.value = text(cell.value, 6000, '比较内容')
  cell.conditions = text(cell.conditions, 2000, '适用条件')
  cell.reason = text(cell.reason, 2000, '可比性理由')
  if (!statuses.includes(cell.status) || !['source', 'inference', 'user'].includes(cell.kind) || !comparabilities.includes(cell.comparability)) throw new HttpError(422, '比较状态或判断类型无效。')
  if (cell.status === 'recorded' && !cell.value) throw new HttpError(422, '已记录的比较项需要内容。')
  if (cell.status !== 'recorded' && cell.value) throw new HttpError(422, '缺失状态下不填写确定值，可将说明放在适用条件中。')
  if (cell.status === 'recorded' && cell.kind !== 'user' && !cell.evidence.length) throw new HttpError(422, '原文报告与模型归纳需要引用证据。')
  if (cell.kind === 'inference' && cell.origin.generatedKind !== 'inference') throw new HttpError(422, '模型归纳需要来自模型建议或对应笔记。')
  if (['conditional', 'not_comparable'].includes(cell.comparability) && !cell.reason) throw new HttpError(422, '请说明有条件可比或不可比较的原因。')
}

export function createComparisons(store, topics, runs, qaOptions = {}) {
  async function raw(id) {
    const table = await store.read('comparisons', id)
    if (!table) throw new HttpError(404, '未找到比较表。')
    return table
  }
  async function requireRows(topicId, documentIds) {
    const topic = await topics.get(topicId)
    if (documentIds.some(id => !topic.documents.some(link => link.documentId === id))) throw new HttpError(409, '所选文献必须关联到当前主题。请调整范围或重新关联。')
    return topic
  }
  function column(table, columnId) {
    const value = table.columns.find(item => item.id === columnId)
    if (!value) throw new HttpError(404, '未找到比较维度。')
    return value
  }
  function row(table, documentId) {
    if (!table.documentIds.includes(documentId)) throw new HttpError(422, '文献不在本次比较范围内。')
  }
  function revision(table, expected) {
    if (!Number.isInteger(expected) || expected < 1) throw new HttpError(422, '需要有效的比较表版本。')
    if (table.revision !== expected) throw new HttpError(409, '比较表已被修改。输入已保留，请重新打开最新版本后再保存。')
  }
  function summary(table) {
    return { id: table.id, topicId: table.topicId, title: table.title, question: table.question, documentCount: table.documentIds.length, columnCount: table.columns.length, revision: table.revision, archived: table.archived, updatedAt: table.updatedAt, createdAt: table.createdAt }
  }
  async function present(table, full = false) {
    const topic = await topics.get(table.topicId)
    const documents = await Promise.all(table.documentIds.map(id => store.document(id)))
    const versions = new Map(documents.map(document => [document.id, evidenceVersion(document)]))
    if (full) {
      const historicalIds = [...new Set(table.history.flatMap(version => version.documentIds))].filter(id => !versions.has(id))
      for (const id of historicalIds) {
        const document = await store.read('documents', id)
        if (document) versions.set(id, evidenceVersion(document))
      }
    }
    const notes = new Map((await store.list('notes')).map(note => [note.id, note]))
    const decorateEvidence = evidence => evidence.map(item => ({ ...item, matchesCurrent: versions.get(item.documentId) === item.documentVersion }))
    const cells = table.documentIds.flatMap(documentId => table.columns.map(item => {
      const cell = findCell(table, documentId, item.id)
      return { ...cell, evidence: decorateEvidence(cell.evidence), noteChanged: cell.noteSources.some(note => notes.get(note.id)?.revision !== note.revision) }
    }))
    const analyses = table.analyses.map(analysis => ({ ...analysis, evidence: decorateEvidence(analysis.evidence), outdated: analysis.definitionHash !== hash([table.question, column(table, analysis.columnId)]) || analysis.rows.some(item => {
      const cell = cells.find(cell => cell.documentId === item.documentId && cell.columnId === analysis.columnId)
      return !cell || cell.noteChanged || cell.evidence.some(evidence => !evidence.matchesCurrent) || item.digest !== hash(findCell(table, item.documentId, analysis.columnId))
    }) }))
    const suggestions = (await store.list('runs')).filter(run => run.purpose === 'comparison-suggestion' && run.comparisonId === table.id).slice(0, 10)
    const history = full ? table.history.map(version => ({ ...version,
      cells: version.cells.map(cell => ({ ...cell, evidence: decorateEvidence(cell.evidence) })),
      analyses: version.analyses.map(analysis => ({ ...analysis, evidence: decorateEvidence(analysis.evidence) })),
    })) : null
    return { ...snapshot(table), cells, analyses, documents: documents.map(document => ({ ...documentSummary(document), evidenceVersion: versions.get(document.id), linked: topic.documents.some(link => link.documentId === document.id) })), suggestions, ...(full ? { history } : { historyCount: table.history.length }) }
  }
  async function list(topicId) { await topics.get(topicId); return (await store.list('comparisons')).filter(table => table.topicId === topicId).map(summary) }
  async function get(id, full = false) { return present(await raw(id), full) }
  function columns(value, tableId) {
    if (!Array.isArray(value) || !value.length || value.length > 12) throw new HttpError(422, '比较维度需要 1–12 项。')
    const result = value.map((item, index) => {
      keys(item, ['id', 'name', 'description'])
      const generated = hash([tableId, index]).slice(0, 32).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
      return { id: item.id ? requireId(item.id) : generated, name: text(item.name, 80, '维度名称', false), description: text(item.description ?? '', 1000, '维度说明') }
    })
    if (new Set(result.map(item => item.id)).size !== result.length || new Set(result.map(item => item.name.toLowerCase())).size !== result.length) throw new HttpError(422, '维度名称和 ID 不能重复。')
    return result
  }
  async function create(topicId, body) {
    keys(body, ['id', 'title', 'question', 'documentIds', 'columns'])
    const id = body.id ? requireId(body.id) : randomUUID()
    const documentIds = ids(body.documentIds, 2, 12, '文献')
    const topic = await requireRows(topicId, documentIds)
    const now = new Date().toISOString()
    const table = { id, topicId, title: text(body.title, 200, '比较标题', false), question: text(body.question ?? topic.question, 4000, '研究问题', false), documentIds,
      columns: columns(body.columns ?? ['方法', '研究对象', '主要发现', '局限'].map(name => ({ name })), id), cells: [], analyses: [], archived: false, revision: 1, history: [], createdAt: now, updatedAt: now }
    table.requestHash = hash([table.title, table.question, table.documentIds, table.columns])
    const saved = await store.update('comparisons', id, current => {
      if (current && (current.topicId !== topicId || current.requestHash !== table.requestHash)) throw new HttpError(409, '比较表已存在，请打开后编辑。')
      return current || table
    }, { allowCreate: true })
    return present(saved)
  }
  async function mutate(id, expected, update) {
    const saved = await store.update('comparisons', id, async current => {
      revision(current, expected)
      const next = await update(structuredClone(current))
      next.history = [...current.history, snapshot(current)]
      next.revision = current.revision + 1; next.updatedAt = new Date().toISOString()
      return next
    })
    return present(saved)
  }
  async function edit(id, body) {
    keys(body, ['revision', 'title', 'question', 'documentIds', 'columns', 'archived', 'restoreRevision'])
    return mutate(id, body.revision, async table => {
      if (body.restoreRevision !== undefined) {
        if (Object.keys(body).length !== 2) throw new HttpError(422, '恢复版本不能同时编辑其他内容。')
        const old = table.history.find(item => item.revision === body.restoreRevision)
        if (!old) throw new HttpError(422, '未找到历史版本。')
        return { ...structuredClone(old), requestHash: table.requestHash }
      }
      if (body.title !== undefined) table.title = text(body.title, 200, '比较标题', false)
      if (body.question !== undefined) table.question = text(body.question, 4000, '研究问题', false)
      if (body.documentIds !== undefined) {
        const next = ids(body.documentIds, 2, 12, '文献')
        await requireRows(table.topicId, next.filter(id => !table.documentIds.includes(id)))
        table.documentIds = next
      }
      if (body.columns !== undefined) {
        const next = columns(body.columns, table.id)
        const changed = new Set(next.filter(item => JSON.stringify(item) !== JSON.stringify(table.columns.find(old => old.id === item.id))).map(item => item.id))
        table.cells = table.cells.map(cell => changed.has(cell.columnId) ? { ...cell, reviewState: 'pending' } : cell)
        table.columns = next
      }
      table.cells = table.cells.filter(cell => table.documentIds.includes(cell.documentId) && table.columns.some(item => item.id === cell.columnId))
      table.analyses = table.analyses.filter(analysis => table.columns.some(item => item.id === analysis.columnId))
      if (body.archived !== undefined) {
        if (typeof body.archived !== 'boolean') throw new HttpError(422, '归档状态无效。')
        table.archived = body.archived
      }
      return table
    })
  }
  async function sources(id, documentId) {
    const table = await raw(id); row(table, documentId)
    const document = await store.document(documentId)
    const notes = (await store.list('notes')).filter(note => note.topicId === table.topicId && note.documentId === documentId && !note.archived)
    return { document: { ...documentSummary(document), evidenceVersion: evidenceVersion(document), references: document.references }, notes: notes.map(note => ({ id: note.id, revision: note.revision, field: note.field, content: note.content, status: note.status, kind: note.kind, evidence: note.evidence })) }
  }
  async function editCell(id, documentId, columnId, body) {
    keys(body, ['revision', 'value', 'status', 'kind', 'conditions', 'comparability', 'reason', 'source', 'reviewState'])
    return mutate(id, body.revision, async table => {
      row(table, documentId); column(table, columnId)
      const previous = findCell(table, documentId, columnId), cell = structuredClone(previous)
      if (body.source !== undefined) {
        keys(body.source, ['type', 'noteId', 'revision', 'referenceIds', 'documentVersion'])
        if (body.source.type === 'note') {
          const note = await store.read('notes', requireId(body.source.noteId))
          if (!note || note.topicId !== table.topicId || note.documentId !== documentId || note.archived) throw new HttpError(422, '笔记不属于本行文献和主题，或已归档。')
          if (note.revision !== body.source.revision) throw new HttpError(409, '笔记已更新，请重新选择。')
          cell.evidence = structuredClone(note.evidence)
          cell.noteSources = [{ id: note.id, revision: note.revision, field: note.field, content: note.content, kind: note.kind }]
          cell.value = note.status === 'recorded' ? note.content : ''; cell.status = note.status; cell.kind = note.kind
          cell.origin = { type: 'note', generatedKind: note.kind }
        } else if (body.source.type === 'passages') {
          const document = await store.document(documentId), selected = body.source.referenceIds
          if (!Array.isArray(selected) || selected.length > 12 || selected.some(id => typeof id !== 'string')) throw new HttpError(422, '最多选择 12 个原文片段。')
          if (selected.length && body.source.documentVersion !== evidenceVersion(document)) throw new HttpError(409, '原文版本已变化，请重新选择。')
          const references = [...new Set(selected)].map(id => document.references.find(ref => ref.id === id))
          if (references.some(ref => !ref)) throw new HttpError(422, '引用不属于本行文献。')
          cell.evidence = captureEvidence(document, references); cell.noteSources = []; cell.origin = { type: 'manual' }
        } else throw new HttpError(422, '无效的证据来源。')
      }
      for (const key of ['value', 'status', 'kind', 'conditions', 'comparability', 'reason']) if (body[key] !== undefined) cell[key] = body[key]
      validateCell(cell)
      const changed = hash({ ...cell, reviewState: 'pending' }) !== hash({ ...previous, reviewState: 'pending' })
      cell.reviewState = changed ? 'pending' : previous.reviewState
      if (body.reviewState !== undefined) {
        if (!['checked', 'pending'].includes(body.reviewState)) throw new HttpError(422, '核对状态无效。')
        if (body.reviewState === 'checked') {
          const version = evidenceVersion(await store.document(documentId))
          const noteChanged = (await Promise.all(cell.noteSources.map(async note => (await store.read('notes', note.id))?.revision !== note.revision))).some(Boolean)
          if (changed || noteChanged || !cell.evidence.length || cell.evidence.some(item => item.documentVersion !== version)) throw new HttpError(409, '请先保存内容并核对当前证据，再标记完成。')
        }
        cell.reviewState = body.reviewState
      }
      table.cells = [...table.cells.filter(item => cellKey(item.documentId, item.columnId) !== cellKey(documentId, columnId)), cell]
      return table
    })
  }
  async function editAnalysis(id, columnId, body) {
    keys(body, ['revision', 'value', 'relation', 'conditions', 'documentIds'])
    return mutate(id, body.revision, async table => {
      column(table, columnId)
      const documentIds = ids(body.documentIds, 2, table.documentIds.length, '判断依据文献')
      documentIds.forEach(id => row(table, id))
      if (!relations.includes(body.relation)) throw new HttpError(422, '综合判断类型无效。')
      const cells = documentIds.map(id => findCell(table, id, columnId))
      const analysis = { columnId, definitionHash: hash([table.question, column(table, columnId)]), value: text(body.value, 6000, '综合判断', false), relation: body.relation, conditions: text(body.conditions ?? '', 2000, '条件与分歧说明'), origin: { type: 'user' }, reviewState: 'pending',
        rows: cells.map(cell => ({ documentId: cell.documentId, value: cell.value, status: cell.status, digest: hash(cell) })), evidence: uniqueEvidence(cells.flatMap(cell => cell.evidence)) }
      table.analyses = [...table.analyses.filter(item => item.columnId !== columnId), analysis]
      return table
    })
  }
  async function prepare(table, columnId) {
    const selectedColumn = column(table, columnId)
    await requireRows(table.topicId, table.documentIds)
    const evidence = [], evidenceMap = new Map(), documents = [], noteVersions = []
    const allNotes = (await store.list('notes')).filter(note => note.topicId === table.topicId && !note.archived)
    for (const id of table.documentIds) {
      const document = await store.document(id), version = evidenceVersion(document)
      const relevant = allNotes.filter(note => note.documentId === id && note.field === selectedColumn.name && note.evidence.every(item => item.documentId === id && item.documentVersion === version)).slice(0, 3)
      noteVersions.push(...relevant.map(note => ({ id: note.id, revision: note.revision })))
      const current = findCell(table, id, columnId)
      const refs = [...current.evidence, ...relevant.flatMap(note => note.evidence)].filter(item => item.documentId === id && item.documentVersion === version).map(item => item.reference)
      const retrieval = comparisonReferences(document, selectedColumn)
      refs.push(...retrieval.references)
      let chars = 0, count = 0
      for (const ref of refs) {
        const key = `${id}:${ref.id}`
        if (evidenceMap.has(key) || count >= 6 || chars + ref.text.length > 6000) continue
        count++; chars += ref.text.length
        const captured = captureEvidence(document, [ref])[0]
        evidenceMap.set(key, captured)
        evidence.push({ id: key, documentId: id, text: ref.text, locator: ref.title, needsReview: Boolean(ref.needsReview) })
      }
      documents.push({ id, title: document.title, retrieval: { strategy: retrieval.strategy, query: retrieval.query, partial: retrieval.partial }, notes: relevant.map(note => ({ field: note.field, kind: note.kind, status: note.status, content: note.content.slice(0, 1000), reviewState: note.reviewState })) })
    }
    const input = { question: table.question, column: selectedColumn, documents, evidence }
    if (JSON.stringify(input).length > 100000) throw new HttpError(422, '比较材料过多，请缩小文献范围。')
    return { input, evidenceMap, noteVersions }
  }
  function validateResult(value, table, columnId, evidenceMap) {
    keys(value, ['cells', 'analysis'])
    if (!Array.isArray(value.cells) || value.cells.length !== table.documentIds.length) throw new Error('模型没有逐一返回所选文献的比较项。')
    const seen = new Set()
    function refs(ids, documentId = null) {
      if (!Array.isArray(ids) || ids.length > 72 || ids.some(id => typeof id !== 'string' || !evidenceMap.has(id))) throw new Error('建议引用了本次未读取的证据。')
      const result = [...new Set(ids)].map(id => evidenceMap.get(id))
      if (documentId && result.some(item => item.documentId !== documentId)) throw new Error('比较项引用了其他行的文献。')
      return structuredClone(result)
    }
    const cells = value.cells.map(item => {
      keys(item, ['documentId', 'value', 'status', 'kind', 'conditions', 'comparability', 'reason', 'referenceIds'])
      if (!table.documentIds.includes(item.documentId) || seen.has(item.documentId)) throw new Error('建议包含重复或范围外的文献。')
      seen.add(item.documentId)
      if (!['source', 'inference'].includes(item.kind) || item.status === 'unfilled') throw new Error('模型建议缺少有效判断类型或信息状态。')
      const cell = { ...emptyCell(item.documentId, columnId), value: item.value, status: item.status, kind: item.kind, conditions: item.conditions, comparability: item.comparability, reason: item.reason, evidence: refs(item.referenceIds, item.documentId), origin: { type: 'model', generatedKind: item.kind } }
      validateCell(cell)
      if (cell.status !== 'recorded' && cell.value) throw new Error('缺失信息不能作为确定的比较数值返回。')
      if (cell.status !== 'recorded' && cell.comparability !== 'unchecked') throw new Error('缺失信息的比较项必须保持待判断。')
      if (!cell.evidence.length && (cell.status !== 'not_found' || cell.comparability !== 'unchecked')) throw new Error('缺少证据的行只能标记为未找到、待判断。')
      return cell
    })
    const a = value.analysis
    keys(a, ['relation', 'value', 'conditions', 'referenceIds'])
    if (!relations.includes(a.relation)) throw new Error('模型综合判断类型无效。')
    const evidence = refs(a.referenceIds)
    if (a.relation !== 'insufficient' && new Set(evidence.map(item => item.documentId)).size < 2) throw new Error('跨文献判断需要至少两篇文献的证据。')
    return { cells, analysis: { columnId, definitionHash: hash([table.question, column(table, columnId)]), relation: a.relation, value: text(a.value, 6000, '综合判断', false), conditions: text(a.conditions, 2000, '比较条件'), evidence, origin: { type: 'model' }, reviewState: 'pending', rows: cells.map(cell => ({ documentId: cell.documentId, value: cell.value, status: cell.status, digest: hash(cell) })) } }
  }
  async function suggest(id, body) {
    keys(body, ['revision', 'columnId'])
    const table = await raw(id); revision(table, body.revision)
    const columnId = requireId(body.columnId)
    if (table.archived) throw new HttpError(409, '请先恢复已归档的比较表。')
    if (!modelConfigured(qaOptions.config)) throw new HttpError(409, '尚未配置模型，仍可手工比较或使用笔记和原文。')
    const { input, evidenceMap, noteVersions } = await prepare(table, columnId)
    const baseCells = table.documentIds.map(documentId => ({ documentId, digest: hash(findCell(table, documentId, columnId)) }))
    return runs.startJob({ purpose: 'comparison-suggestion', topicId: table.topicId, comparisonId: id, columnId, columnName: column(table, columnId).name, scopeHash: scope(table), baseCells, baseNotes: noteVersions, baseAnalysis: hash(table.analyses.find(item => item.columnId === columnId) || null) }, async options => validateResult(await generateComparison(input, { ...qaOptions, ...options }), table, columnId, evidenceMap))
  }
  async function adopt(id, body) {
    keys(body, ['revision', 'runId'])
    const run = await store.read('runs', requireId(body.runId))
    if (!run || run.status !== 'completed' || run.purpose !== 'comparison-suggestion' || run.comparisonId !== id || !run.result) throw new HttpError(422, '未找到可采用的本表建议。')
    return mutate(id, body.revision, async table => {
      if (table.archived || scope(table) !== run.scopeHash || run.baseCells.some(item => item.digest !== hash(findCell(table, item.documentId, run.columnId))) || run.baseAnalysis !== hash(table.analyses.find(item => item.columnId === run.columnId) || null)) throw new HttpError(409, '比较范围或本列内容已变化，旧建议不会覆盖修改。请重新生成或手动整理。')
      await requireRows(table.topicId, table.documentIds)
      if ((await Promise.all(run.baseNotes.map(async note => (await store.read('notes', note.id))?.revision !== note.revision))).some(Boolean)) throw new HttpError(409, '用于生成建议的笔记已更新，请重新生成。')
      const versions = new Map(await Promise.all(table.documentIds.map(async id => [id, evidenceVersion(await store.document(id))])))
      if ([...run.result.cells.flatMap(cell => cell.evidence), ...run.result.analysis.evidence].some(item => versions.get(item.documentId) !== item.documentVersion)) throw new HttpError(409, '原文已变化，请重新生成建议。')
      const cells = structuredClone(run.result.cells).map(cell => ({ ...cell, origin: { ...cell.origin, runId: run.id } }))
      table.cells = [...table.cells.filter(cell => cell.columnId !== run.columnId), ...cells]
      const analysis = { ...structuredClone(run.result.analysis), origin: { type: 'model', runId: run.id }, rows: cells.map(cell => ({ documentId: cell.documentId, value: cell.value, status: cell.status, digest: hash(cell) })) }
      table.analyses = [...table.analyses.filter(item => item.columnId !== run.columnId), analysis]
      return table
    })
  }
  return { list, get, create, edit, sources, editCell, editAnalysis, suggest, adopt }
}
