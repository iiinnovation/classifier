import { randomUUID } from 'node:crypto'
import { HttpError } from './http.mjs'

const topicFields = { title: 200, question: 4000, scope: 2000 }
const bibliographyFields = { authors: 2000, year: 4, venue: 500, doi: 300, url: 2000 }
const relationFields = { selection: ['pending', 'included', 'excluded'], readingStatus: ['unread', 'reading', 'read'], relevance: 2000, reason: 2000 }

function validate(body, fields, required = []) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length) throw new HttpError(422, '请填写需要保存的内容。')
  const result = {}
  for (const [key, value] of Object.entries(body)) {
    const rule = fields[key]
    if (!Object.hasOwn(fields, key) || typeof value !== 'string') throw new HttpError(422, `无效字段：${key}。`)
    const trimmed = value.trim()
    if (Array.isArray(rule) ? !rule.includes(trimmed) : trimmed.length > rule) throw new HttpError(422, `字段 ${key} 的值或长度无效。`)
    result[key] = trimmed
  }
  if (required.some(key => !result[key])) throw new HttpError(422, '主题标题和研究问题不能为空。')
  return result
}

export function documentSummary(document) {
  const { id, title, fileName, createdAt, bibliography = {}, references, warnings } = document
  return { id, title, fileName, createdAt, bibliography, referenceCount: references.length, warnings }
}

export async function editBibliography(store, id, body) {
  const fields = validate(body, { title: 500, ...bibliographyFields })
  if (fields.title === '') throw new HttpError(422, '文献标题不能为空。')
  if (fields.year && !/^\d{4}$/.test(fields.year)) throw new HttpError(422, '年份请填写四位数字，或留空。')
  if (fields.doi) {
    fields.doi = fields.doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    if (!/^10\.\d{4,9}\/\S+$/i.test(fields.doi)) throw new HttpError(422, '请填写有效的 DOI，或留空。')
  }
  if (fields.url) {
    try { if (!['http:', 'https:'].includes(new URL(fields.url).protocol)) throw new Error() }
    catch { throw new HttpError(422, '来源链接需要以 http:// 或 https:// 开头。') }
  }
  return store.update('documents', id, document => {
    const { title, ...bibliography } = fields
    return { ...document, ...(title === undefined ? {} : { title }), bibliography: { ...document.bibliography, ...bibliography }, updatedAt: new Date().toISOString() }
  })
}

export function createTopics(store) {
  async function get(id) {
    const topic = await store.read('topics', id)
    if (!topic) throw new HttpError(404, '未找到研究主题。')
    return topic
  }
  function summary(topic) {
    const { documents, ...rest } = topic
    return { ...rest, documentCount: documents.length, includedCount: documents.filter(link => link.selection === 'included').length, readCount: documents.filter(link => link.readingStatus === 'read').length }
  }
  async function detail(id) {
    const topic = await get(id)
    const documents = await Promise.all(topic.documents.map(async link => ({ ...link, document: documentSummary(await store.document(link.documentId)) })))
    return { ...summary(topic), documents }
  }
  async function create(body) {
    const fields = validate(body, topicFields, ['title', 'question'])
    const now = new Date().toISOString()
    return store.write('topics', { id: randomUUID(), scope: '', ...fields, documents: [], createdAt: now, updatedAt: now })
  }
  async function edit(id, body) {
    const fields = validate(body, topicFields, ['title', 'question'].filter(key => Object.hasOwn(body, key)))
    return store.update('topics', id, topic => ({ ...topic, ...fields, updatedAt: new Date().toISOString() }))
  }
  async function attach(id, documentId) {
    await get(id)
    await store.document(documentId)
    return store.update('topics', id, topic => {
      if (topic.documents.some(link => link.documentId === documentId)) return topic
      const now = new Date().toISOString()
      return { ...topic, updatedAt: now, documents: [...topic.documents, { documentId, selection: 'pending', readingStatus: 'unread', relevance: '', reason: '', addedAt: now, updatedAt: now }] }
    })
  }
  async function editLink(id, documentId, body) {
    const fields = validate(body, relationFields)
    return store.update('topics', id, topic => {
      if (!topic.documents.some(link => link.documentId === documentId)) throw new HttpError(404, '文献尚未关联到该主题。')
      const now = new Date().toISOString()
      return { ...topic, updatedAt: now, documents: topic.documents.map(link => link.documentId === documentId ? { ...link, ...fields, updatedAt: now } : link) }
    })
  }
  async function detach(id, documentId) {
    return store.update('topics', id, topic => ({ ...topic, updatedAt: new Date().toISOString(), documents: topic.documents.filter(link => link.documentId !== documentId) }))
  }
  return { get, detail, create, edit, attach, editLink, detach, async list() { return (await store.list('topics')).map(summary) } }
}
