export function parseHtmlDocument(html, sourceUrl, fallbackTitle) {
  const scopedHtml = html.match(/<div[^>]+id=["']js_content["'][^>]*>([\s\S]*?)<\/div>\s*<script/i)?.[1]
    ?? html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1]
    ?? html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1]
    ?? html
  const title = cleanHtmlText(metaContent(html, 'og:title') || elementText(html, 'title') || fallbackTitle)
  const textBlocks = htmlTextBlocks(scopedHtml)
  const images = htmlImages(scopedHtml, sourceUrl)
  if (!textBlocks.length && images.length === 0) throw new Error('HTML 正文和图片提取结果为空')

  const bodyText = textBlocks.length
    ? textBlocks.join('\n\n')
    : '该链接正文主要由图片组成，当前已提取图片索引；若需要识别图片内文字，需要接入 OCR 或视觉模型。'
  const imageMarkdown = images.map((image, index) => [
    `### 图片 ${index + 1}`,
    image.alt ? `说明：${image.alt}` : '',
    `![${image.alt || `image ${index + 1}`}](${image.src})`,
  ].filter(Boolean).join('\n')).join('\n\n')
  const markdown = [
    `# ${title}`,
    '',
    `Source URL: ${sourceUrl}`,
    '',
    bodyText,
    imageMarkdown ? `\n## 图片索引\n\n${imageMarkdown}` : '',
  ].join('\n').trim()
  return {
    title,
    markdown,
    blocks: textBlocks,
    references: [...textReferences(textBlocks), ...imageReferences(images, textBlocks.length)],
  }
}

function textReferences(textBlocks) {
  return textBlocks.slice(0, 24).map((text, index) => ({
    id: `ref_${String(index + 1).padStart(3, '0')}`,
    page: null,
    type: 'text',
    sourceKind: 'html',
    title: `正文片段 ${index + 1}`,
    excerpt: text.slice(0, 800),
  }))
}

function imageReferences(images, textReferenceCount) {
  return images.slice(0, 40 - textReferenceCount).map((image, index) => ({
    id: `ref_${String(textReferenceCount + index + 1).padStart(3, '0')}`,
    page: null,
    type: 'figure',
    sourceKind: 'image',
    title: image.alt || `图片 ${index + 1}`,
    imageUrl: image.src,
    excerpt: image.alt ? `图片说明：${image.alt}\n${image.src}` : `图片链接：${image.src}`,
    markdown: `![${image.alt || `image ${index + 1}`}](${image.src})`,
  }))
}

function metaContent(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*>`, 'i'))
    ?? html.match(new RegExp(`<meta[^>]+content=["'][^"']*["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, 'i'))
  return match ? htmlAttribute(match[0], 'content') : ''
}

function elementText(html, tagName) {
  const match = html.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'))
  return match ? match[1] : ''
}

function htmlTextBlocks(html) {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|h[1-6]|li|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  return decodeHtmlEntities(withoutNoise)
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

function htmlImages(html, baseUrl) {
  const images = []
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0]
    const rawSrc = htmlAttribute(tag, 'data-src') || htmlAttribute(tag, 'data-original') || htmlAttribute(tag, 'src')
    const src = absolutizeUrl(decodeHtmlEntities(rawSrc), baseUrl)
    if (!src || images.some((image) => image.src === src)) continue
    images.push({
      src,
      alt: cleanHtmlText(htmlAttribute(tag, 'alt') || htmlAttribute(tag, 'title')),
    })
  }
  return images
}

function htmlAttribute(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = tag.match(new RegExp(`\\s${escaped}\\s*=\\s*(["'])(.*?)\\1`, 'i'))
    ?? tag.match(new RegExp(`\\s${escaped}\\s*=\\s*([^\\s>]+)`, 'i'))
  return match ? (match[2] ?? match[1] ?? '').trim() : ''
}

function absolutizeUrl(value, baseUrl) {
  if (!value || value.startsWith('data:')) return ''
  try {
    return new URL(value, baseUrl).toString()
  } catch {
    return ''
  }
}

function cleanHtmlText(text) {
  return decodeHtmlEntities(String(text ?? '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeHtmlEntities(text) {
  return String(text ?? '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
}
