import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import JSZip from 'jszip'
import { DOMParser } from '@xmldom/xmldom'
import { parseDocx } from '../apps/api/src/docx.mjs'
import { reportFixture } from './helpers/report-fixture.mjs'
import { json, upload } from './helpers/test-app.mjs'
import { textPdf } from './helpers/pdf-fixture.mjs'

const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
async function fixture(t) {
  const app = await reportFixture(); t.after(() => app.close())
  let report = await app.value(`/api/topics/${app.topic.id}/reports`, json('POST', { title: '中文研究成果 & 原文定位', sources: app.selectors }), 201)
  const path = `/api/reports/${report.id}`
  report = await app.value(path + '/assemble', json('POST', { revision: report.revision }))
  return { app, report, path }
}
async function exported(app, path, revision) {
  const response = await app.request(`${path}/export?revision=${revision}&format=docx`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const bytes = Buffer.from(await response.arrayBuffer()), zip = await JSZip.loadAsync(bytes)
  for (const file of Object.values(zip.files).filter(file => /\.(xml|rels)$/.test(file.name))) {
    new DOMParser({ onError: () => { throw new Error('Invalid XML: ' + file.name) } }).parseFromString(await file.async('string'), 'application/xml')
  }
  return { response, zip, bytes, text: (await parseDocx(bytes)).sections[0].text }
}

test('DOCX export retains saved writing, Chinese headings, conditions, citation order and editable source locations without mutating the report', async t => {
  const { app, path } = await fixture(t)
  let report = await app.value(path)
  const blocks = report.blocks.map(({ id, section, text, kind, citationIds }) => ({ id, section, text, kind, citationIds }))
  blocks[0].text = '人工修订：仅限当前样本。\n指标\t数值 3.5 ± 0.2。'
  blocks[0].citationIds = [...report.evidence.map(item => item.id)].reverse()
  report = await app.value(path, json('PATCH', { revision: report.revision, blocks }))
  report = await app.value(path, json('PATCH', { revision: report.revision, reviewBlockId: report.blocks[0].id }))
  const before = await app.value(path + '/history'), result = await exported(app, path, report.revision)
  assert.equal(decodeURIComponent(result.response.headers.get('content-disposition').split("UTF-8''")[1]), report.title + '.docx')
  for (const expected of [report.title, report.question, blocks[0].text, '已核对', 'Researcher A', '2025', 'Evidence Journal', '10.1000/example', '适用条件：限于当前研究样本', '不可直接比较；测量条件不一致', app.first.references[0].title, app.first.references[0].text]) assert.ok(result.text.includes(expected), expected)
  const dom = new DOMParser().parseFromString(await result.zip.file('word/document.xml').async('string'), 'application/xml')
  const links = [...dom.getElementsByTagNameNS(word, 'hyperlink')]
  const bookmarks = [...dom.getElementsByTagNameNS(word, 'bookmarkStart')]
  assert.ok(links.length >= 2)
  assert.ok(links.every(node => bookmarks.some(bookmark => bookmark.getAttribute('w:name') === node.getAttribute('w:anchor'))))
  assert.equal(bookmarks[0].parentNode.textContent, '[1] ' + report.evidence.at(-1).documentTitle)
  assert.equal(dom.getElementsByTagNameNS(word, 'pgSz')[0].getAttribute('w:h'), '16838')
  const styles = await result.zip.file('word/styles.xml').async('string')
  assert.match(styles, /w:eastAsia="宋体"/); assert.match(styles, /w:outlineLvl w:val="0"/)
  const properties = new DOMParser().parseFromString(await result.zip.file('docProps/custom.xml').async('string'), 'application/xml')
  const identities = JSON.parse(properties.getElementsByTagNameNS('http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes', 'lpwstr')[0].textContent)
  assert.deepEqual(identities, [...report.evidence].reverse().map((item, index) => ({ number: index + 1, documentId: item.documentId, documentVersion: item.documentVersion, referenceId: item.reference.id })))
  for (const item of report.evidence) { assert.ok(!result.text.includes(item.documentId)); assert.ok(!result.text.includes(item.documentVersion)); assert.ok(!result.text.includes(item.reference.id)) }
  assert.match(result.text, /保存时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}（GMT[^）]*）/)
  assert.ok(!result.text.includes(report.updatedAt))
  const bodyParagraphs = [...dom.getElementsByTagNameNS(word, 'p')]
  const quoteIndex = bodyParagraphs.findIndex(node => node.textContent === app.second.references[0].text)
  assert.ok(quoteIndex > 0)
  for (let index = quoteIndex - 1; index >= 0 && !bodyParagraphs[index].getElementsByTagNameNS(word, 'bookmarkStart').length; index--) {
    assert.equal(bodyParagraphs[index].getElementsByTagNameNS(word, 'keepNext').length, 1, bodyParagraphs[index].textContent)
  }
  assert.deepEqual(await app.value(path + '/history'), before)
})

test('DOCX exports historical excerpts after source changes and missing originals, preserving warnings and excluding current replacement text', async t => {
  const { app, report, path } = await fixture(t)
  const file = join(app.dataDir, 'documents', app.first.id + '.json')
  const source = JSON.parse(await readFile(file, 'utf8'))
  source.references[0].text = '后来解析出的替换内容，不属于保存时的成果。'
  await writeFile(file, JSON.stringify(source))
  const changed = await exported(app, path, report.revision)
  assert.ok(changed.text.includes(app.first.references[0].text))
  assert.ok(changed.text.includes('原文已变化或不可用；保留历史摘录'))
  assert.ok(!changed.text.includes(source.references[0].text))
  await unlink(file)
  const missing = await exported(app, path, report.revision)
  assert.ok(missing.text.includes('原文缺失；保留历史摘录'))
  assert.ok(missing.text.includes(app.first.references[0].text))
  assert.ok(!missing.text.includes('原文已删除'))
  assert.equal((await app.value(path)).revision, report.revision)
})

test('DOCX treats imported markup and URLs as literal text, permits multilingual filenames, and rejects empty drafts, stale revisions and unsupported formats', async t => {
  const { app, report, path } = await fixture(t)
  const literal = '<script>alert("x")</script> & ![图](https://example.invalid/tracker)\n[1] 用户原文；\\frac{a}{b}；🧪'
  const title = '中'.repeat(99) + '🧪 / unsafe:*?'
  const saved = await app.value(path, json('PATCH', { revision: report.revision, title, blocks: [{ section: '特殊字符 < & >', text: literal, kind: 'user', citationIds: [] }] }))
  const result = await exported(app, path, saved.revision)
  assert.ok(result.text.includes(literal)); assert.ok(result.text.includes('特殊字符 < & >'))
  const filename = decodeURIComponent(result.response.headers.get('content-disposition').split("UTF-8''")[1])
  assert.equal(filename, '中'.repeat(99) + '🧪.docx')
  for (const file of Object.values(result.zip.files).filter(file => file.name.endsWith('.rels'))) {
    assert.ok(!(await file.async('string')).includes('TargetMode="External"'))
  }
  const xml = await result.zip.file('word/document.xml').async('string')
  assert.ok(!xml.includes('<script>')); assert.ok(!xml.includes('<w:fldSimple')); assert.ok(!xml.includes('<w:drawing'))
  assert.ok(result.text.includes('尚未关联原文引用。'))
  await app.value(`${path}/export?revision=${report.revision}&format=docx`, undefined, 409)
  await app.value(`${path}/export?revision=${saved.revision}&format=pdf`, undefined, 422)
  const empty = await app.value(`/api/topics/${app.topic.id}/reports`, json('POST', { title: '未采用的草稿' }), 201)
  await app.value(`/api/reports/${empty.id}/export?revision=1&format=docx`, undefined, 409)
})

test('DOCX preserves the cited original PDF page rather than the Word document pagination', async t => {
  const app = await reportFixture(); t.after(() => app.close())
  const imported = await app.value('/api/documents', upload(textPdf(2), 'two-page-source.pdf', app.topic.id), 201)
  const doc = await app.value(`/api/documents/${imported.id}`)
  const reference = doc.references.find(item => item.page === 2)
  assert.ok(reference)
  let report = await app.value(`/api/topics/${app.topic.id}/reports`, json('POST', { title: 'PDF 原文页码验收', sources: [{ type: 'passages', documentId: doc.id, documentVersion: doc.evidenceVersion, referenceIds: [reference.id] }] }), 201)
  const path = `/api/reports/${report.id}`
  report = await app.value(path + '/assemble', json('POST', { revision: report.revision }))
  const result = await exported(app, path, report.revision)
  assert.ok(result.text.includes(`原文：two-page-source.pdf · ${reference.title}`))
  assert.equal((result.text.match(/第\s*2\s*页/g) || []).length, 1)
  assert.ok(result.text.includes(reference.text))
})
