import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { createCanvas } from '@napi-rs/canvas'
import JSZip from 'jszip'
import { parseDocument } from '../apps/api/src/parser.mjs'
import { openPdf, pageImage, rasterPage, textWords } from '../apps/api/src/pdf.mjs'
import { ruledTables, alignedTables } from '../apps/api/src/tables.mjs'
import { ocrCapabilities } from '../apps/api/src/ocr.mjs'
import { validatePage, recognizeStructures } from '../apps/api/src/vision.mjs'
import { parseInWorker } from '../apps/api/src/imports.mjs'

function imagePdf(canvas) {
  const rgba = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
  const rgb = Buffer.alloc(canvas.width * canvas.height * 3)
  for (let i = 0, j = 0; i < rgba.length; i += 4) { rgb[j++] = rgba[i]; rgb[j++] = rgba[i + 1]; rgb[j++] = rgba[i + 2] }
  const compressed = deflateSync(rgb)
  const stream = `q ${canvas.width} 0 0 ${canvas.height} 0 0 cm /Im0 Do Q`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${canvas.width} ${canvas.height}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`), compressed, Buffer.from('\nendstream')]),
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ]
  const chunks = [Buffer.from('%PDF-1.4\n')], offsets = []
  for (const [i, object] of objects.entries()) {
    offsets.push(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
    chunks.push(Buffer.from(`${i + 1} 0 obj\n`), Buffer.from(object), Buffer.from('\nendobj\n'))
  }
  const start = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  chunks.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`))
  return Buffer.concat(chunks)
}

test('local OCR reads image-only PDF and exposes normalized source locations', async t => {
  const capabilities = await ocrCapabilities()
  if (!capabilities.available) return t.skip('Tesseract language pack not installed')
  const canvas = createCanvas(1100, 900), context = canvas.getContext('2d')
  context.fillStyle = 'white'; context.fillRect(0, 0, 1100, 900)
  context.fillStyle = 'black'; context.font = '42px Arial'
  context.fillText('Microscopy research results', 70, 110)
  context.fillText('Treatment group: 42 samples', 70, 180)
  context.fillText('Control group: 21 samples', 70, 250)
  context.fillText('Mean accuracy = 0.95', 70, 320)
  context.font = '32px Arial'
  context.strokeStyle = 'black'; context.lineWidth = 2
  for (const y of [400, 500, 600, 700]) { context.beginPath(); context.moveTo(70, y); context.lineTo(1030, y); context.stroke() }
  for (const x of [70, 450, 730, 1030]) { context.beginPath(); context.moveTo(x, 400); context.lineTo(x, 700); context.stroke() }
  for (const [row, values] of [['Group', 'Count', 'Score'], ['Control', '21', '0.82'], ['Treated', '42', '0.95']].entries()) {
    values.forEach((value, col) => context.fillText(value, [90, 475, 750][col], 460 + row * 100))
  }
  const bytes = imagePdf(canvas)
  const document = await parseDocument('scan.pdf', bytes)
  assert.match(document.markdown, /Microscopy/i)
  assert.match(document.markdown, /42/)
  assert.equal(document.sections[0].extraction, 'ocr')
  assert.ok(document.references.every(ref => ref.page === 1 && ref.bbox?.length === 4 && ref.needsReview))
  assert.ok(document.references.some(ref => ref.type === 'formula'))
  const table = document.sections[0].blocks.find(block => block.type === 'table')
  assert.equal(table.rows[1][1].text, '21')
  assert.equal(table.rows[2][1].text, '42')
  assert.equal(table.rows[2][2].text, '0.95')
  const image = await pageImage(bytes, 1)
  assert.equal(image.subarray(1, 4).toString(), 'PNG')
})

test('ruled tables preserve merged headers, vertical merges and empty cells', () => {
  const canvas = createCanvas(800, 500), ctx = canvas.getContext('2d')
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 800, 500)
  ctx.strokeStyle = 'black'; ctx.lineWidth = 2
  const line = (x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke() }
  // Top header merges all columns; bottom first column merges two rows.
  line(100, 100, 700, 100); line(100, 180, 700, 180); line(300, 260, 700, 260); line(100, 340, 700, 340)
  line(100, 100, 100, 340); line(700, 100, 700, 340); line(300, 180, 300, 340); line(500, 180, 500, 340)
  const word = (text, x, y) => ({ text, bbox: [x / 800, y / 500, 0.08, 0.03] })
  const tables = ruledTables(canvas, [word('Results', 150, 130), word('Group', 150, 210), word('42', 350, 210), word('21', 550, 290)])
  assert.equal(tables.length, 1)
  assert.equal(tables[0].rows[0][0].colSpan, 3)
  assert.equal(tables[0].rows[1][0].rowSpan, 2)
  assert.equal(tables[0].rows[1][2].text, '')
  assert.equal(tables[0].rows[2][1].text, '21')
})

test('borderless numeric table remains explicitly unverified', () => {
  const blocks = [['Group', 'Count'], ['Control', '21'], ['Treated', '42']].flatMap((row, r) => row.map((text, c) => ({ text, bbox: [0.1 + c * 0.35, 0.1 + r * 0.04, 0.1, 0.02] })))
  const [table] = alignedTables(blocks)
  assert.equal(table.rows[2][1].text, '42')
  assert.equal(table.needsReview, true)
  assert.equal(alignedTables(blocks.map(block => ({ ...block, text: 'prose without numbers' }))).length, 0)
})

test('Word native fractions, radicals and merged cells retain structure', async () => {
  const zip = new JSZip()
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body>
    <w:p><m:oMath><m:f><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:rad><m:e><m:r><m:t>b</m:t></m:r></m:e></m:rad></m:den></m:f></m:oMath></w:p>
    <w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Results</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>Sample</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc><w:p><w:r><w:t>21</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl></w:body></w:document>`)
  const document = await parseDocument('study.docx', await zip.generateAsync({ type: 'nodebuffer' }))
  const [formula, table] = document.sections[0].blocks
  assert.equal(formula.latex, '\\frac{a}{\\sqrt{b}}')
  assert.equal(formula.needsReview, false)
  assert.match(formula.originalMath, /m:f/)
  assert.equal(table.rows[0][0].colSpan, 2)
  assert.equal(table.rows[1][0].rowSpan, 2)
  assert.equal(table.rows[2][0].column, 1)
  assert.equal(document.references[1].type, 'table')
})

test('Word formula properties preserve meaning or require review with original OMML', async () => {
  const run = value => `<m:r><m:t>${value}</m:t></m:r>`
  const math = value => `<w:p><m:oMath>${value}</m:oMath></w:p>`
  const formulas = [
    `<m:f><m:fPr><m:type m:val="noBar"/></m:fPr><m:num>${run('n')}</m:num><m:den>${run('k')}</m:den></m:f>`,
    `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg>${run('3')}</m:deg><m:e>${run('x')}</m:e></m:rad>`,
    `<m:nary><m:naryPr><m:chr m:val="∑"/><m:subHide m:val="1"/><m:supHide m:val="1"/></m:naryPr><m:sub>${run('0')}</m:sub><m:sup>${run('N')}</m:sup><m:e>${run('x')}</m:e></m:nary>`,
    `<m:d><m:dPr><m:begChr m:val="⟨"/><m:endChr m:val="⟩"/><m:sepChr m:val=","/></m:dPr><m:e>${run('a')}</m:e><m:e>${run('b')}</m:e></m:d>`,
    `<m:f><m:fPr><m:type m:val="lin"/></m:fPr><m:num>${run('a')}</m:num><m:den>${run('b')}</m:den></m:f>`,
    `<m:d><m:dPr><m:sepChr m:val="⁞"/></m:dPr><m:e>${run('a')}</m:e><m:e>${run('b')}</m:e></m:d>`,
  ]
  const zip = new JSZip()
  zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body>${formulas.map(math).join('')}</w:body></w:document>`)
  const document = await parseDocument('formula.docx', await zip.generateAsync({ type: 'nodebuffer' }))
  const blocks = document.sections[0].blocks
  assert.equal(blocks.length, formulas.length)
  assert.equal(blocks[0].latex, '\\genfrac{}{}{0pt}{}{n}{k}')
  assert.equal(blocks[1].latex, '\\sqrt{x}')
  assert.equal(blocks[2].latex, '\\sum x')
  assert.equal(blocks[3].latex, '\\left\\langle a , b \\right\\rangle')
  assert.ok(blocks.slice(0, 4).every(block => !block.needsReview))
  assert.ok(blocks.slice(4).every(block => block.needsReview && /m:(?:d|f)Pr/.test(block.originalMath)))
  assert.ok(document.references.slice(4).every(ref => ref.needsReview))
})

test('Word table cells retain paragraph, list, break, tab and formula boundaries', async () => {
  const zip = new JSZip()
  zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body><w:tbl><w:tr>
    <w:tc><w:p><w:r><w:t>12</w:t></w:r></w:p><w:p><w:r><w:t>34</w:t></w:r></w:p></w:tc>
    <w:tc><w:p><w:r><w:t>剂量</w:t></w:r><w:tab/><w:r><w:t>单位</w:t></w:r><w:br/><w:r><w:t>mg</w:t></w:r></w:p></w:tc>
    <w:tc><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>第一项</w:t></w:r></w:p><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>第二项</w:t></w:r><m:oMath><m:f><m:fPr><m:type m:val="lin"/></m:fPr><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:r><m:t>b</m:t></m:r></m:den></m:f></m:oMath></w:p></w:tc>
    </w:tr></w:tbl></w:body></w:document>`)
  const document = await parseDocument('table.docx', await zip.generateAsync({ type: 'nodebuffer' }))
  const table = document.sections[0].blocks[0]
  assert.equal(table.rows[0][0].text, '12\n34')
  assert.equal(table.rows[0][1].text, '剂量\t单位\nmg')
  assert.equal(table.rows[0][2].text, '第一项\n第二项\\frac{a}{b}')
  assert.match(table.rows[0][2].originalMath[0], /m:type m:val="lin"/)
  assert.equal(table.needsReview, true)
  assert.equal(document.references[0].needsReview, true)
})

test('rotated PDF text boxes follow transformed corners and stay in the correct table cell', () => {
  const item = { str: 'ROTATE', transform: [10, 0, 0, 10, 40, 50], width: 80, height: 10 }
  const viewport = rotation => ({ width: 200, height: 200, transform: rotation })
  const [ninety] = textWords({ items: [item] }, viewport([0, 1, 1, 0, 0, 0]))
  const [twoSeventy] = textWords({ items: [item] }, viewport([0, -1, -1, 0, 200, 200]))
  const [rotatedItem] = textWords({ items: [{ ...item, transform: [0, 10, -10, 0, 150, 40] }] }, viewport([1, 0, 0, 1, 0, 0]))
  assert.deepEqual(ninety.bbox, [0.25, 0.2, 0.05, 0.4])
  assert.deepEqual(twoSeventy.bbox, [0.7, 0.4, 0.05, 0.4])
  assert.deepEqual(rotatedItem.bbox, [0.7, 0.2, 0.05, 0.4])
  const canvas = createCanvas(200, 200), ctx = canvas.getContext('2d')
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 200, 200)
  ctx.strokeStyle = 'black'; ctx.lineWidth = 2
  for (const y of [20, 140, 190]) { ctx.beginPath(); ctx.moveTo(20, y); ctx.lineTo(150, y); ctx.stroke() }
  for (const x of [20, 80, 150]) { ctx.beginPath(); ctx.moveTo(x, 20); ctx.lineTo(x, 190); ctx.stroke() }
  const [table] = ruledTables(canvas, [ninety])
  assert.equal(table.rows[0][0].text, 'ROTATE')
  assert.equal(table.rows[0][1].text, '')
})

test('real 90° and 270° PDF pages place citation boxes over rendered text', async () => {
  const stream = 'BT /F1 20 Tf 40 80 Td (ROTATED TEXT) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 160] /Rotate 90 /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 160] /Rotate 270 /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ]
  let source = '%PDF-1.4\n'
  const offsets = []
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source))
    source += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const start = Buffer.byteLength(source)
  source += `xref\n0 7\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  const task = openPdf(Buffer.from(source))
  try {
    const pdf = await task.promise
    for (const number of [1, 2]) {
      const page = await pdf.getPage(number)
      const [word] = textWords(await page.getTextContent(), page.getViewport({ scale: 1 }))
      assert.equal(word.text, 'ROTATED TEXT')
      assert.ok(word.bbox[3] > word.bbox[2] * 3)
      const canvas = await rasterPage(page, 500)
      const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
      let ink = 0, inside = 0
      const inkBounds = [canvas.width, canvas.height, 0, 0]
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const at = (y * canvas.width + x) * 4
        if (data[at] + data[at + 1] + data[at + 2] > 300) continue
        ink++
        inkBounds[0] = Math.min(inkBounds[0], x); inkBounds[1] = Math.min(inkBounds[1], y)
        inkBounds[2] = Math.max(inkBounds[2], x); inkBounds[3] = Math.max(inkBounds[3], y)
        if (x / canvas.width >= word.bbox[0] - 0.025 && x / canvas.width <= word.bbox[0] + word.bbox[2] + 0.025
          && y / canvas.height >= word.bbox[1] - 0.025 && y / canvas.height <= word.bbox[1] + word.bbox[3] + 0.025) inside++
      }
      assert.ok(ink > 100)
      assert.ok(inside / ink > 0.95, `page ${number}: only ${inside}/${ink} ink pixels in citation box ${word.bbox}, ink ${inkBounds}, canvas ${canvas.width}x${canvas.height}`)
      page.cleanup()
    }
  } finally { await task.destroy() }
})

test('visual enhancement validates coordinates, merged cells and truncated responses', async () => {
  assert.throws(() => validatePage({ blocks: [{ type: 'formula', text: 'x', bbox: [0.8, 0, 0.8, 1] }] }), /坐标/)
  assert.throws(() => validatePage({ blocks: [{ type: 'table', bbox: [0, 0, 1, 1], rows: [[{ text: 'a', column: 0, colSpan: 2, rowSpan: 1 }, { text: 'b', column: 1, colSpan: 1, rowSpan: 1 }]] }] }), /重叠/)
  const config = { url: 'https://unused.invalid', key: 'test', model: 'test' }
  await assert.rejects(recognizeStructures(Buffer.from('png'), { config, fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'length' }] }) }) }), /截断/)
})

test('parser workers can be cancelled before processing finishes', async () => {
  const controller = new AbortController()
  controller.abort(new Error('test cancellation'))
  await assert.rejects(parseInWorker({ fileName: 'sample.txt', bytes: Buffer.from('sample'), contentType: 'text/plain' }, { signal: controller.signal }), /test cancellation/)
})
