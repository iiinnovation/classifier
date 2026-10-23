import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, copyFile, realpath, readFile, writeFile, readdir, stat, chmod } from 'node:fs/promises'
import { join, dirname, basename, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const execute = promisify(execFile)
const output = resolve('resources', 'ocr', `${process.platform}-${process.arch}`)
if (process.platform !== 'darwin') throw new Error('This preparation path currently requires macOS. Windows runtime preparation is tracked separately in D0-04.')
const executable = process.env.CLASSIFIER_OCR_SOURCE || (await execute('which', ['tesseract'])).stdout.trim()
const source = await realpath(executable)
const requiredArch = process.arch === 'x64' ? 'x86_64' : process.arch
const arches = (await execute('lipo', ['-archs', source])).stdout.trim().split(/\s+/)
if (!arches.includes(requiredArch)) throw new Error(`OCR architecture ${arches} does not include ${requiredArch}`)
await mkdir(join(output, 'bin'), { recursive: true })
await mkdir(join(output, 'lib'), { recursive: true })
await mkdir(join(output, 'tessdata'), { recursive: true })
await mkdir(join(output, 'licenses'), { recursive: true })
const copied = new Map(), names = new Map(), formulaRoots = new Set()
async function resolveDependency(dependency, owner) {
  const expand = value => value.replace(/^@loader_path/, dirname(owner)).replace(/^@executable_path/, dirname(source))
  if (!dependency.startsWith('@rpath/')) return realpath(expand(dependency))
  const commands = (await execute('otool', ['-l', owner])).stdout
  const paths = [...commands.matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset/g)].map(match => expand(match[1]))
  for (const folder of paths) {
    try { return await realpath(join(folder, dependency.slice('@rpath/'.length))) } catch { /* Try the next declared runtime path. */ }
  }
  throw new Error(`Unresolved source dependency: ${dependency} in ${owner}`)
}
async function collect(file, isExecutable = false) {
  const canonical = await realpath(file)
  if (copied.has(canonical)) return copied.get(canonical)
  const name = basename(canonical)
  if (names.has(name) && names.get(name) !== canonical) throw new Error(`Conflicting native library names: ${name}`)
  names.set(name, canonical)
  const target = join(output, isExecutable ? 'bin' : 'lib', isExecutable ? 'tesseract' : name)
  const entry = { target, dependencies: [], executable: isExecutable }
  copied.set(canonical, entry)
  await chmod(target, 0o755).catch(error => { if (error.code !== 'ENOENT') throw error })
  await copyFile(canonical, target)
  await chmod(target, isExecutable ? 0o755 : 0o644)
  const cellar = canonical.match(/^(.*\/Cellar\/[^/]+\/[^/]+)\//)
  if (cellar) formulaRoots.add(cellar[1])
  const lines = (await execute('otool', ['-L', canonical])).stdout.split('\n').slice(1)
  for (const line of lines) {
    const dependency = line.trim().split(' (')[0]
    if (!dependency || dependency.startsWith('/usr/lib/') || dependency.startsWith('/System/Library/')) continue
    const resolved = await resolveDependency(dependency, canonical)
    if (resolved === canonical) continue
    entry.dependencies.push({ original: dependency, entry: await collect(resolved) })
  }
  return entry
}
await collect(source, true)
for (const entry of copied.values()) {
  for (const dependency of entry.dependencies) await execute('install_name_tool', ['-change', dependency.original, `${entry.executable ? '@loader_path/../lib/' : '@loader_path/'}${basename(dependency.entry.target)}`, entry.target])
  if (!entry.executable) await execute('install_name_tool', ['-id', `@rpath/${basename(entry.target)}`, entry.target])
  await execute('codesign', ['--force', '--sign', '-', entry.target])
}
const tessdata = process.env.CLASSIFIER_OCR_TESSDATA || join(dirname(dirname(source)), 'share', 'tessdata')
const brewPrefix = source.split('/Cellar/')[0]
for (const language of ['eng', 'chi_sim']) {
  let file = join(tessdata, `${language}.traineddata`)
  try { await stat(file) } catch { file = join(brewPrefix, 'share', 'tessdata', `${language}.traineddata`) }
  const canonical = await realpath(file)
  const cellar = canonical.match(/^(.*\/Cellar\/[^/]+\/[^/]+)\//)
  if (cellar) formulaRoots.add(cellar[1])
  const target = join(output, 'tessdata', `${language}.traineddata`)
  await chmod(target, 0o644).catch(error => { if (error.code !== 'ENOENT') throw error })
  await copyFile(canonical, target)
  await chmod(target, 0o644)
}
const licenses = []
for (const root of formulaRoots) {
  const label = `${basename(dirname(root))}-${basename(root)}`
  const files = []
  async function find(folder, depth = 0) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.isFile() && /license|copying|notice|copyright/i.test(entry.name)) files.push(join(folder, entry.name))
      else if (entry.isDirectory() && depth < 3 && !['lib', 'include', 'bin', 'tessdata'].includes(entry.name)) await find(join(folder, entry.name), depth + 1)
    }
  }
  await find(root)
  if (!files.length && label.startsWith('leptonica-1.87.0')) files.push(resolve('resources/ocr/notices/leptonica-1.87.0.txt'))
  if (!files.length && label.startsWith('tesseract-lang-4.1.0')) files.push(resolve('resources/ocr/notices/tessdata-fast-4.1.0.txt'))
  for (const [index, file] of files.entries()) {
    const target = join(output, 'licenses', `${label}-${index}-${basename(file)}`)
    await chmod(target, 0o644).catch(error => { if (error.code !== 'ENOENT') throw error })
    await copyFile(file, target)
  }
  licenses.push({ package: label, noticesCopied: files.length })
}
const files = []
async function inventory(folder) {
  for (const item of await readdir(folder, { withFileTypes: true })) {
    if (item.name === 'manifest.json') continue
    const file = join(folder, item.name)
    if (item.isDirectory()) await inventory(file)
    else { const bytes = await readFile(file); files.push({ path: file.slice(output.length + 1), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }) }
  }
}
await inventory(output)
const env = { ...process.env, PATH: '/usr/bin:/bin', TESSDATA_PREFIX: join(output, 'tessdata') }
const version = (await execute(join(output, 'bin', 'tesseract'), ['--version'], { env })).stdout.trim().split('\n')[0]
const languages = (await execute(join(output, 'bin', 'tesseract'), ['--list-langs'], { env })).stdout
if (!/^eng$/m.test(languages) || !/^chi_sim$/m.test(languages)) throw new Error('Bundled languages missing')
await writeFile(join(output, 'manifest.json'), JSON.stringify({ platform: process.platform, arch: process.arch, version, languages: ['eng', 'chi_sim'], nativeFiles: copied.size, licenses, files }, null, 2) + '\n')
console.log(JSON.stringify({ output, version, nativeFiles: copied.size, bytes: files.reduce((sum, file) => sum + file.bytes, 0), missingNotices: licenses.filter(item => !item.noticesCopied).map(item => item.package) }, null, 2))
