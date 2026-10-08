import { searchReferences } from './retrieval.mjs'

// Query expansion is deliberately limited to common comparison dimensions.
// Custom dimensions still use the supplied name and description as keywords.
const profiles = [
  { names: ['方法', '研究方法', '方法描述', '技术路线', 'method', 'methods', 'methodology', 'approach'],
    query: '方法 方法论 模型 架构 设计 算法 流程 method methodology approach architecture design procedure algorithm model',
    headings: 'methods?|methodology|approach|model architecture|proposed method|研究方法|方法|模型架构|技术路线' },
  { names: ['研究对象', '材料或对象', '材料', '研究材料', '样本', '数据集', 'participants', 'population', 'dataset', 'materials'],
    query: '研究对象 材料 样本 人群 数据集 任务 participants subjects population cohort sample dataset benchmark materials setting task',
    headings: 'participants|subjects|population|cohort|data(?:sets?)?|materials|experimental setup|study design|研究对象|材料|样本|数据集|实验设置' },
  { names: ['主要发现', '研究发现', '发现', '结果', '研究结果', '实验结果', 'findings', 'results', 'outcomes'],
    query: '主要发现 结果 结论 效果 性能 评估 results findings outcomes performance evaluation improvement conclusion',
    headings: 'results?|findings|evaluation|experiments|conclusions?|主要发现|结果|实验结果|结论' },
  { names: ['局限', '限制', '局限性', '研究局限', 'limitations', 'limitations and future work', 'limitation'],
    query: '局限 限制 不足 失败 假设 未来工作 limitation limitations weakness constraint failure caveat assumption drawback discussion future work',
    headings: 'limitations?|discussion|threats to validity|future work|conclusions?|局限|局限性|限制|不足|讨论|未来工作|结论' },
]
function headingPattern(headings) {
  return new RegExp(`^(?:#+\\s*)?(?:(?:[0-9]+(?:\\.[0-9]+)*[.)]?|[ivx]+[.)]?)\\s+)?(?:${headings})(?:\\s|[:：.]|$)`, 'i')
}
function sectionContext(references, pattern) {
  const result = []
  for (let index = 0; index < references.length; index++) {
    const ref = references[index], line = ref.text.replace(/\s+/g, ' ').trim()
    const titled = pattern.test(ref.title || '')
    if (!titled && !pattern.test(line)) continue
    if (titled || line.length > 120) result.push(ref)
    else {
      // A short heading is a locator, not sufficient evidence. Include its body.
      result.push(...references.slice(index + 1, index + 3).filter(item => item.text.trim()))
    }
    if (result.length >= 6) break
  }
  return result
}

export function comparisonReferences(document, column) {
  const name = column.name.normalize('NFKC').trim().toLowerCase()
  const profile = profiles.find(profile => profile.names.includes(name))
  const query = [column.name, profile?.query || '', column.description || ''].join(' ').trim()
  const byId = new Map(document.references.map(ref => [ref.id, ref]))
  const ranked = searchReferences(document, query, 12).map(ref => byId.get(ref.id))
  const section = profile ? sectionContext(document.references, headingPattern(profile.headings)) : []
  let references = [...section, ...ranked], strategy = profile ? 'expanded_keywords' : 'literal_keywords'
  if (!references.length && profile) {
    // This is a bounded reading sample, not a claim that the requested fact was found.
    references = sectionContext(document.references, headingPattern('abstract|summary|introduction|conclusions?|discussion|摘要|引言|结论|讨论'))
    if (!references.length) {
      const candidates = document.references.filter(ref => ref.text.trim())
      references = [0, Math.floor(candidates.length / 3), Math.floor(2 * candidates.length / 3)].map(index => candidates[index]).filter(Boolean)
    }
    strategy = 'context_sample'
  }
  references = [...new Map(references.map(ref => [ref.id, ref])).values()]
  return { references, query, strategy: references.length ? strategy : 'no_match', partial: true }
}
