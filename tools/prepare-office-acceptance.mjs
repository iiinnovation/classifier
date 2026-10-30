import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { reportFixture } from '../tests/helpers/report-fixture.mjs'
import { json, upload } from '../tests/helpers/test-app.mjs'
import { textPdf } from '../tests/helpers/pdf-fixture.mjs'
import { parseDocx } from '../apps/api/src/docx.mjs'

// Generates synthetic reports through the real API in a temporary library.
// Output is reserved for acceptance work; existing samples are never replaced.
const output = resolve(process.argv[2] || 'docs/measurements/d4-office-2026-10-30')
await mkdir(output, { recursive: true })
const app = await reportFixture()
const samples = []
const expectedEdit = '办公软件编辑验收：此句已在 WPS 中修改并保存。'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
async function saveSample(name, report, checks) {
  const response = await app.request(`/api/reports/${report.id}/export?revision=${report.revision}&format=docx`)
  if (!response.ok) throw new Error((await response.json()).error)
  const bytes = Buffer.from(await response.arrayBuffer()), text = (await parseDocx(bytes)).sections[0].text
  for (const check of checks) if (!text.includes(check)) throw new Error(`Missing sample content: ${check}`)
  await writeFile(join(output, name + '.docx'), bytes, { flag: 'wx' })
  await writeFile(join(output, name + '.expected.txt'), text + '\n', { flag: 'wx' })
  samples.push({ file: name + '.docx', reportId: report.id, revision: report.revision, sha256: sha(bytes), bytes: bytes.length, bodyCharacters: report.blocks.reduce((total, block) => total + block.text.length, 0), blocks: report.blocks.length, selectedEvidence: report.evidence.length, citations: new Set(report.blocks.flatMap(block => block.citationIds)).size, checks })
}
try {
  const imported = await app.value('/api/documents', upload(textPdf(2), 'office-original-two-pages.pdf', app.topic.id), 201)
  await app.value(`/api/documents/${imported.id}`, json('PATCH', { title: '原文页码合成资料', authors: '验收作者；Test Author', year: '2026', venue: '办公兼容性验收样本', doi: '10.1000/office-fixture', url: 'https://example.invalid/source' }))
  const pdf = await app.value(`/api/documents/${imported.id}`), reference = pdf.references.find(item => item.page === 2)
  if (!reference) throw new Error('PDF page 2 fixture missing')
  const sources = [...app.selectors, { type: 'passages', documentId: pdf.id, documentVersion: pdf.evidenceVersion, referenceIds: [reference.id] }]
  async function reportWithBlocks(title, makeBlocks) {
    let report = await app.value(`/api/topics/${app.topic.id}/reports`, json('POST', { title, sources }), 201)
    report = await app.value(`/api/reports/${report.id}`, json('PATCH', { revision: report.revision, blocks: makeBlocks(report) }))
    return report
  }
  const short = await reportWithBlocks('办公验收：中文、引用与编辑', value => {
    const pdfId = value.evidence.find(item => item.documentId === pdf.id).id
    return [
      { section: '研究发现', text: '短文验收起点：中文科研标题和正文应清晰显示。\n适用条件：仅限当前样本；不同测量条件不直接合并数值。\n指标\t数值 3.5 ± 0.2；p < 0.05 & 比值 ≥ 1。🧪', kind: 'source', citationIds: [pdfId, value.evidence[0].id] },
      { section: '人工修订', text: '办公软件编辑验收：此句尚未修改。', kind: 'user', citationIds: [] },
      { section: '待验证事项', text: '编辑并保存后重新打开，正文、引用编号和原文第 2 页定位均应保留。', kind: 'question', citationIds: [pdfId] },
    ]
  })
  const checked = await app.value(`/api/reports/${short.id}`, json('PATCH', { revision: short.revision, reviewBlockId: short.blocks[0].id }))
  await saveSample('01-short', checked, ['短文验收起点', '已核对', '指标\t数值 3.5 ± 0.2', '办公软件编辑验收：此句尚未修改。', '第 2 页', '10.1000/office-fixture', '出处：[1]、[2]'])
  const long = await reportWithBlocks('办公验收：长文分页与多次引用', value => Array.from({ length: 24 }, (_, index) => {
    const sentence = `长文段落 ${index + 1}：研究对象、测量条件与结果解释需要一起阅读。不同样本不能直接合并数值，引用保留原始资料位置。`
    return { section: `章节 ${Math.floor(index / 4) + 1}：条件与证据`, text: `${index === 0 ? '长文验收起点。\n' : ''}${sentence.repeat(16)}\n段落 ${index + 1} 末尾标记。${index === 23 ? '\n长文验收终点。' : ''}`, kind: index % 2 ? 'user' : 'source', citationIds: [value.evidence[index % value.evidence.length].id] }
  }))
  await saveSample('02-long', long, ['长文验收起点', '长文验收终点', '章节 6：条件与证据', '段落 24 末尾标记。', '引用与原文定位', '第 2 页'])
  await app.changeDocument(app.first.id, doc => { doc.references[0].text = '后来的原文解析结果；此句不应进入已保存的摘录。' })
  const historical = await app.value(`/api/reports/${checked.id}`)
  await saveSample('03-historical', historical, [app.first.references[0].text, '保留历史摘录', '待核对', '第 2 页'])
  await writeFile(join(output, 'manifest.json'), JSON.stringify({ capturedAt: new Date().toISOString(), source: 'Real report export API with independent temporary synthetic library; no model calls.', expectedEdit, expectedOriginalEdit: '办公软件编辑验收：此句尚未修改。', samples, status: 'prepared; office UI acceptance pending' }, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ output, samples: samples.map(({ file, bodyCharacters, citations }) => ({ file, bodyCharacters, citations })) }))
} finally { await app.close() }
