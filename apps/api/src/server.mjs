#!/usr/bin/env node
import { createServer } from 'node:http'
import { randomUUID, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HttpError, readJson, readUpload, sendJson } from './http.mjs'
import { createImports, parseInWorker } from './imports.mjs'
import { pageImageInWorker } from './render.mjs'
import { ocrCapabilities } from './ocr.mjs'
import { visionConfigured } from './vision.mjs'
import { createStore, requireId } from './store.mjs'
import { createRuns } from './runs.mjs'
import { modelConfigured } from './qa.mjs'
import { createTopics, documentSummary, editBibliography } from './topics.mjs'
import { createNotes } from './notes.mjs'
import { evidenceVersion } from './evidence.mjs'
import { createComparisons } from './comparisons.mjs'
import { createReports } from './reports.mjs'
import { deletionPreview } from './deletion-preview.mjs'
import { executeDeletion } from './deletions.mjs'
import { storageUsage } from './storage-usage.mjs'
import { environmentSettings, taskSettings } from './settings.mjs'
import { desktopRequestGuard } from './desktop-security.mjs'
import { acquireDataLock } from './data-lock.mjs'
import { modelSession } from './model-session.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
// Whole-report edits include up to 40 blocks, 30000 text characters and 960
// citation IDs, plus headings and source selectors. Allow their serialized form.
const reportEditBodyLimit = 1024 * 1024
export async function createApp({ dataDir = resolve(root, process.env.CLASSIFIER_DATA_DIR || 'data'), qaOptions = {}, settingsProvider = environmentSettings(), desktopToken, storeFactory = createStore, managedBackupDir } = {}) {
  const guard = desktopToken === undefined ? null : desktopRequestGuard(desktopToken)
  const ownership = await acquireDataLock(dataDir)
  let store
  try { store = await storeFactory(ownership.root) }
  catch (error) { ownership.release(); throw error }
  const runs = createRuns(store, qaOptions, settingsProvider)
  const topics = createTopics(store)
  const imports = createImports(store, topics, settingsProvider)
  const notes = createNotes(store, topics, runs, qaOptions, settingsProvider)
  const comparisons = createComparisons(store, topics, runs, qaOptions, settingsProvider)
  const reports = createReports(store, topics, comparisons, runs, qaOptions, settingsProvider)
  const modelSettings = modelSession(settingsProvider)
  let syncImports = 0
  let closing = false
  const requestTasks = new Set(), syncControllers = new Set()
  const mutationTasks = new Set()
  let deleting = false
  let rendering = false
  let usageTask = null
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/api.js', ['api.js', 'text/javascript; charset=utf-8']],
    ['/storage.js', ['storage.js', 'text/javascript; charset=utf-8']],
    ['/research.js', ['research.js', 'text/javascript; charset=utf-8']],
    ['/deletion-preview.js', ['deletion-preview.js', 'text/javascript; charset=utf-8']],
    ['/storage-usage.js', ['storage-usage.js', 'text/javascript; charset=utf-8']],
    ['/notes.js', ['notes.js', 'text/javascript; charset=utf-8']],
    ['/comparisons.js', ['comparisons.js', 'text/javascript; charset=utf-8']],
    ['/reports.js', ['reports.js', 'text/javascript; charset=utf-8']],
    ['/katex.mjs', ['../../node_modules/katex/dist/katex.mjs', 'text/javascript; charset=utf-8']],
    ['/katex.css', ['../../node_modules/katex/dist/katex.min.css', 'text/css; charset=utf-8']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ])
  const server = createServer((req, res) => {
    const target = req.method === 'DELETE' && /^\/api\/(documents|topics|notes|comparisons|reports)\/[^/]+$/.test(req.url.split('?')[0])
    const blocked = deleting && !['GET', 'HEAD'].includes(req.method)
    const ownsBarrier = target && !blocked
    const waitFor = ownsBarrier ? [...mutationTasks] : []
    if (ownsBarrier) deleting = true
    const task = handleRequest(req, res, { blocked, waitFor })
    requestTasks.add(task)
    if (!target && !blocked && !['GET', 'HEAD'].includes(req.method)) mutationTasks.add(task)
    void task.finally(() => { requestTasks.delete(task); mutationTasks.delete(task); if (ownsBarrier) deleting = false }).catch(error => console.error('Request failed:', error.message))
  })
  async function handleRequest(req, res, { blocked, waitFor }) {
    try {
      if (closing) throw new HttpError(503, '服务正在关闭。')
      res.setHeader('x-content-type-options', 'nosniff')
      res.setHeader('referrer-policy', 'no-referrer')
      res.setHeader('x-request-id', randomUUID())
      const origin = req.headers.origin
      if (guard) guard(req, server.address())
      else if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) throw new HttpError(403, '请从当前工作台发起请求。')
      if (blocked) throw new HttpError(409, '资料库正在执行删除，请稍后重试。')
      const url = new URL(req.url, 'http://localhost')
      const deleteTarget = url.pathname.match(/^\/api\/(documents|topics|notes|comparisons|reports)\/([^/]+)$/)
      if (deleteTarget && req.method === 'DELETE') {
        const body = await readJson(req)
        await Promise.allSettled(waitFor)
        if (closing) throw new HttpError(503, '服务正在关闭。')
        res.setHeader('cache-control', 'no-store')
        return sendJson(res, 200, await executeDeletion(store, runs, imports, { bucket: deleteTarget[1], id: deleteTarget[2], body, synchronousImports: syncImports }))
      }
      const deletion = url.pathname.match(/^\/api\/deletion-preview\/(documents|topics|notes|comparisons|reports)\/([^/]+)$/)
      if (deletion && req.method === 'GET') return sendJson(res, 200, await deletionPreview(store, { bucket: deletion[1], id: deletion[2], action: url.searchParams.get('action') || 'delete', topicId: url.searchParams.get('topicId'), synchronousImports: syncImports }))
      if (req.method === 'GET' && /^\/fonts\/KaTeX_[a-zA-Z0-9_-]+\.(woff2?|ttf)$/.test(url.pathname)) {
        res.writeHead(200, { 'content-type': url.pathname.endsWith('.woff2') ? 'font/woff2' : url.pathname.endsWith('.woff') ? 'font/woff' : 'font/ttf' })
        return res.end(await readFile(resolve(root, 'node_modules/katex/dist', url.pathname.slice(1))))
      }
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [name, type] = assets.get(url.pathname)
        res.writeHead(200, { 'content-type': type, 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'self'" })
        return res.end(await readFile(resolve(root, 'apps/web', name)))
      }
      if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { status: 'ok', service: 'classifier', modelConfigured: modelConfigured(taskSettings(settingsProvider, qaOptions).text) })
      if (req.method === 'GET' && url.pathname === '/api/library-health') return sendJson(res, 200, await store.health?.() || { issueCount: 0, issues: [], truncated: false })
      if (req.method === 'GET' && url.pathname === '/api/storage-usage') {
        res.setHeader('cache-control', 'no-store')
        usageTask ||= storageUsage(ownership.root, { managedBackupDir, inspectRecordBodies: store.inspectRecordBodies }).finally(() => { usageTask = null })
        return sendJson(res, 200, await usageTask)
      }
      if (url.pathname === '/api/settings/text-model') {
        res.setHeader('cache-control', 'no-store')
        if (req.method === 'GET') return sendJson(res, 200, modelSettings.get())
        if (req.method === 'PATCH') return sendJson(res, 200, modelSettings.update(await readJson(req)))
      }
      if (req.method === 'POST' && url.pathname === '/api/settings/model-authorization/revoke') {
        res.setHeader('cache-control', 'no-store')
        return sendJson(res, 200, modelSettings.revoke(await readJson(req)))
      }
      if (req.method === 'GET' && url.pathname === '/api/parser-capabilities') return sendJson(res, 200, { ocr: await ocrCapabilities(), vision: visionConfigured(settingsProvider.read().vision) })
      if (url.pathname === '/api/topics') {
        if (req.method === 'GET') return sendJson(res, 200, { topics: await topics.list() })
        if (req.method === 'POST') return sendJson(res, 201, await topics.create(await readJson(req)))
      }
      const topicReports = url.pathname.match(/^\/api\/topics\/([^/]+)\/(reports|report-materials)$/)
      if (topicReports) {
        const topicId = requireId(topicReports[1])
        if (topicReports[2] === 'report-materials' && req.method === 'GET') return sendJson(res, 200, await reports.catalog(topicId))
        if (topicReports[2] === 'reports' && req.method === 'GET') return sendJson(res, 200, { reports: await reports.list(topicId) })
        if (topicReports[2] === 'reports' && req.method === 'POST') return sendJson(res, 201, await reports.create(topicId, await readJson(req)))
      }
      const report = url.pathname.match(/^\/api\/reports\/([^/]+)(?:\/(history|assemble|suggestions|adopt|export))?$/)
      if (report) {
        const id = requireId(report[1]), action = report[2]
        if (!action && req.method === 'GET') return sendJson(res, 200, await reports.get(id))
        if (!action && req.method === 'PATCH') return sendJson(res, 200, await reports.edit(id, await readJson(req, reportEditBodyLimit)))
        if (action === 'history' && req.method === 'GET') return sendJson(res, 200, await reports.get(id, true))
        if (action === 'assemble' && req.method === 'POST') return sendJson(res, 200, await reports.assemble(id, await readJson(req)))
        if (action === 'suggestions' && req.method === 'POST') return sendJson(res, 202, await reports.suggest(id, await readJson(req)))
        if (action === 'adopt' && req.method === 'POST') return sendJson(res, 200, await reports.adopt(id, await readJson(req)))
        if (action === 'export' && req.method === 'GET') {
          const value = await reports.markdown(id, Number(url.searchParams.get('revision')))
          const name = value.title.replace(/[\r\n\\/]/g, '-').slice(0, 100) + '.md'
          res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, 'cache-control': 'no-store' })
          return res.end(value.markdown)
        }
      }
      const topicNotes = url.pathname.match(/^\/api\/topics\/([^/]+)\/notes$/)
      if (topicNotes && req.method === 'GET') return sendJson(res, 200, { notes: await notes.list(requireId(topicNotes[1])) })
      const topicComparisons = url.pathname.match(/^\/api\/topics\/([^/]+)\/comparisons$/)
      if (topicComparisons) {
        const topicId = requireId(topicComparisons[1])
        if (req.method === 'GET') return sendJson(res, 200, { comparisons: await comparisons.list(topicId) })
        if (req.method === 'POST') return sendJson(res, 201, await comparisons.create(topicId, await readJson(req)))
      }
      const comparison = url.pathname.match(/^\/api\/comparisons\/([^/]+)(?:\/(history|sources|cells|analyses|suggestions|adopt|draft|adopt-draft|report)(?:\/([^/]+))?(?:\/([^/]+))?)?$/)
      if (comparison) {
        const id = requireId(comparison[1]), action = comparison[2]
        if (action === 'draft' && req.method === 'POST') return sendJson(res, 202, await comparisons.suggestDraft(id, await readJson(req)))
        if (action === 'adopt-draft' && req.method === 'POST') return sendJson(res, 200, await comparisons.adoptDraft(id, await readJson(req)))
        if (action === 'report' && req.method === 'POST') return sendJson(res, 201, await reports.fromComparison(id, await readJson(req)))
        if (!action) {
          if (req.method === 'GET') return sendJson(res, 200, await comparisons.get(id))
          if (req.method === 'PATCH') return sendJson(res, 200, await comparisons.edit(id, await readJson(req)))
        }
        if (action === 'history' && req.method === 'GET') return sendJson(res, 200, await comparisons.get(id, true))
        if (action === 'sources' && req.method === 'GET') return sendJson(res, 200, await comparisons.sources(id, requireId(comparison[3])))
        if (action === 'cells' && req.method === 'PATCH') return sendJson(res, 200, await comparisons.editCell(id, requireId(comparison[3]), requireId(comparison[4]), await readJson(req)))
        if (action === 'analyses' && req.method === 'PATCH') return sendJson(res, 200, await comparisons.editAnalysis(id, requireId(comparison[3]), await readJson(req)))
        if (action === 'suggestions' && req.method === 'POST') return sendJson(res, 202, await comparisons.suggest(id, await readJson(req)))
        if (action === 'adopt' && req.method === 'POST') return sendJson(res, 200, await comparisons.adopt(id, await readJson(req)))
      }
      const documentNotes = url.pathname.match(/^\/api\/topics\/([^/]+)\/documents\/([^/]+)\/(notes|note-suggestions)$/)
      if (documentNotes) {
        const topicId = requireId(documentNotes[1]), documentId = requireId(documentNotes[2])
        if (documentNotes[3] === 'notes') {
          if (req.method === 'GET') return sendJson(res, 200, await notes.forDocument(topicId, documentId))
          if (req.method === 'POST') return sendJson(res, 201, await notes.create(topicId, documentId, await readJson(req)))
        } else if (req.method === 'POST') return sendJson(res, 202, await notes.suggest(topicId, documentId, await readJson(req)))
      }
      const noteMatch = url.pathname.match(/^\/api\/notes\/([^/]+)$/)
      if (noteMatch) {
        const id = requireId(noteMatch[1])
        if (req.method === 'GET') return sendJson(res, 200, await notes.get(id))
        if (req.method === 'PATCH') return sendJson(res, 200, await notes.edit(id, await readJson(req)))
      }
      const topicMatch = url.pathname.match(/^\/api\/topics\/([^/]+)(?:\/documents\/([^/]+))?$/)
      if (topicMatch) {
        const topicId = requireId(topicMatch[1]), documentId = topicMatch[2] && requireId(topicMatch[2])
        if (!documentId) {
          if (req.method === 'GET') return sendJson(res, 200, await topics.detail(topicId))
          if (req.method === 'PATCH') { await topics.edit(topicId, await readJson(req)); return sendJson(res, 200, await topics.detail(topicId)) }
        } else {
          if (req.method === 'PUT') { await topics.attach(topicId, documentId); return sendJson(res, 200, await topics.detail(topicId)) }
          if (req.method === 'PATCH') { await topics.editLink(topicId, documentId, await readJson(req)); return sendJson(res, 200, await topics.detail(topicId)) }
          if (req.method === 'DELETE') { await topics.detach(topicId, documentId); return sendJson(res, 200, await topics.detail(topicId)) }
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/imports') {
        const upload = await readUpload(req)
        if (!['auto', 'ocr', 'vision'].includes(upload.mode)) throw new HttpError(422, '无效解析模式。')
        return sendJson(res, 202, await imports.start(upload, upload.mode))
      }
      const importMatch = url.pathname.match(/^\/api\/imports\/([^/]+)(?:\/(cancel))?$/)
      if (importMatch) {
        const id = requireId(importMatch[1]), job = await store.read('imports', id)
        if (!job) throw new HttpError(404, '未找到导入任务。')
        if (req.method === 'GET' && !importMatch[2]) return sendJson(res, 200, job)
        if (req.method === 'POST' && importMatch[2] === 'cancel') return sendJson(res, 200, { cancellationRequested: imports.cancel(id) })
      }
      const pageMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/pages\/(\d+)$/)
      if (req.method === 'GET' && pageMatch) {
        const id = requireId(pageMatch[1]), document = await store.document(id), number = Number(pageMatch[2])
        if (document.mediaType !== 'application/pdf' || number < 1 || number > document.sections.length) throw new HttpError(404, '未找到 PDF 页面。')
        if (rendering) throw new HttpError(429, '正在生成页图，请稍后重试。')
        rendering = true
        const controller = new AbortController()
        const abort = () => { if (!res.writableEnded) controller.abort(new Error('页图请求已断开')) }
        res.once('close', abort)
        try {
          const png = await pageImageInWorker(await store.original(id), number, { signal: controller.signal })
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600' })
          return res.end(png)
        } finally { res.removeListener('close', abort); rendering = false }
      }
      if (req.method === 'GET' && url.pathname === '/api/documents') {
        const documents = await store.list('documents')
        return sendJson(res, 200, { documents: documents.map(documentSummary) })
      }
      if (req.method === 'POST' && url.pathname === '/api/documents') {
        const upload = await readUpload(req)
        if (upload.topicId) await topics.get(upload.topicId)
        const fileName = basename(upload.fileName.replaceAll('\\', '/')).slice(0, 200)
        let parsed
        if (syncImports >= 1) throw new HttpError(429, '正在导入文档，请稍后重试。')
        syncImports++
        const controller = new AbortController()
        syncControllers.add(controller)
        let savedDocumentId = null
        try {
          if (closing) throw new HttpError(503, '服务正在关闭。')
          try {
            parsed = await parseInWorker({ ...upload, fileName }, { signal: controller.signal })
            controller.signal.throwIfAborted()
          } catch (error) {
            if (controller.signal.aborted) throw new HttpError(503, '服务正在关闭。')
            throw error instanceof HttpError ? error : new HttpError(422, `文档解析失败：${error.message}`)
          }
          const document = {
            id: randomUUID(), schemaVersion: 2, fileName, ...parsed,
            source: { kind: 'upload', sha256: createHash('sha256').update(upload.bytes).digest('hex'), byteLength: upload.bytes.length },
            createdAt: new Date().toISOString(),
          }
          if (store.commitImport) {
            await store.commitImport(document, upload.bytes, { topicId: upload.topicId, signal: controller.signal, onCommitting: () => syncControllers.delete(controller) })
            return sendJson(res, 201, document)
          }
          await store.saveOriginal(document.id, upload.bytes)
          savedDocumentId = document.id
          if (controller.signal.aborted) throw new HttpError(503, '服务正在关闭。')
          syncControllers.delete(controller)
          await store.write('documents', document)
          if (upload.topicId) await topics.attach(upload.topicId, document.id)
          return sendJson(res, 201, document)
        } catch (error) {
          if (savedDocumentId && syncControllers.has(controller)) {
            try { await store.removeOriginal(savedDocumentId) }
            catch (cleanupError) { throw new Error(`${error.message}；原文件清理失败：${cleanupError.message}`, { cause: error }) }
          }
          throw error
        }
        finally { syncImports--; syncControllers.delete(controller) }
      }
      const match = url.pathname.match(/^\/api\/documents\/([^/]+)(?:\/(original|questions))?$/)
      if (match) {
        const id = requireId(match[1])
        const document = await store.document(id)
        if (req.method === 'PATCH' && !match[2]) return sendJson(res, 200, documentSummary(await editBibliography(store, id, await readJson(req))))
        if (req.method === 'GET' && match[2] === 'original') {
          const bytes = await store.original(id)
          res.writeHead(200, { 'content-type': document.mediaType, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(document.fileName)}`, 'cache-control': 'no-store' })
          return res.end(bytes)
        }
        if (req.method === 'GET' && !match[2]) {
          const history = (await store.list('runs')).filter(run => run.documentId === id && run.purpose !== 'note-suggestion')
          return sendJson(res, 200, { ...document, evidenceVersion: evidenceVersion(document), questions: history })
        }
        if (req.method === 'POST' && match[2] === 'questions') {
          const body = await readJson(req)
          const question = typeof body.question === 'string' ? body.question.trim() : ''
          if (!question || question.length > 4000) throw new HttpError(422, '问题需要 1–4000 个字符。')
          return sendJson(res, 202, await runs.start(id, question))
        }
      }
      const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)(?:\/(cancel))?$/)
      if (runMatch) {
        const id = requireId(runMatch[1])
        const run = await store.read('runs', id)
        if (!run) throw new HttpError(404, '未找到问答任务。')
        if (req.method === 'GET' && !runMatch[2]) return sendJson(res, 200, run)
        if (req.method === 'POST' && runMatch[2] === 'cancel') return sendJson(res, 200, { cancellationRequested: runs.cancel(id) })
      }
      throw new HttpError(404, '未找到此接口。')
    } catch (error) {
      if (res.headersSent || res.destroyed) return res.destroy()
      sendJson(res, error.status || 500, { error: error.status ? error.message : '服务处理失败，请查看服务日志。', ...(['RECORD_CORRUPT', 'RECORD_UNAVAILABLE'].includes(error.code) ? { code: error.code, bucket: error.bucket, id: error.id } : {}) })
      if (!error.status) console.error(error)
    }
  }
  let draining
  const drain = () => draining ||= (async () => {
    closing = true
    for (const controller of syncControllers) controller.abort(new Error('服务正在关闭。'))
    const results = await Promise.allSettled([runs.stop(), imports.stop(), ...requestTasks])
    try { await store.close?.() } finally { ownership.release() }
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), '资料库关闭期间发生错误。')
  })()
  server.on('close', () => { void drain().catch(error => console.error('Shutdown failed:', error.message)) })
  let shutdown
  server.shutdown = () => shutdown ||= (async () => {
    closing = true
    for (const controller of syncControllers) controller.abort(new Error('服务正在关闭。'))
    const closed = new Promise(resolve => {
      if (!server.listening) return resolve()
      server.close(resolve); server.closeAllConnections()
    })
    await Promise.all([closed, drain()])
  })()
  server.requestTimeout = 120_000
  return server
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createApp()
  const host = process.env.CLASSIFIER_HOST || '127.0.0.1'
  const port = Number(process.env.CLASSIFIER_PORT || 8790)
  server.listen(port, host, () => console.log(`Classifier: http://${host}:${port}`))
  for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => { void server.shutdown() })
}
