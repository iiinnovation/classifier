import { deflateSync } from 'node:zlib'
import { createCanvas, GlobalFonts } from '@napi-rs/canvas'

function pdf(objects) {
  const chunks = [Buffer.from('%PDF-1.4\n')], offsets = []
  let length = chunks[0].length
  for (const [index, object] of objects.entries()) {
    offsets.push(length)
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.from(object), Buffer.from('\nendobj\n')])
    chunks.push(chunk); length += chunk.length
  }
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`))
  return Buffer.concat(chunks)
}
export function scannedPdf(pages = 1, dpi = 150, { bilingual = false } = {}) {
  const width = Math.round(8.27 * dpi), height = Math.round(11.69 * dpi)
  const canvas = createCanvas(width, height), context = canvas.getContext('2d')
  context.fillStyle = 'white'; context.fillRect(0, 0, width, height)
  context.fillStyle = 'black'; context.font = `${Math.round(dpi * 0.27)}px Arial`
  const lines = ['Classifier research results', 'Treatment group: 42 samples', 'Control group: 21 samples', 'Mean accuracy = 0.95', 'Methods and results require source verification.']
  if (bilingual) lines.push('研究材料：治疗组与对照组。', '样本数量和研究结果需要核对原文。')
  const cjkFont = bilingual ? ['Heiti TC', 'Microsoft YaHei', 'SimSun', 'Noto Sans CJK SC', 'Arial Unicode MS'].find(name => GlobalFonts.has(name)) : null
  if (bilingual && !cjkFont) throw new Error('Bilingual PDF fixture requires an installed CJK font')
  lines.forEach((line, index) => {
    context.font = `${Math.round(dpi * 0.27)}px "${index >= 5 && cjkFont ? cjkFont : 'Arial'}"`
    context.fillText(line, dpi * 0.5, dpi * (0.8 + index * 0.5))
  })
  const rgba = context.getImageData(0, 0, width, height).data, rgb = Buffer.alloc(width * height * 3)
  for (let i = 0, j = 0; i < rgba.length; i += 4) { rgb[j++] = rgba[i]; rgb[j++] = rgba[i + 1]; rgb[j++] = rgba[i + 2] }
  const bytes = deflateSync(rgb), kids = Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(' ')
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`, Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${bytes.length} >>\nstream\n`), bytes, Buffer.from('\nendstream')])]
  for (let i = 0; i < pages; i++) {
    const stream = 'q 595 0 0 842 0 0 cm /Image Do Q'
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Image 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  }
  return pdf(objects)
}
export function textPdf(pages = 50) {
  const kids = Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(' ')
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  for (let i = 0; i < pages; i++) {
    const stream = `BT /F1 10 Tf 40 790 Td 14 TL ${Array.from({ length: 48 }, (_, row) => `(Research page ${i + 1} line ${row + 1}: methods, materials, results and limitations.) Tj T*`).join('\n')} ET`
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  }
  return pdf(objects)
}
