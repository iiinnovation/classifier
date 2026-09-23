import JSZip from 'jszip'
import { DOMParser } from '@xmldom/xmldom'
import { tableText } from './structures.mjs'

const children = node => Array.from(node?.childNodes || []).filter(child => child.nodeType === 1)
const local = node => node?.localName || node?.nodeName?.split(':').at(-1)
const child = (node, name) => children(node).find(item => local(item) === name)
const val = node => node?.getAttribute('w:val') || node?.getAttribute('m:val') || ''
const descendants = (node, name) => children(node).flatMap(item => local(item) === name ? [item] : descendants(item, name))
const text = node => descendants(node, 't').map(item => item.textContent).join('')

export function ommlToLatex(node) {
  let supported = true
  const escape = value => value.replace(/\\/g, '\\backslash ').replace(/([{}#%&_])/g, '\\$1').replace(/\$/g, '\\$')
  function convert(item) {
    const name = local(item)
    const part = key => convert(child(item, key))
    if (!item) return ''
    if (name?.endsWith('Pr')) return ''
    if (['oMath', 'oMathPara', 'num', 'den', 'e', 'sup', 'sub', 'deg', 'lim', 'fName'].includes(name)) return children(item).map(convert).join('')
    if (name === 'r') return escape(text(item))
    if (name === 't') return escape(item.textContent)
    if (name === 'f') return `\\frac{${part('num')}}{${part('den')}}`
    if (name === 'sSup') return `{${part('e')}}^{${part('sup')}}`
    if (name === 'sSub') return `{${part('e')}}_{${part('sub')}}`
    if (name === 'sSubSup') return `{${part('e')}}_{${part('sub')}}^{${part('sup')}}`
    if (name === 'sPre') return `{}_{${part('sub')}}^{${part('sup')}}{${part('e')}}`
    if (name === 'rad') return `\\sqrt${part('deg') ? `[${part('deg')}]` : ''}{${part('e')}}`
    if (name === 'func') return `${part('fName')} ${part('e')}`
    if (name === 'limLow' || name === 'limUpp') return `\\mathop{${part('e')}}\\limits${name === 'limLow' ? '_' : '^'}{${part('lim')}}`
    if (name === 'nary') {
      const symbol = val(child(child(item, 'naryPr'), 'chr')) || '∫'
      const operator = { '∑': '\\sum', '∏': '\\prod', '∫': '\\int', '∬': '\\iint', '∭': '\\iiint', '⋃': '\\bigcup', '⋂': '\\bigcap' }[symbol]
      if (!operator) supported = false
      return `${operator || escape(symbol)}${part('sub') ? `_{${part('sub')}}` : ''}${part('sup') ? `^{${part('sup')}}` : ''} ${part('e')}`
    }
    if (name === 'd') {
      const properties = child(item, 'dPr')
      const delimiter = (key, fallback) => {
        const value = child(properties, key)
        const glyph = value ? val(value) : fallback
        if (!glyph) return '.'
        return { '{': '\\{', '}': '\\}', '‖': '\\Vert', '⟨': '\\langle', '⟩': '\\rangle' }[glyph] || glyph
      }
      return `\\left${delimiter('begChr', '(')} ${children(item).filter(node => local(node) === 'e').map(convert).join(' \\mid ')} \\right${delimiter('endChr', ')')}`
    }
    if (name === 'm') return `\\begin{matrix}${children(item).filter(node => local(node) === 'mr').map(row => children(row).filter(node => local(node) === 'e').map(convert).join(' & ')).join(' \\\\ ')}\\end{matrix}`
    if (name === 'eqArr') return `\\begin{gathered}${children(item).filter(node => local(node) === 'e').map(convert).join(' \\\\ ')}\\end{gathered}`
    if (name === 'bar') return `\\${val(child(child(item, 'barPr'), 'pos')) === 'bot' ? 'underline' : 'overline'}{${part('e')}}`
    if (name === 'acc') {
      const accent = val(child(child(item, 'accPr'), 'chr')) || '̂'
      const command = { '̂': 'hat', '^': 'hat', '̄': 'bar', '̃': 'tilde', '~': 'tilde', '⃗': 'vec', '̇': 'dot', '̈': 'ddot' }[accent]
      if (command) return `\\${command}{${part('e')}}`
    }
    supported = false
    return children(item).map(convert).join('') || escape(item.textContent || '')
  }
  const latex = convert(node)
  return { latex, supported }
}

export async function parseDocx(bytes) {
  const zip = await JSZip.loadAsync(bytes)
  const file = zip.file('word/document.xml')
  if (!file || file._data?.uncompressedSize > 12_000_000) throw new Error('Word 正文缺失或解压后过大')
  const xml = await file.async('string')
  if (xml.length > 12_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('不支持该 Word XML 内容')
  const dom = new DOMParser({ onError: level => { if (level !== 'warning') throw new Error('Word XML 格式无效') } }).parseFromString(xml, 'application/xml')
  const body = descendants(dom.documentElement, 'body')[0]
  if (!body) throw new Error('Word 文档没有正文')
  const blocks = [], warnings = ['DOCX 使用段落和表格定位；页码随排版变化。']
  let paragraph = 0, tableIndex = 0
  function inline(node) {
    return children(node).map(item => {
      if (local(item) === 'oMath') return ommlToLatex(item).latex
      if (local(item) === 't') return item.textContent
      if (['tab', 'br', 'cr'].includes(local(item))) return ' '
      if (['del', 'drawing', 'pict'].includes(local(item))) return ''
      return inline(item)
    }).join('')
  }
  function paragraphBlocks(node) {
    paragraph++
    const formulas = descendants(node, 'oMath')
    const all = inline(node).trim()
    if (all && !formulas.length) blocks.push({ type: 'paragraph', text: all, source: 'docx', paragraph, needsReview: false })
    else if (all) {
      let prose = all
      for (const formula of formulas) prose = prose.replace(ommlToLatex(formula).latex, '[公式]')
      if (prose.replaceAll('[公式]', '').trim()) blocks.push({ type: 'paragraph', text: prose, source: 'docx', paragraph, needsReview: false })
      for (const formula of formulas) {
        const { latex, supported } = ommlToLatex(formula)
        blocks.push({ type: 'formula', text: latex || '[公式无法转换]', latex, formulaFormat: 'latex', source: 'omml', paragraph, needsReview: !supported, originalMath: formula.toString() })
        if (!supported) warnings.push(`段 ${paragraph} 含暂不支持的公式结构，已保留原始 OMML，请核对原文件。`)
      }
    }
    if (descendants(node, 'drawing').length || descendants(node, 'pict').length) warnings.push(`段 ${paragraph} 包含嵌入图片或旧式公式对象；当前保留在原文件，未识别其中内容。`)
  }
  for (const node of children(body)) {
    if (local(node) === 'p') paragraphBlocks(node)
    else if (local(node) === 'tbl') {
      tableIndex++
      const rows = [], vertical = new Map()
      let needsReview = false
      for (const row of children(node).filter(item => local(item) === 'tr')) {
        const cells = [], activeColumns = new Set()
        let column = Number(val(child(child(row, 'trPr'), 'gridBefore'))) || 0
        for (const cell of children(row).filter(item => local(item) === 'tc')) {
          const properties = child(cell, 'tcPr'), merge = child(properties, 'vMerge')
          const colSpan = Number(val(child(properties, 'gridSpan'))) || 1
          if (colSpan < 1 || colSpan > 100 || column + colSpan > 200) throw new Error('Word 表格列跨度无效')
          const value = inline(cell).trim()
          const continuing = merge && val(merge) !== 'restart'
          const previous = vertical.get(column)
          if (continuing && previous && previous.colSpan === colSpan) {
            previous.rowSpan++
            if (value) { previous.text += `\n${value}`; needsReview = true }
            for (let c = column; c < column + colSpan; c++) activeColumns.add(c)
          } else {
            const entry = { text: value, column, colSpan, rowSpan: 1 }
            cells.push(entry)
            if (continuing) needsReview = true
            for (let c = column; c < column + colSpan; c++) {
              vertical.delete(c)
              if (merge) { vertical.set(c, entry); activeColumns.add(c) }
            }
          }
          if (child(properties, 'hMerge') || descendants(cell, 'tbl').length) needsReview = true
          for (const formula of descendants(cell, 'oMath')) if (!ommlToLatex(formula).supported) needsReview = true
          column += colSpan
        }
        for (const c of vertical.keys()) if (!activeColumns.has(c)) vertical.delete(c)
        rows.push(cells)
      }
      blocks.push({ type: 'table', rows, text: tableText(rows), source: 'docx', tableIndex, needsReview })
      if (needsReview) warnings.push(`表 ${tableIndex} 含嵌套、旧式合并或未完整转换的内容，请核对原文件。`)
    } else if (local(node) !== 'sectPr') {
      for (const p of descendants(node, 'p')) paragraphBlocks(p)
      warnings.push('部分特殊 Word 容器按段落展开，请核对原文件布局。')
    }
  }
  return { sections: [{ title: '文档正文', text: blocks.map(block => block.text).join('\n\n'), blocks }], warnings }
}
