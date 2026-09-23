#!/usr/bin/env node
import { createServer } from 'node:http'
import { randomUUID, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HttpError, readJson, readUpload, sendJson } from './http.mjs'
import { createImports, parseInWorker } from './imports.mjs'
import { pageImage } from './pdf.mjs'
import { ocrCapabilities } from './ocr.mjs'
import { visionConfigured } from './vision.mjs'
import { createStore, requireId } from './store.mjs'
import { createRuns } from './runs.mjs'
import { modelConfigured } from './qa.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
export async function createApp({ dataDir = resolve(root, process.env.CLASSIFIER_DATA_DIR || 'data') } = {}) {
  const store = await createStore(dataDir)
  const runs = createRuns(store)
  const imports = createImports(store)
  let syncImports = 0
  let rendering = false
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/katex.mjs', ['../../node_modules/katex/dist/katex.mjs', 'text/javascript; charset=utf-8']],
    ['/katex.css', ['../../node_modules/katex/dist/katex.min.css', 'text/css; charset=utf-8']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ])
  const server = createServer(async (req, res) => {
    try {
      res.setHeader('x-content-type-options', 'nosniff')
      res.setHeader('referrer-policy', 'no-referrer')
      const origin = req.headers.origin
      if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) throw new HttpError(403, '请从当前工作台发起请求。')
      const url = new URL(req.url, 'http://localhost')
      if (req.method === 'GET' && /^\/fonts\/KaTeX_[a-zA-Z0-9_-]+\.(woff2?|ttf)$/.test(url.pathname)) {
        res.writeHead(200, { 'content-type': url.pathname.endsWith('.woff2') ? 'font/woff2' : url.pathname.endsWith('.woff') ? 'font/woff' : 'font/ttf' })
        return res.end(await readFile(resolve(root, 'node_modules/katex/dist', url.pathname.slice(1))))
      }
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [name, type] = assets.get(url.pathname)
        res.writeHead(200, { 'content-type': type, 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'self'" })
        return res.end(await readFile(resolve(root, 'apps/web', name)))
      }
      if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { status: 'ok', service: 'classifier', modelConfigured: modelConfigured() })
      if (req.method === 'GET' && url.pathname === '/api/parser-capabilities') return sendJson(res, 200, { ocr: await ocrCapabilities(), vision: visionConfigured() })
      if (req.method === 'POST' && url.pathname === '/api/imports') {
        const upload = await readUpload(req)
        if (!['auto', 'ocr', 'vision'].includes(upload.mode)) throw new HttpError(422, '无效解析模式。')
        if (upload.mode === 'vision' && !visionConfigured()) throw new HttpError(422, '尚未配置视觉模型。')
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
        try {
          const png = await pageImage(await store.original(id), number)
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600' })
          return res.end(png)
        } finally { rendering = false }
      }
      if (req.method === 'GET' && url.pathname === '/api/documents') {
        const documents = await store.list('documents')
        return sendJson(res, 200, { documents: documents.map(({ id, title, fileName, createdAt, references, warnings }) => ({ id, title, fileName, createdAt, referenceCount: references.length, warnings })) })
      }
      if (req.method === 'POST' && url.pathname === '/api/documents') {
        const upload = await readUpload(req)
        const fileName = basename(upload.fileName.replaceAll('\\', '/')).slice(0, 200)
        let parsed
        if (syncImports >= 1) throw new HttpError(429, '正在导入文档，请稍后重试。')
        syncImports++
        try { parsed = await parseInWorker({ ...upload, fileName }) }
        catch (error) { throw error instanceof HttpError ? error : new HttpError(422, `文档解析失败：${error.message}`) }
        finally { syncImports-- }
        const document = {
          id: randomUUID(), schemaVersion: 2, fileName, ...parsed,
          source: { kind: 'upload', sha256: createHash('sha256').update(upload.bytes).digest('hex'), byteLength: upload.bytes.length },
          createdAt: new Date().toISOString(),
        }
        await store.saveOriginal(document.id, upload.bytes)
        await store.write('documents', document)
        return sendJson(res, 201, document)
      }
      const match = url.pathname.match(/^\/api\/documents\/([^/]+)(?:\/(original|questions))?$/)
      if (match) {
        const id = requireId(match[1])
        const document = await store.document(id)
        if (req.method === 'GET' && match[2] === 'original') {
          const bytes = await store.original(id)
          res.writeHead(200, { 'content-type': document.mediaType, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(document.fileName)}`, 'cache-control': 'no-store' })
          return res.end(bytes)
        }
        if (req.method === 'GET' && !match[2]) {
          const history = (await store.list('runs')).filter(run => run.documentId === id)
          return sendJson(res, 200, { ...document, questions: history })
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
      if (res.headersSent) return res.destroy()
      sendJson(res, error.status || 500, { error: error.status ? error.message : '服务处理失败，请查看服务日志。' })
      if (!error.status) console.error(error)
    }
  })
  server.on('close', () => { runs.stop(); void imports.stop() })
  server.requestTimeout = 120_000
  return server
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createApp()
  const host = process.env.CLASSIFIER_HOST || '127.0.0.1'
  const port = Number(process.env.CLASSIFIER_PORT || 8790)
  server.listen(port, host, () => console.log(`Classifier: http://${host}:${port}`))
  for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => { server.close(); server.closeIdleConnections() })
}
