export function tableText(rows) {
  // Explicit coordinates preserve sparse grids and merged cells when read by a model.
  return rows.map((row, index) => `行 ${index + 1}: ` + row.map(cell =>
    `列 ${cell.column + 1}${cell.colSpan > 1 ? `–${cell.column + cell.colSpan}` : ''}${cell.rowSpan > 1 ? `（跨 ${cell.rowSpan} 行）` : ''}: ${cell.text || '空'}`
  ).join(' | ')).join('\n')
}

export function bboxUnion(boxes) {
  if (!boxes.length) return null
  const left = Math.min(...boxes.map(box => box[0]))
  const top = Math.min(...boxes.map(box => box[1]))
  return [left, top, Math.max(...boxes.map(box => box[0] + box[2])) - left, Math.max(...boxes.map(box => box[1] + box[3])) - top]
}

export function isFormula(text) {
  return /[=∑∫√∂∏≤≥≈∞]/u.test(text) && /[\p{L}\p{N}]/u.test(text) && text.length < 350
}

// Coordinates are normalized to the displayed page, including its rotation.
export function wordsToBlocks(words, source) {
  const lines = []
  for (const word of [...words].sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0])) {
    const center = word.bbox[1] + word.bbox[3] / 2
    let line = lines.find(item => Math.abs(item.center - center) < Math.max(word.bbox[3], item.height) * 0.45)
    if (!line) { line = { center, height: word.bbox[3], words: [] }; lines.push(line) }
    line.words.push(word)
  }
  return lines.map(line => {
    const sorted = line.words.sort((a, b) => a.bbox[0] - b.bbox[0])
    const chunks = []
    for (const word of sorted) {
      const last = chunks.at(-1)
      // Split widely separated columns; do not interleave two-column prose.
      if (!last || word.bbox[0] - (last.at(-1).bbox[0] + last.at(-1).bbox[2]) > 0.055) chunks.push([word])
      else last.push(word)
    }
    return chunks.map(chunk => {
      const text = chunk.map(word => word.text).join(' ').replace(/([\u3400-\u9fff]) (?=[\u3400-\u9fff])/g, '$1')
      return { type: isFormula(text) ? 'formula' : 'paragraph', text, bbox: bboxUnion(chunk.map(word => word.bbox)), source, needsReview: source === 'ocr' || isFormula(text), ...(isFormula(text) ? { formulaFormat: 'text' } : {}) }
    })
  }).flat()
}
