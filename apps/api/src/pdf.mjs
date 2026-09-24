import { fileURLToPath } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { getDocument, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { ocrCapabilities, recognizePage } from './ocr.mjs'
import { wordsToBlocks } from './structures.mjs'
import { ruledTables, alignedTables, insideTable, removeTableRules } from './tables.mjs'
import { recognizeStructures } from './vision.mjs'

export function openPdf(bytes) {
  const root = import.meta.resolve('pdfjs-dist/package.json')
  return getDocument({ data: new Uint8Array(bytes), isEvalSupported: false,
    standardFontDataUrl: fileURLToPath(new URL('./standard_fonts/', root)),
    cMapUrl: fileURLToPath(new URL('./cmaps/', root)), cMapPacked: true,
    wasmUrl: fileURLToPath(new URL('./wasm/', root)),
  })
}

export async function rasterPage(page, maxSide = 2200) {
  const base = page.getViewport({ scale: 1 })
  const scale = Math.min(3, maxSide / Math.max(base.width, base.height))
  const viewport = page.getViewport({ scale })
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  await page.render({ canvasContext: canvas.getContext('2d'), viewport, background: 'white' }).promise
  return canvas
}

export async function pageImage(bytes, number) {
  const task = openPdf(bytes)
  try {
    const pdf = await task.promise
    if (!Number.isInteger(number) || number < 1 || number > pdf.numPages) throw new Error('无效页码')
    const page = await pdf.getPage(number)
    return (await rasterPage(page, 1600)).toBuffer('image/png')
  } finally { await task.destroy() }
}

export function textWords(content, viewport) {
  return content.items.filter(item => item.str?.trim()).map(item => {
    const transform = Util.transform(viewport.transform, item.transform)
    const horizontal = Math.hypot(item.transform[0], item.transform[1]) || 1
    const vertical = Math.hypot(item.transform[2], item.transform[3]) || 1
    const width = item.width / horizontal, height = item.height / vertical
    const corners = [[0, 0], [width, 0], [0, height], [width, height]]
    corners.forEach(point => Util.applyTransform(point, transform))
    const left = Math.max(0, Math.min(viewport.width, ...corners.map(point => point[0])))
    const right = Math.max(0, Math.min(viewport.width, Math.max(...corners.map(point => point[0]))))
    const top = Math.max(0, Math.min(viewport.height, ...corners.map(point => point[1])))
    const bottom = Math.max(0, Math.min(viewport.height, Math.max(...corners.map(point => point[1]))))
    return { text: item.str, bbox: [left / viewport.width, top / viewport.height, (right - left) / viewport.width, (bottom - top) / viewport.height] }
  })
}

export async function parsePdf(bytes, { mode = 'auto', signal, onProgress = async () => {} } = {}) {
  const task = openPdf(bytes), sections = [], warnings = []
  const capabilities = await ocrCapabilities()
  let total = 0, ocrPages = 0
  try {
    const pdf = await task.promise
    if (pdf.numPages > 500) throw new Error('最多支持 500 页 PDF，请拆分后导入')
    for (let number = 1; number <= pdf.numPages; number++) {
      signal?.throwIfAborted()
      await onProgress({ page: number, totalPages: pdf.numPages, message: `正在解析第 ${number} / ${pdf.numPages} 页` })
      const page = await pdf.getPage(number)
      const viewport = page.getViewport({ scale: 1 })
      const content = await page.getTextContent()
      let words = textWords(content, viewport), source = 'pdf-text'
      const nativeLength = words.reduce((sum, word) => sum + word.text.trim().length, 0)
      const canvas = await rasterPage(page)
      let blocks
      if (mode === 'vision') {
        try { blocks = await recognizeStructures(canvas.toBuffer('image/png'), { signal }) }
        catch (error) { signal?.throwIfAborted(); warnings.push(`第 ${number} 页视觉识别未完成（${error.message}），改用本地解析。`) }
      }
      // Also catches scanned pages with a small native page number or watermark.
      if (!blocks && (mode === 'ocr' || nativeLength < 80)) {
        if (!capabilities.available) warnings.push(`第 ${number} 页需要 OCR，但没有可用的 Tesseract 语言包。`)
        else {
          try {
            await onProgress({ page: number, totalPages: pdf.numPages, message: `正在识别第 ${number} 页扫描文字` })
            const clean = removeTableRules(canvas)
            const recognized = await recognizePage(clean.toBuffer('image/png'), canvas.width, canvas.height, { signal, languages: capabilities.languages })
            if (recognized.length) {
              // Preserve native words when local OCR adds no useful content.
              const length = recognized.reduce((sum, word) => sum + word.text.length, 0)
              if (mode === 'ocr' || length > nativeLength * 1.2 || !nativeLength) { words = recognized; source = 'ocr'; ocrPages++ }
            }
          } catch (error) { signal?.throwIfAborted(); warnings.push(`第 ${number} 页：${error.message}，保留可读取文字。`) }
        }
      }
      if (!blocks) {
        // Border detection is bounded to a smaller raster; OCR keeps the higher resolution.
        const small = createCanvas(Math.round(canvas.width * 0.55), Math.round(canvas.height * 0.55))
        small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height)
        const tables = ruledTables(small, words)
        let paragraphs = wordsToBlocks(words.filter(word => !insideTable(word, tables)), source)
        const aligned = alignedTables(paragraphs)
        paragraphs = paragraphs.filter(block => !insideTable(block, aligned))
        blocks = [...paragraphs, ...tables, ...aligned]
        // Read left column top-to-bottom, then right, between full-width regions.
        const wide = blocks.filter(block => block.bbox[2] > 0.62 || block.type === 'table').sort((a, b) => a.bbox[1] - b.bbox[1])
        const remaining = blocks.filter(block => !wide.includes(block))
        const ordered = []
        for (const boundary of [...wide, null]) {
          const region = remaining.filter(block => !ordered.includes(block) && (!boundary || block.bbox[1] < boundary.bbox[1]))
          const twoColumns = region.filter(block => block.bbox[0] >= 0.48).length >= 3 && region.filter(block => block.bbox[0] + block.bbox[2] <= 0.52).length >= 3
          region.sort((a, b) => twoColumns && (a.bbox[0] >= 0.48) !== (b.bbox[0] >= 0.48) ? Number(a.bbox[0] >= 0.48) - Number(b.bbox[0] >= 0.48) : a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0])
          ordered.push(...region)
          if (boundary) ordered.push(boundary)
        }
        blocks = ordered
      }
      if (!blocks.length) warnings.push(`第 ${number} 页未识别出文字；仍可查看原始页图。`)
      if (blocks.some(block => block.type === 'formula')) warnings.push(`第 ${number} 页含公式：本地 PDF/OCR 只保留可见字符，分式、上下标和符号请核对页图。`)
      if (blocks.some(block => block.type === 'table')) warnings.push(`第 ${number} 页表格由版面推断，请核对行列、空单元格和跨页关系。`)
      const text = blocks.map(block => block.text).join('\n\n')
      total += text.length
      if (total > 2_000_000) throw new Error('文档内容过长，请拆分后导入')
      sections.push({ title: `第 ${number} 页`, page: number, text, blocks, width: viewport.width, height: viewport.height, extraction: blocks.some(block => block.source === 'vision') ? 'vision' : source })
      page.cleanup()
    }
  } finally { await task.destroy() }
  if (ocrPages) warnings.push(`已使用本地 OCR 识别 ${ocrPages} 页；数字、专有名词和公式需核对原图。`)
  if (capabilities.missing.length && ocrPages) warnings.push(`缺少 OCR 语言包：${capabilities.missing.join('、')}。`)
  warnings.push('PDF 图像中的公式及无边框复杂表格可能未被自动识别；请结合页图核对。跨页表格暂不自动合并。')
  return { sections, warnings }
}
