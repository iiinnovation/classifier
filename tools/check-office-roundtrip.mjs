import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import { DOMParser } from '@xmldom/xmldom'
import { parseDocx } from '../apps/api/src/docx.mjs'

const [beforePath, afterPath, resultPath] = process.argv.slice(2)
if (!beforePath || !afterPath) throw new Error('Usage: node tools/check-office-roundtrip.mjs original.docx edited.docx [result.json]')
const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const expectedOriginal = '办公软件编辑验收：此句尚未修改。'
const expectedEdit = '办公软件编辑验收：此句已在 WPS 中修改并保存。'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
async function inspect(path) {
  const bytes = await readFile(resolve(path)), zip = await JSZip.loadAsync(bytes)
  const file = zip.file('word/document.xml')
  if (!file) throw new Error('Office document body missing')
  const dom = new DOMParser({ onError: () => { throw new Error('Office document XML is invalid') } }).parseFromString(await file.async('string'), 'application/xml')
  const names = name => Array.from(dom.getElementsByTagNameNS(word, name))
  const metadata = zip.file('docProps/custom.xml')
  let citationSources = null
  if (metadata) {
    const properties = new DOMParser({ onError: () => { throw new Error('Office custom properties XML is invalid') } }).parseFromString(await metadata.async('string'), 'application/xml')
    const property = Array.from(properties.getElementsByTagNameNS('http://schemas.openxmlformats.org/officeDocument/2006/custom-properties', 'property')).find(item => item.getAttribute('name') === 'ClassifierCitationSources')
    if (property) citationSources = JSON.parse(property.textContent)
  }
  return { bytes, text: (await parseDocx(bytes)).sections[0].text,
    citationSources,
    bookmarkNames: names('bookmarkStart').map(item => item.getAttributeNS(word, 'name')),
    anchors: names('hyperlink').map(item => item.getAttributeNS(word, 'anchor')).filter(Boolean),
  }
}
const before = await inspect(beforePath), after = await inspect(afterPath)
const checks = {
  originalSampleHasEditTarget: before.text.includes(expectedOriginal),
  editedFileChanged: sha(before.bytes) !== sha(after.bytes),
  editedSentencePersisted: after.text.includes(expectedEdit) && !after.text.includes(expectedOriginal),
  otherSavedTextPreserved: before.text.replace(expectedOriginal, expectedEdit) === after.text,
  citationBookmarksPreserved: before.bookmarkNames.filter(name => /^reference_\d+$/.test(name)).every(name => after.bookmarkNames.includes(name)),
  citationLinksPreserved: before.anchors.every(name => after.anchors.includes(name)),
  citationLinksHaveTargets: after.anchors.every(name => after.bookmarkNames.includes(name)),
  citationSourceMetadataPreserved: before.citationSources === null || JSON.stringify(before.citationSources) === JSON.stringify(after.citationSources),
}
const result = { capturedAt: new Date().toISOString(), original: resolve(beforePath), edited: resolve(afterPath), originalSha256: sha(before.bytes), editedSha256: sha(after.bytes),
  checks, passed: Object.values(checks).every(Boolean),
  provenance: 'Content and citation verification only. Office editing/save/reopen and visual inspection must be recorded separately; this tool does not establish which application wrote the edited file.' }
if (resultPath) await writeFile(resolve(resultPath), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify(result, null, 2))
if (!result.passed) process.exitCode = 1
