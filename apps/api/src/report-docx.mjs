import JSZip from 'jszip'
import { sourceStateText } from './evidence.mjs'

const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const relationships = 'http://schemas.openxmlformats.org/package/2006/relationships'
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
// XML 1.0 excludes control characters and isolated surrogates. Keep permitted
// Unicode literally; imported text never becomes links, markup, or fields.
const xml = value => String(value ?? '').replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '\uFFFD').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
function run(value, style = '') {
  const parts = String(value ?? '').replace(/\r\n?/g, '\n').split(/(\n|\t)/)
  return `<w:r>${style ? `<w:rPr><w:rStyle w:val="${style}"/></w:rPr>` : ''}${parts.map(part => part === '\n' ? '<w:br/>' : part === '\t' ? '<w:tab/>' : `<w:t xml:space="preserve">${xml(part)}</w:t>`).join('')}</w:r>`
}
const paragraph = (text, style = 'Normal', keepNext = false) => `<w:p><w:pPr><w:pStyle w:val="${style}"/>${keepNext ? '<w:keepNext/>' : ''}</w:pPr>${run(text)}</w:p>`
const style = (id, name, size, { bold = false, color = '222222', heading = null, indent = false } = {}) => `<w:style w:type="paragraph" w:styleId="${id}"${id === 'Normal' ? ' w:default="1"' : ''}><w:name w:val="${name}"/>${id === 'Normal' ? '' : '<w:basedOn w:val="Normal"/>'}<w:next w:val="Normal"/><w:pPr><w:spacing w:before="${heading !== null ? 240 : 0}" w:after="120" w:line="360" w:lineRule="auto"/><w:widowControl/>${heading !== null ? `<w:keepNext/><w:keepLines/><w:outlineLvl w:val="${heading}"/>` : ''}${indent ? '<w:ind w:left="360" w:right="360"/>' : ''}</w:pPr><w:rPr>${bold ? '<w:b/>' : ''}<w:color w:val="${color}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`

function savedTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const parts = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' }).formatToParts(date)
  const part = type => parts.find(item => item.type === type)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}（${part('timeZoneName')}）`
}
function location(reference) {
  const title = String(reference.title || '')
  if (!reference.page) return title
  const hasPage = new RegExp(`第\\s*${reference.page}\\s*页|\\bpage\\s*${reference.page}\\b`, 'i').test(title)
  return hasPage ? title : [title, `第 ${reference.page} 页`].filter(Boolean).join(' · ')
}

export async function reportDocx(document) {
  const paragraphs = [paragraph(document.title, 'Title'), paragraph(`研究问题：${document.question}`), paragraph(`成果版本：${document.revision} · 保存时间：${savedTime(document.updatedAt)}`, 'Metadata')]
  if (document.materialWarning) paragraphs.push(paragraph(document.materialWarning, 'Metadata'))
  let section
  for (const block of document.blocks) {
    if (section !== block.section) { paragraphs.push(paragraph(block.section, 'Heading1')); section = block.section }
    paragraphs.push(paragraph(block.attribution, 'Metadata'), paragraph(block.text))
    if (block.sourceWarning) paragraphs.push(paragraph(block.sourceWarning, 'Metadata'))
    if (block.citationNumbers.length) paragraphs.push(`<w:p><w:pPr><w:pStyle w:val="Metadata"/></w:pPr>${run('出处：')}${block.citationNumbers.map((number, index) => `${index ? run('、') : ''}<w:hyperlink w:anchor="reference_${number}" w:history="1">${run(`[${number}]`, 'Hyperlink')}</w:hyperlink>`).join('')}</w:p>`)
  }
  paragraphs.push(paragraph('引用与原文定位', 'Heading1'))
  if (!document.citations.length) paragraphs.push(paragraph('尚未关联原文引用。'))
  for (const item of document.citations) {
    const bibliography = item.bibliography || {}, ref = item.reference
    paragraphs.push(`<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:bookmarkStart w:id="${item.number}" w:name="reference_${item.number}"/>${run(`[${item.number}] ${item.documentTitle}`)}<w:bookmarkEnd w:id="${item.number}"/></w:p>`,
      paragraph([bibliography.authors, bibliography.year, bibliography.venue].filter(Boolean).join(' · ') || '书目信息尚未补全。', 'Normal', true),
      paragraph(`原文：${item.fileName} · ${location(ref)}`, 'Metadata', true),
      paragraph(`原文状态：${item.versionStatus}`, 'Metadata', true))
    if (bibliography.doi) paragraphs.push(paragraph(`DOI：${bibliography.doi}`, 'Metadata', true))
    if (bibliography.url) paragraphs.push(paragraph(`来源链接：${bibliography.url}`, 'Metadata', true))
    if (ref.needsReview) paragraphs.push(paragraph('识别内容待核对，请结合原文件检查。', 'Metadata', true))
    paragraphs.push(paragraph(ref.text, 'Quote'))
  }
  paragraphs.push(paragraph('所用研究材料', 'Heading1'))
  if (!document.materials.length) paragraphs.push(paragraph('未选择研究材料。'))
  for (const source of document.materials) {
    paragraphs.push(paragraph(`${source.title} · ${source.versionLabel} · ${source.statusLabel}`))
    for (const doc of source.documents) paragraphs.push(paragraph(`文献：${doc.title} · ${doc.fileName}${doc.bibliography.authors ? ` · ${doc.bibliography.authors}` : ''}${doc.bibliography.year ? ` · ${doc.bibliography.year}` : ''}${sourceStateText(doc.sourceState) ? ` · ${sourceStateText(doc.sourceState)}` : ''}`, 'Metadata'))
  }
  const zip = new JSZip()
  zip.file('[Content_Types].xml', declaration + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>')
  zip.file('_rels/.rels', declaration + `<Relationships xmlns="${relationships}"><Relationship Id="document" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="properties" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="citationSources" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/></Relationships>`)
  zip.file('word/document.xml', declaration + `<w:document xmlns:w="${word}"><w:body>${paragraphs.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`)
  zip.file('word/_rels/document.xml.rels', declaration + `<Relationships xmlns="${relationships}"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="settings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>`)
  zip.file('word/styles.xml', declaration + `<w:styles xmlns:w="${word}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="宋体" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault></w:docDefaults>${style('Normal', 'Normal', 22)}${style('Title', 'Title', 36, { bold: true })}${style('Heading1', 'heading 1', 28, { bold: true, heading: 0 })}${style('Heading2', 'heading 2', 24, { bold: true, heading: 1 })}${style('Metadata', 'Metadata', 18, { color: '555555' })}${style('Quote', 'Quote', 22, { indent: true })}<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style></w:styles>`)
  zip.file('word/settings.xml', declaration + `<w:settings xmlns:w="${word}"><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`)
  zip.file('docProps/core.xml', declaration + `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xml(document.title)}</dc:title><dc:creator>Classifier</dc:creator><dc:description>${xml(`研究问题：${document.question}；成果版本：${document.revision}；保存时间：${document.updatedAt}`)}</dc:description></cp:coreProperties>`)
  const citationSources = document.citations.map(item => ({ number: item.number, documentId: item.documentId, documentVersion: item.documentVersion, referenceId: item.reference.id }))
  zip.file('docProps/custom.xml', declaration + `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="ClassifierCitationSources"><vt:lpwstr>${xml(JSON.stringify(citationSources))}</vt:lpwstr></property></Properties>`)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
}
