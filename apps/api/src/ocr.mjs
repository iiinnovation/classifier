import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const execute = promisify(execFile)

export async function ocrCapabilities() {
  try {
    const { stdout } = await execute(process.env.CLASSIFIER_TESSERACT || 'tesseract', ['--list-langs'], { timeout: 5000, maxBuffer: 100_000 })
    const available = stdout.split(/\r?\n/).map(line => line.trim())
    const requested = (process.env.CLASSIFIER_OCR_LANGS || 'chi_sim+eng').split('+')
    const languages = requested.filter(language => available.includes(language))
    return { available: languages.length > 0, languages, missing: requested.filter(language => !languages.includes(language)) }
  } catch { return { available: false, languages: [], missing: (process.env.CLASSIFIER_OCR_LANGS || 'chi_sim+eng').split('+') } }
}

export function parseTsv(tsv, width, height) {
  return tsv.split(/\r?\n/).slice(1).flatMap(line => {
    const columns = line.split('\t')
    if (columns[0] !== '5' || columns.length < 12) return []
    const [x, y, w, h, confidence] = columns.slice(6, 11).map(Number)
    const text = columns.slice(11).join('\t').trim()
    if (!text || ![x, y, w, h, confidence].every(Number.isFinite) || w <= 0 || h <= 0) return []
    return [{ text, bbox: [x / width, y / height, w / width, h / height], confidence }]
  })
}

export async function recognizePage(png, width, height, { signal, languages } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'classifier-ocr-'))
  try {
    const input = join(folder, 'page.png')
    await writeFile(input, png)
    const { stdout } = await execute(process.env.CLASSIFIER_TESSERACT || 'tesseract', [input, 'stdout', '-l', languages.join('+'), '--psm', '3', 'tsv'], {
      signal, timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, OMP_THREAD_LIMIT: '2' },
    })
    return parseTsv(stdout, width, height)
  } catch (error) {
    signal?.throwIfAborted()
    throw new Error(error.killed ? '本页 OCR 超过 60 秒' : '本页 OCR 失败，请检查 Tesseract 和语言包')
  } finally { await rm(folder, { recursive: true, force: true }) }
}
