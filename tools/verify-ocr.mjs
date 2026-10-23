import { readFile } from 'node:fs/promises'
import { join, resolve, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execute = promisify(execFile)

export async function verifyOcrBundle(root) {
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
  const inventory = new Set(manifest.files.map(item => resolve(root, item.path)))
  for (const item of manifest.files) {
    const path = resolve(root, item.path)
    if (!path.startsWith(resolve(root) + sep)) throw new Error(`Invalid bundle path: ${item.path}`)
    const bytes = await readFile(path)
    if (bytes.length !== item.bytes || createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error(`OCR file checksum mismatch: ${item.path}`)
    if (process.platform === 'darwin' && manifest.platform === 'darwin' && /^(bin|lib)\//.test(item.path)) {
      const lines = (await execute('otool', ['-L', path])).stdout.split('\n').slice(1)
      for (const line of lines) {
        const dependency = line.trim().split(' (')[0]
        if (!dependency || dependency.startsWith('/usr/lib/') || dependency.startsWith('/System/Library/')) continue
        if (dependency.startsWith('@rpath/') && item.path === `lib/${dependency.slice('@rpath/'.length)}`) continue
        if (!dependency.startsWith('@loader_path/')) throw new Error(`External OCR dependency: ${dependency}`)
        if (!inventory.has(resolve(dirname(path), dependency.slice('@loader_path/'.length)))) throw new Error(`Missing OCR dependency: ${dependency}`)
      }
    }
  }
  return { platform: manifest.platform, arch: manifest.arch, files: manifest.files.length, bytes: manifest.files.reduce((sum, item) => sum + item.bytes, 0) }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await verifyOcrBundle(resolve(process.argv[2] || `resources/ocr/${process.platform}-${process.arch}`)), null, 2))
}
