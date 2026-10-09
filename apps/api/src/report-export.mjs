const kinds = { source: '原文报告', inference: '模型归纳', user: '用户判断', question: '待验证问题' }
// Export text literally: imported documents cannot inject Markdown links or HTML.
const literal = value => String(value ?? '').replace(/[\\`*_{}\[\]<>#|!~]/g, '\\$&').replace(/^([ \t]*)([-+]|\d+[.)])(?=\s)/gm, '$1\\$2')

export function reportMarkdown(report) {
  const citations = [...new Set(report.blocks.flatMap(block => block.citationIds))]
  const numbers = new Map(citations.map((id, index) => [id, index + 1]))
  const lines = [`# ${literal(report.title)}`, '', `研究问题：${literal(report.question)}`, '', `成果版本：${report.revision} · 保存时间：${report.updatedAt}`, '']
  if (report.sources.some(source => source.changed)) lines.push('材料已有更新；以下正文和摘录保留保存时的版本，需复核。', '')
  let section
  for (const block of report.blocks) {
    if (!block.text.trim()) continue
    if (section !== block.section) { lines.push(`## ${literal(block.section)}`, ''); section = block.section }
    lines.push(`${kinds[block.kind]} · ${block.reviewState === 'checked' && !block.outdated ? '已核对' : '待核对'}`, '', literal(block.text), '')
    if (block.citationIds.length) lines.push(`出处：${block.citationIds.map(id => `[${numbers.get(id)}]`).join('、')}`, '')
  }
  lines.push('## 引用与原文定位', '')
  if (!citations.length) lines.push('尚未关联原文引用。', '')
  for (const id of citations) {
    const item = report.evidence.find(item => item.id === id), bibliography = item.bibliography || {}, ref = item.reference
    lines.push(`### [${numbers.get(id)}] ${literal(item.documentTitle)}`, '',
      [bibliography.authors, bibliography.year, bibliography.venue].filter(Boolean).map(literal).join(' · ') || '书目信息尚未补全。', '',
      `文件：${literal(item.fileName)} · 文献 ID：${item.documentId}`, '',
      `位置：${literal(ref.title)}${ref.page ? ` · 第 ${ref.page} 页` : ''} · 片段：${literal(ref.id)}`, '',
      `解析版本：${item.documentVersion} · ${item.matchesCurrent ? '与当前原文一致' : '原文已变化或不可用；保留历史摘录'}`, '')
    if (bibliography.doi) lines.push(`DOI：${literal(bibliography.doi)}`, '')
    if (bibliography.url) lines.push(`来源链接：${literal(bibliography.url)}`, '')
    if (ref.needsReview) lines.push('识别内容待核对，请结合原文件检查。', '')
    lines.push(...literal(ref.text).split('\n').map(line => `> ${line}`), '')
  }
  lines.push('## 所用研究材料', '')
  if (!report.sources.length) lines.push('未选择研究材料。', '')
  for (const source of report.sources) {
    lines.push(`- ${literal(source.title)} · ${source.type === 'passages' ? '原文片段' : `版本 ${source.revision}`} · ${source.changed ? '已变化，需复核' : '与当前材料一致'}`)
    for (const doc of source.documents) lines.push(`  - 文献：${literal(doc.title)} · ${literal(doc.fileName)}${doc.bibliography.authors ? ` · ${literal(doc.bibliography.authors)}` : ''}${doc.bibliography.year ? ` · ${literal(doc.bibliography.year)}` : ''}`)
  }
  return lines.join('\n') + '\n'
}
