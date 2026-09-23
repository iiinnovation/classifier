import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parseDocument } from '../apps/api/src/parser.mjs'

function pdfFixture() {
  const stream = 'BT /F1 12 Tf 72 720 Td (Microscopy study results) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = []
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const start = Buffer.byteLength(pdf)
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return Buffer.from(pdf)
}

test('PDF.js extracts text and preserves page locators', async () => {
  const document = await parseDocument('study.pdf', pdfFixture())
  assert.match(document.references[0].text, /Microscopy study results/)
  assert.equal(document.references[0].page, 1)
})

test('DOCX extracts paragraphs without inventing page numbers', async () => {
  const bytes = await readFile(new URL('./fixtures/study.docx', import.meta.url))
  const document = await parseDocument('study.docx', bytes)
  assert.match(document.references[0].text, /Microscopy study/)
  assert.equal(document.references[0].page, null)
  assert.equal(document.references[1].paragraph, 2)
})

test('text, markdown and HTML imports preserve research content', async () => {
  for (const [name, source] of [
    ['study.txt', '显微镜研究'], ['study.md', '# 文献笔记\n\n显微镜研究'],
    ['study.html', '<html><head><title>文献笔记</title></head><body><p>显微镜研究</p><script>doNotInclude()</script></body></html>'],
  ]) {
    const document = await parseDocument(name, Buffer.from(source))
    assert.ok(document.references.some(ref => ref.text.includes('显微镜研究')))
    assert.ok(document.references.every(ref => !ref.text.includes('doNotInclude')))
  }
  await assert.rejects(parseDocument('empty.txt', Buffer.from('  ')), /未提取到文字/)
  await assert.rejects(parseDocument('archive.zip', Buffer.from('bytes')), /支持 PDF/)
})
