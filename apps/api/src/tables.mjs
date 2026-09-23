import { tableText, bboxUnion } from './structures.mjs'
import { createCanvas } from '@napi-rs/canvas'

function cluster(values, tolerance = 3) {
  const groups = []
  for (const value of [...values].sort((a, b) => a - b)) {
    const last = groups.at(-1)
    if (last && value - last.at(-1) <= tolerance) last.push(value)
    else groups.push([value])
  }
  return groups.map(group => group.reduce((sum, value) => sum + value, 0) / group.length)
}

// Detect long dark borders. Work on a bounded raster, rather than assuming PDF drawing operators.
function borderSegments(canvas) {
  const { width, height } = canvas
  const { data } = canvas.getContext('2d').getImageData(0, 0, width, height)
  const dark = (x, y) => {
    const i = (y * width + x) * 4
    return data[i + 3] > 100 && data[i] + data[i + 1] + data[i + 2] < 420
  }
  function scan(horizontal) {
    const segments = [], outer = horizontal ? height : width, inner = horizontal ? width : height
    const min = horizontal ? Math.max(70, width * 0.12) : Math.max(35, height * 0.025)
    for (let a = 0; a < outer; a++) {
      let start = -1, end = -1
      const emit = () => { if (start >= 0 && end - start >= min) segments.push({ at: a, start, end }); start = -1 }
      for (let b = 0; b < inner; b++) {
        if (horizontal ? dark(b, a) : dark(a, b)) { if (start < 0) start = b; end = b }
        else if (start >= 0 && b - end > 2) emit()
      }
      emit()
    }
    // Consolidate stroke thickness.
    return segments.filter((line, i) => !segments.slice(Math.max(0, i - 20), i).some(other =>
      Math.abs(other.at - line.at) <= 2 && Math.abs(other.start - line.start) < 4 && Math.abs(other.end - line.end) < 4))
  }
  return { hs: scan(true), vs: scan(false) }
}

export function removeTableRules(canvas) {
  const { hs, vs } = borderSegments(canvas)
  if (hs.length > 800 || vs.length > 800) return canvas
  const intersects = (h, v) => v.at >= h.start - 4 && v.at <= h.end + 4 && h.at >= v.start - 4 && h.at <= v.end + 4
  const horizontal = hs.filter(h => vs.filter(v => intersects(h, v)).length >= 2)
  const vertical = vs.filter(v => hs.filter(h => intersects(h, v)).length >= 2)
  if (horizontal.length < 3 || vertical.length < 3) return canvas
  const clean = createCanvas(canvas.width, canvas.height), ctx = clean.getContext('2d')
  ctx.drawImage(canvas, 0, 0); ctx.fillStyle = 'white'
  for (const line of horizontal) ctx.fillRect(line.start - 1, line.at - 2, line.end - line.start + 3, 5)
  for (const line of vertical) ctx.fillRect(line.at - 2, line.start - 1, 5, line.end - line.start + 3)
  return clean
}

export function ruledTables(canvas, words) {
  const { width, height } = canvas
  const { hs, vs } = borderSegments(canvas)
  if (hs.length > 800 || vs.length > 800) return []
  const intersects = (h, v) => v.at >= h.start - 4 && v.at <= h.end + 4 && h.at >= v.start - 4 && h.at <= v.end + 4
  const visited = new Set(), tables = []
  for (let start = 0; start < hs.length; start++) {
    if (visited.has(start)) continue
    const horizontal = new Set([start]), vertical = new Set(), pending = [start]
    while (pending.length) {
      const index = pending.pop()
      visited.add(index)
      for (let v = 0; v < vs.length; v++) if (!vertical.has(v) && intersects(hs[index], vs[v])) {
        vertical.add(v)
        for (let h = 0; h < hs.length; h++) if (!horizontal.has(h) && intersects(hs[h], vs[v])) { horizontal.add(h); pending.push(h) }
      }
    }
    const hLines = [...horizontal].map(i => hs[i]), vLines = [...vertical].map(i => vs[i])
    const xs = cluster(vLines.map(line => line.at)), ys = cluster(hLines.map(line => line.at))
    if (xs.length < 3 || ys.length < 3 || xs.length > 41 || ys.length > 201) continue
    const cols = xs.length - 1, rowCount = ys.length - 1
    const parent = Array.from({ length: cols * rowCount }, (_, i) => i)
    const root = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
    const merge = (a, b) => { parent[root(a)] = root(b) }
    const border = (lines, at, a, b) => lines.some(line => Math.abs(line.at - at) < 4 && line.start <= a + 4 && line.end >= b - 4)
    for (let r = 0; r < rowCount; r++) for (let c = 0; c < cols; c++) {
      if (c < cols - 1 && !border(vLines, xs[c + 1], ys[r], ys[r + 1])) merge(r * cols + c, r * cols + c + 1)
      if (r < rowCount - 1 && !border(hLines, ys[r + 1], xs[c], xs[c + 1])) merge(r * cols + c, (r + 1) * cols + c)
    }
    const groups = new Map()
    for (let i = 0; i < parent.length; i++) { const key = root(i); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(i) }
    const rows = Array.from({ length: rowCount }, () => [])
    let invalid = false
    for (const group of groups.values()) {
      const r0 = Math.min(...group.map(i => Math.floor(i / cols))), r1 = Math.max(...group.map(i => Math.floor(i / cols)))
      const c0 = Math.min(...group.map(i => i % cols)), c1 = Math.max(...group.map(i => i % cols))
      if (group.length !== (r1 - r0 + 1) * (c1 - c0 + 1)) { invalid = true; break }
      const inside = words.filter(word => {
        const x = (word.bbox[0] + word.bbox[2] / 2) * width, y = (word.bbox[1] + word.bbox[3] / 2) * height
        return x >= xs[c0] && x < xs[c1 + 1] && y >= ys[r0] && y < ys[r1 + 1]
      }).sort((a, b) => Math.abs(a.bbox[1] - b.bbox[1]) < 0.01 ? a.bbox[0] - b.bbox[0] : a.bbox[1] - b.bbox[1])
      rows[r0].push({ column: c0, colSpan: c1 - c0 + 1, rowSpan: r1 - r0 + 1, text: inside.map(word => word.text).join(' ') })
    }
    if (invalid || !rows.some(row => row.some(cell => cell.text))) continue
    rows.forEach(row => row.sort((a, b) => a.column - b.column))
    tables.push({ type: 'table', rows, text: tableText(rows), bbox: [xs[0] / width, ys[0] / height, (xs.at(-1) - xs[0]) / width, (ys.at(-1) - ys[0]) / height], source: 'layout', needsReview: true })
  }
  return tables
}

export function insideTable(word, tables) {
  const x = word.bbox[0] + word.bbox[2] / 2, y = word.bbox[1] + word.bbox[3] / 2
  return tables.some(({ bbox: [left, top, width, height] }) => x >= left && x <= left + width && y >= top && y <= top + height)
}

// Conservative fallback for short, aligned cells in borderless numeric tables.
export function alignedTables(blocks) {
  const lines = []
  for (const block of blocks) {
    let line = lines.find(items => Math.abs(items[0].bbox[1] - block.bbox[1]) < 0.009)
    if (!line) { line = []; lines.push(line) }
    line.push(block)
  }
  lines.sort((a, b) => a[0].bbox[1] - b[0].bbox[1])
  const tables = []
  for (let i = 0; i < lines.length; i++) {
    const first = lines[i].sort((a, b) => a.bbox[0] - b.bbox[0])
    if (first.length < 2 || first.length > 12 || first.some(block => block.text.length > 60)) continue
    const group = [first]
    while (i + group.length < lines.length) {
      const next = lines[i + group.length].sort((a, b) => a.bbox[0] - b.bbox[0])
      if (next.length !== first.length || next.some((block, c) => block.text.length > 60 || Math.abs(block.bbox[0] - first[c].bbox[0]) > 0.02)
        || next[0].bbox[1] - group.at(-1)[0].bbox[1] > 0.05) break
      group.push(next)
    }
    if (group.length < 3 || group.flat().filter(block => /\d/.test(block.text)).length < group.flat().length / 3) continue
    const rows = group.map(row => row.map((block, column) => ({ text: block.text, column, rowSpan: 1, colSpan: 1 })))
    tables.push({ type: 'table', rows, text: tableText(rows), bbox: bboxUnion(group.flat().map(block => block.bbox)), source: 'layout', needsReview: true })
    i += group.length - 1
  }
  return tables
}
