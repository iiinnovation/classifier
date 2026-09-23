const stopWords = new Set(['的', '了', '是', '在', '和', '与', '该', '这', '这个', '如何', '什么', '为什么', '请', '介绍', '说明', 'the', 'a', 'an', 'of', 'is', 'are', 'what', 'how', 'and', 'in', 'to', 'this', 'paper'])
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })

export function terms(text) {
  return [...new Set([...segmenter.segment(text.normalize('NFKC').toLowerCase())]
    .filter(item => item.isWordLike && !stopWords.has(item.segment))
    .map(item => item.segment))].slice(0, 80)
}

export function searchReferences(document, query, limit = 6) {
  const tokens = terms(query)
  if (!tokens.length) return []
  const n = document.references.length
  const candidates = document.references.map(ref => ({ ref, tokens: terms(ref.text) }))
  const weights = new Map(tokens.map(token => [token, Math.log(1 + n / (1 + candidates.filter(item => item.tokens.includes(token)).length))]))
  return candidates.map(({ ref, tokens: content }) => {
    const text = ref.text.normalize('NFKC').toLowerCase()
    const score = tokens.reduce((sum, token) => sum + (content.includes(token) ? weights.get(token) : text.includes(token) ? weights.get(token) * 0.5 : 0), 0)
    return { ...ref, score }
  }).filter(ref => ref.score > 0).sort((a, b) => b.score - a.score).slice(0, limit)
}

export function referenceSummary(ref) {
  return { id: ref.id, title: ref.title, page: ref.page, excerpt: ref.text.slice(0, 260) }
}
