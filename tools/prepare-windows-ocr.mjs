import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir, readdir, copyFile, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

const execute = promisify(execFile)
const sources = JSON.parse(await readFile(new URL('../resources/ocr/runtime-sources.json', import.meta.url), 'utf8'))
const output = resolve('resources/ocr/win32-x64'), cache = resolve('resources/ocr/.downloads')
await mkdir(cache, { recursive: true })
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
async function acquire(source, file) {
  try { if (sha256(await readFile(file)) === source.sha256) return file } catch { /* Download the pinned asset. */ }
  await execute(process.platform === 'win32' ? 'curl.exe' : 'curl', ['--fail', '--location', '--retry', '3', '--max-time', '600', '--output', file, source.url], { maxBuffer: 1024 * 1024 })
  if (sha256(await readFile(file)) !== source.sha256) throw new Error(`Checksum mismatch: ${file}`)
  return file
}
const installer = process.argv[2] ? resolve(process.argv[2]) : await acquire(sources.windowsInstaller, join(cache, 'tesseract-5.5.3.exe'))
if (sha256(await readFile(installer)) !== sources.windowsInstaller.sha256) throw new Error('Installer does not match the pinned upstream checksum')
const extracted = await mkdtemp(join(tmpdir(), 'classifier-winocr-'))
try {
  const sevenZip = process.env.CLASSIFIER_7ZIP || (process.platform === 'win32' ? join(process.env.ProgramFiles, '7-Zip', '7z.exe') : '7zz')
  await execute(sevenZip, ['x', installer, `-o${extracted}`, '-y'], { maxBuffer: 4 * 1024 * 1024 })
  for (const dir of ['bin', 'tessdata', 'licenses']) await mkdir(join(output, dir), { recursive: true })
  const entries = await readdir(extracted)
  const native = entries.filter(name => name.toLowerCase() === 'tesseract.exe' || name.toLowerCase().endsWith('.dll'))
  if (!native.includes('tesseract.exe')) throw new Error('Upstream archive layout changed: tesseract.exe missing')
  for (const name of native) {
    const bytes = await readFile(join(extracted, name)), pe = bytes.readUInt32LE(0x3c)
    if (bytes.toString('ascii', pe, pe + 4) !== 'PE\u0000\u0000' || bytes.readUInt16LE(pe + 4) !== 0x8664) throw new Error(`Not an x64 PE image: ${name}`)
    await copyFile(join(extracted, name), join(output, 'bin', name))
  }
  for (const model of sources.models) await copyFile(await acquire(model, join(cache, `${model.name}.traineddata`)), join(output, 'tessdata', `${model.name}.traineddata`))
  for (const name of ['LICENSE', 'AUTHORS']) await copyFile(join(extracted, 'doc', name), join(output, 'licenses', `tesseract-${name}`))
  for (const name of ['tessdata-fast-4.1.0.txt', 'leptonica-1.87.0.txt']) await copyFile(resolve('resources/ocr/notices', name), join(output, 'licenses', name))
  let runtimeValidated = false
  if (process.platform === 'win32') {
    const env = { ...process.env, PATH: `${join(output, 'bin')};${join(process.env.SystemRoot, 'System32')}`, TESSDATA_PREFIX: join(output, 'tessdata') }
    const result = await execute(join(output, 'bin', 'tesseract.exe'), ['--list-langs'], { env })
    if (!/^eng\r?$/m.test(result.stdout) || !/^chi_sim\r?$/m.test(result.stdout)) throw new Error('Windows bundled languages missing')
    runtimeValidated = true
  }
  const files = []
  for (const folder of ['bin', 'tessdata', 'licenses']) for (const name of await readdir(join(output, folder))) {
    const file = join(output, folder, name), bytes = await readFile(file)
    files.push({ path: relative(output, file).split(sep).join('/'), bytes: bytes.length, sha256: sha256(bytes) })
  }
  const manifest = { platform: 'win32', arch: 'x64', version: `tesseract ${sources.windowsInstaller.version}`, languages: ['eng', 'chi_sim'], nativeFiles: native.length, runtimeValidated, source: sources.windowsInstaller, thirdPartyNoticeReview: 'pending', files }
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(JSON.stringify({ output, nativeFiles: native.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0), runtimeValidated }, null, 2))
} finally { await rm(extracted, { recursive: true, force: true }) }
