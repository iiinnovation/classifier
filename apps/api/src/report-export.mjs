import { sourceStateText } from './evidence.mjs'
const kinds = { source: '原文报告', inference: '模型归纳', user: '用户判断', question: '待验证问题' }
// Export text literally: imported documents cannot inject Markdown links or HTML.
const literal = value => String(value ?? '').replace(/[\\`*_{}\[\]<>#|!~]/g, '\\$&').replace(/^([ \t]*)([-+]|\d+[.)])(?=\s)/gm, '$1\\$2')

// Both exports read the same saved report snapshot. Presentation escaping belongs
// to the individual renderer, never to this format-independent representation.
export function reportExportDocument(report) {
  const citations = [...new Set(report.blocks.flatMap(block => block.citationIds))]
  const numbers = new Map(citations.map((id, index) => [id, index + 1]))
  return {
    title: report.title, question: report.question, revision: report.revision, updatedAt: report.updatedAt,
    materialWarning: report.sources.some(source => source.changed) ? '材料已有更新；以下正文和摘录保留保存时的版本，需复核。' : '',
    blocks: report.blocks.filter(block => block.text.trim()).map(block => ({
      section: block.section, text: block.text,
      attribution: `${kinds[block.kind]} · ${block.reviewState === 'checked' && !block.outdated ? '已核对' : '待核对'}`,
      sourceWarning: sourceStateText(block.sourceState, '来源材料') ? `${sourceStateText(block.sourceState, '来源材料')}；保留已保存段落。` : '',
      citationNumbers: block.citationIds.map(id => numbers.get(id)),
    })),
    citations: citations.map(id => {
      const item = report.evidence.find(item => item.id === id)
      return { ...structuredClone(item), number: numbers.get(id),
        versionStatus: sourceStateText(item.sourceState) ? sourceStateText(item.sourceState) + '；保留历史摘录，无法核对当前定位' : item.matchesCurrent ? '与当前原文一致' : '原文已变化或不可用；保留历史摘录' }
    }),
    materials: report.sources.map(source => ({ ...structuredClone(source),
      versionLabel: source.type === 'passages' ? '原文片段' : `版本 ${source.revision}`,
      statusLabel: sourceStateText(source.sourceState, '来源材料') || (source.changed ? '已变化，需复核' : '与当前材料一致'),
    })),
  }
}

export function reportMarkdown(document) {
  const lines = [`# ${literal(document.title)}`, '', `研究问题：${literal(document.question)}`, '', `成果版本：${document.revision} · 保存时间：${document.updatedAt}`, '']
  if (document.materialWarning) lines.push(document.materialWarning, '')
  let section
  for (const block of document.blocks) {
    if (section !== block.section) { lines.push(`## ${literal(block.section)}`, ''); section = block.section }
    lines.push(block.attribution, '', literal(block.text), '')
    if (block.sourceWarning) lines.push(block.sourceWarning, '')
    if (block.citationNumbers.length) lines.push(`出处：${block.citationNumbers.map(number => `[${number}]`).join('、')}`, '')
  }
  lines.push('## 引用与原文定位', '')
  if (!document.citations.length) lines.push('尚未关联原文引用。', '')
  for (const item of document.citations) {
    const bibliography = item.bibliography || {}, ref = item.reference
    lines.push(`### [${item.number}] ${literal(item.documentTitle)}`, '',
      [bibliography.authors, bibliography.year, bibliography.venue].filter(Boolean).map(literal).join(' · ') || '书目信息尚未补全。', '',
      `文件：${literal(item.fileName)} · 文献 ID：${item.documentId}`, '',
      `位置：${literal(ref.title)}${ref.page ? ` · 第 ${ref.page} 页` : ''} · 片段：${literal(ref.id)}`, '',
      `解析版本：${item.documentVersion} · ${item.versionStatus}`, '')
    if (bibliography.doi) lines.push(`DOI：${literal(bibliography.doi)}`, '')
    if (bibliography.url) lines.push(`来源链接：${literal(bibliography.url)}`, '')
    if (ref.needsReview) lines.push('识别内容待核对，请结合原文件检查。', '')
    lines.push(...literal(ref.text).split('\n').map(line => `> ${line}`), '')
  }
  lines.push('## 所用研究材料', '')
  if (!document.materials.length) lines.push('未选择研究材料。', '')
  for (const source of document.materials) {
    lines.push(`- ${literal(source.title)} · ${source.versionLabel} · ${source.statusLabel}`)
    for (const doc of source.documents) lines.push(`  - 文献：${literal(doc.title)} · ${literal(doc.fileName)}${doc.bibliography.authors ? ` · ${literal(doc.bibliography.authors)}` : ''}${doc.bibliography.year ? ` · ${literal(doc.bibliography.year)}` : ''}${sourceStateText(doc.sourceState) ? ` · ${sourceStateText(doc.sourceState)}` : ''}`)
  }
  return lines.join('\n') + '\n'
}
