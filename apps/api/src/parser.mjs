import { extname } from 'node:path'
import { parsePdf } from './pdf.mjs'
import { parseDocx } from './docx.mjs'
import { HttpError } from './http.mjs'
import { parseHtmlDocument } from './html-parser.mjs'

const MAX_TEXT = 2_000_000
// Keep all parsed text. Each reference has an exact locator and a complete bounded passage.
export function buildReferences(sections) {
  const references = []
  let blockNumber = 0
  for (const section of sections) {
    const blocks = section.blocks || section.text.split(/\n\s*\n/).map(text => text.trim()).filter(Boolean).map((text, i) => ({ type: 'paragraph', text, paragraph: i + 1, source: 'text', needsReview: false }))
    for (const block of blocks) {
      blockNumber++
      block.id = `block_${String(blockNumber).padStart(5, '0')}`
      const label = block.type === 'table' ? '表格' : block.type === 'formula' ? '公式' : '段'
      // Bound reference size; the complete table/formula remains in sections[].blocks[].
      const size = block.type === 'paragraph' ? 1200 : 12000
      for (let offset = 0; offset < block.text.length; offset += size) {
        references.push({
          id: `ref_${String(references.length + 1).padStart(5, '0')}`,
          blockId: block.id, page: section.page ?? null, section: section.title,
          paragraph: block.paragraph || blockNumber, offset, text: block.text.slice(offset, offset + size),
          title: `${section.title} · ${label} ${block.paragraph || block.tableIndex || blockNumber}${offset ? `（续 ${offset}）` : ''}`,
          type: block.type, bbox: block.bbox || null, source: block.source, needsReview: block.needsReview,
          ...(block.type === 'formula' ? { latex: block.latex, formulaFormat: block.formulaFormat } : {}),
        })
      }
    }
    section.blocks = blocks
  }
  return references
}

export async function parseDocument(fileName, bytes, contentType = '', options = {}) {
  const extension = extname(fileName).toLowerCase()
  let sections, title = fileName.replace(/\.[^.]+$/, ''), mediaType = 'text/plain'
  const warnings = []
  if (extension === '.pdf' || bytes.subarray(0, 5).toString() === '%PDF-') {
    const parsed = await parsePdf(bytes, options)
    sections = parsed.sections
    warnings.push(...parsed.warnings)
    mediaType = 'application/pdf'
  } else if (extension === '.docx') {
    const parsed = await parseDocx(bytes)
    sections = parsed.sections
    warnings.push(...parsed.warnings)
    mediaType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  } else if (['.md', '.txt', '.markdown'].includes(extension)) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim()
    title = text.match(/^#\s+(.+)$/m)?.[1] || title
    sections = [{ title: '文档正文', text }]
    mediaType = extension === '.txt' ? 'text/plain' : 'text/markdown'
  } else if (extension === '.html' || contentType.includes('text/html')) {
    const parsed = parseHtmlDocument(bytes.toString('utf8'), '', fileName)
    title = parsed.title
    sections = parsed.blocks.map((text, index) => ({ title: `网页段落 ${index + 1}`, text }))
    warnings.push('已提取网页文字；图片和动态加载内容需要另行解析。')
    mediaType = 'text/html'
  } else throw new HttpError(415, '支持 PDF、DOCX、Markdown、TXT 和 HTML。')
  const length = sections.reduce((sum, item) => sum + item.text.length, 0)
  if (length > MAX_TEXT) throw new HttpError(422, '文档内容过长，请拆分后导入。')
  if (!length && mediaType !== 'application/pdf') throw new HttpError(422, '未提取到文字，请检查文档内容。')
  return {
    title, mediaType, sections, references: buildReferences(sections), warnings,
    markdown: sections.map(item => `## ${item.title}\n\n${item.text}`).join('\n\n'),
  }
}
