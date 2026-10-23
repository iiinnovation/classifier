import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile, readFile, readdir, lstat, stat } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { tmpdir, totalmem, cpus, release } from 'node:os'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { processTree, processSnapshot, privateMemorySnapshot } from './process-metrics.mjs'
import { scannedPdf, textPdf } from '../tests/helpers/pdf-fixture.mjs'

const executable = resolve(process.argv[2] || (process.platform === 'darwin' ? 'dist/desktop/mac/Classifier.app/Contents/MacOS/Classifier' : 'dist/desktop/win-unpacked/Classifier.exe'))
const mode = process.argv[3] || 'all'
if (!['all', 'startup', 'idle', 'pdf', 'ocr', 'ocr-bilingual', 'cancel'].includes(mode)) throw new Error('Measurement mode must be all, startup, idle, pdf, ocr, ocr-bilingual or cancel')
const outputDir = resolve('dist/desktop/measurements'); await mkdir(outputDir, { recursive: true })
const MiB = 1024 * 1024, wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]
const report = { timestamp: new Date().toISOString(), platform: process.platform, arch: process.arch, os: release(), memoryBytes: totalmem(), cpu: cpus()[0]?.model, logicalCpus: cpus().length,
  mode, instrumentation: 'Normal packaged executable with renderer CDP only; connectOverCDP(noDefaults:true), no Node inspector or Playwright launch switches. RSS includes shared-page double counting.', minimumHardwareVerified: false, results: {}, gates: {} }
const packageDir = process.platform === 'darwin' ? dirname(dirname(dirname(executable))) : dirname(executable)
async function directorySize(folder) {
  let size = 0
  for (const name of await readdir(folder)) {
    const path = join(folder, name), info = await lstat(path)
    size += info.isDirectory() ? await directorySize(path) : info.size
  }
  return size
}
report.installedBytes = await directorySize(packageDir)
report.gates.installSize = report.installedBytes <= 800 * MiB
if (process.argv[4]) {
  const artifact = resolve(process.argv[4])
  report.downloadBytes = (await stat(artifact)).size
  report.downloadSha256 = createHash('sha256').update(await readFile(artifact)).digest('hex')
  report.gates.downloadSize = report.downloadBytes <= 350 * MiB
}
const asar = join(process.platform === 'darwin' ? join(packageDir, 'Contents', 'Resources') : join(packageDir, 'resources'), 'app.asar')
report.appAsarSha256 = createHash('sha256').update(await readFile(asar)).digest('hex')
const checkpoint = async () => writeFile(join(outputDir, `${process.platform}-${process.arch}-${mode}.json`), JSON.stringify(report, null, 2) + '\n')

async function launch() {
  const profile = await mkdtemp(join(tmpdir(), 'classifier-measure-')), observed = new Map()
  let browser, page, endpointResolve, endpointReject
  const endpoint = new Promise((resolve, reject) => { endpointResolve = resolve; endpointReject = reject })
  const started = performance.now()
  const child = spawn(executable, ['--remote-debugging-port=0', `--user-data-dir=${profile}`], { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: process.platform === 'win32' ? join(process.env.SystemRoot, 'System32') : '/usr/bin:/bin' } })
  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => { endpointReject(new Error(`Application exited: ${code}/${signal}`)); resolve({ code, signal }) })
    child.once('error', error => { endpointReject(error); resolve({ error: error.message }) })
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', data => { const match = data.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) endpointResolve(match[1]) })
  const deadline = setTimeout(() => endpointReject(new Error('No desktop debugging endpoint within 30 seconds')), 30000)
  async function sample() {
    const tree = await processTree(child.pid)
    for (const entry of tree) observed.set(entry.pid, entry.name)
    if (!tree.some(entry => entry.pid === child.pid)) throw new Error('Application exited during measurement')
    return { at: Date.now(), rss: tree.reduce((sum, entry) => sum + entry.rss, 0), processes: tree.length, ocrPids: tree.filter(entry => entry.ocrRecognition).map(entry => entry.pid) }
  }
  async function close() {
    if (page && !page.isClosed()) await page.evaluate(() => window.close()).catch(() => {})
    let timer
    const result = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve(null), 15000) })])
    clearTimeout(timer)
    await browser?.close().catch(() => {})
    if (!result) {
      if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL') } catch {} } else child.kill()
      await rm(profile, { recursive: true, force: true })
      throw new Error('Application did not exit normally within 15 seconds')
    }
    await wait(500)
    const remaining = (await processSnapshot()).filter(entry => observed.get(entry.pid) === entry.name)
    await rm(profile, { recursive: true, force: true })
    if (remaining.length) {
      if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
      throw new Error(`Application left processes running: ${remaining.map(entry => entry.pid).join(', ')}`)
    }
  }
  try {
    browser = await chromium.connectOverCDP(await endpoint, { noDefaults: true, timeout: 30000 })
    clearTimeout(deadline)
    const context = browser.contexts()[0]
    page = context.pages()[0] || await context.waitForEvent('page')
    await page.waitForURL('app://classifier/')
    await page.locator('#new-topic').waitFor({ state: 'visible' })
    await page.waitForFunction(() => document.getElementById('topic-cards').textContent.includes('创建第一个研究主题'))
    const health = await page.evaluate(async () => (await fetch('/health')).json())
    if (health.status !== 'ok') throw new Error('Backend not ready')
    return { page, sample, close, pid: child.pid, startupMs: performance.now() - started }
  } catch (error) { clearTimeout(deadline); child.kill(); await exited; await browser?.close().catch(() => {}); await rm(profile, { recursive: true, force: true }); throw error }
}
async function settle(ms, label) {
  for (let elapsed = 0; elapsed < ms; elapsed += 1000) { await wait(1000); if ((elapsed + 1000) % 15000 === 0) console.log(`${label}: ${elapsed + 1000}/${ms} ms`) }
}
async function samples(app, milliseconds) {
  const collected = [], until = performance.now() + milliseconds
  while (performance.now() < until) { collected.push(await app.sample()); await wait(500) }
  return collected
}
async function importFile(page, file) {
  // A normal packaged window may be occluded while sampling. Trigger the same
  // UI handlers without Playwright's animation-frame stability polling.
  await page.locator('#import-open').dispatchEvent('click')
  await page.locator('#file').setInputFiles(file)
  await page.waitForFunction(() => !document.getElementById('file').disabled, null, { polling: 100, timeout: 180000 })
  const status = await page.locator('#upload-status').textContent()
  if (!status.includes('已导入 1')) throw new Error(`Import failed: ${status}`)
  await page.locator('#title').waitFor({ state: 'visible' })
}
async function workload(name, bytes) {
  const path = join(outputDir, `${name}.pdf`); await writeFile(path, bytes)
  const app = await launch(), collected = [], monitor = { done: false }
  let samplingError
  const reading = (async () => { while (!monitor.done) { collected.push(await app.sample()); await wait(250) } })().catch(error => { samplingError = error; monitor.done = true })
  const began = performance.now()
  try {
    await importFile(app.page, path)
    await app.page.locator('#page-image').waitFor({ state: 'visible', timeout: 30000 })
    monitor.done = true; await reading
    if (samplingError) throw samplingError
    report.results[name] = { durationMs: performance.now() - began, peakRss: Math.max(...collected.map(item => item.rss)), fixtureBytes: bytes.length, fixtureSha256: createHash('sha256').update(bytes).digest('hex'), samples: collected }
    if (name === 'ocr-bilingual') {
      const document = await app.page.evaluate(async () => {
        const { documents } = await (await fetch('/api/documents')).json()
        return (await fetch(`/api/documents/${documents[0].id}`)).json()
      })
      const pages = document.sections.map(section => ({ page: section.page, english: /Classifier research/i.test(section.text), chinese: /研\s*究\s*材\s*料/.test(section.text) }))
      const english = pages.every(page => page.english), chinese = pages.every(page => page.chinese)
      report.results[name].contentCheck = { pages: document.sections.length, ocrPages: document.sections.filter(section => section.extraction === 'ocr').length, english, chinese, pageChecks: pages }
      if (!english || !chinese || document.sections.length !== 10 || document.sections.some(section => section.extraction !== 'ocr')) throw new Error('Bilingual OCR fixture content was not preserved')
    }
    report.gates[name] = report.results[name].peakRss <= (name === 'pdf' ? 1.2 : 1.5) * 1024 * MiB
    console.log(`${name}: peak ${(report.results[name].peakRss / MiB).toFixed(1)} MiB`)
  } finally { monitor.done = true; try { await reading } finally { await app.close() } }
  await checkpoint()
}
try {
  if (mode === 'all' || mode === 'startup') {
    const durations = []
    for (let i = 0; i < 20; i++) { const app = await launch(); await app.sample(); durations.push(app.startupMs); await app.close(); console.log(`startup ${i + 1}/20: ${app.startupMs.toFixed(0)} ms`) }
    report.results.startup = { count: durations.length, p95Ms: p95(durations), durationsMs: durations, cache: 'Full process restart; OS file cache is not flushed.' }
    report.gates.startup = p95(durations) <= 8000; await checkpoint()
  }
  if (mode === 'all' || mode === 'idle') {
    const app = await launch()
    try { await settle(60000, 'idle warmup'); const values = await samples(app, 30000); report.results.idle = { p95Rss: p95(values.map(item => item.rss)), samples: values, privateMemory: await privateMemorySnapshot(app.pid) }; report.gates.idle = report.results.idle.p95Rss <= 450 * MiB; console.log(`idle P95: ${(report.results.idle.p95Rss / MiB).toFixed(1)} MiB`) }
    finally { await app.close() }
    await checkpoint()
  }
  if (mode === 'all' || mode === 'pdf') await workload('pdf', textPdf(50))
  if (mode === 'all' || mode === 'ocr') await workload('ocr', scannedPdf(10, 300))
  if (mode === 'all' || mode === 'ocr-bilingual') await workload('ocr-bilingual', scannedPdf(10, 300, { bilingual: true }))
  if (mode === 'all' || mode === 'cancel') {
    const bytes = scannedPdf(10, 300), file = join(outputDir, 'cancel.pdf'); await writeFile(file, bytes)
    const app = await launch()
    let phase = 'baseline'
    try {
      await settle(60000, 'cancel baseline'); const before = await samples(app, 30000)
      const baselineTree = await processTree(app.pid), cycles = [], cancelledJobs = []
      for (let i = 0; i < 10; i++) {
        phase = `cycle ${i + 1}: upload`
        await app.page.locator('#import-open').dispatchEvent('click'); await app.page.locator('#file').setInputFiles(file)
        phase = `cycle ${i + 1}: wait for OCR subprocess`
        const deadline = performance.now() + 30000
        let activeOcr
        do { activeOcr = await app.sample(); if (activeOcr.ocrPids.length) break; await wait(100) } while (performance.now() < deadline)
        if (!activeOcr.ocrPids.length) throw new Error('No active Tesseract process within 30 seconds')
        const jobId = await app.page.evaluate(() => localStorage.getItem('classifier-import'))
        if (!jobId) throw new Error('No active import job to cancel')
        await app.page.locator('#cancel-import').dispatchEvent('click')
        phase = `cycle ${i + 1}: wait for cancellation`
        await app.page.waitForFunction(() => !document.getElementById('file').disabled, null, { polling: 100, timeout: 30000 })
        const job = await app.page.evaluate(async id => (await fetch(`/api/imports/${id}`)).json(), jobId)
        if (job.status !== 'cancelled' || job.documentId) throw new Error(`Import did not cancel: ${job.status}`)
        cancelledJobs.push({ id: jobId, status: job.status, ocrPids: activeOcr.ocrPids })
        await app.sample(); cycles.push(await processTree(app.pid))
        await app.page.locator('#close-import').dispatchEvent('click'); console.log(`cancel cycle ${i + 1}/10 complete`)
      }
      phase = 'recovery'
      await settle(60000, 'cancel recovery'); const after = await samples(app, 30000)
      const growth = p95(after.map(item => item.rss)) - p95(before.map(item => item.rss))
      const afterTree = await processTree(app.pid)
      report.results.cancel = { cycles: 10, cancelledJobs, growthRss: growth, fixtureBytes: bytes.length, fixtureSha256: createHash('sha256').update(bytes).digest('hex'), before, after, baselineTree, cycleTrees: cycles, afterTree }
      report.gates.cancel = growth <= 100 * MiB
      report.gates.cancelProcesses = !afterTree.some(item => /tesseract/i.test(item.name))
      console.log(`cancel growth: ${(growth / MiB).toFixed(1)} MiB; OCR processes remaining: ${afterTree.filter(item => /tesseract/i.test(item.name)).length}`)
    } catch (error) {
      report.cancelFailure = { phase, tree: await processTree(app.pid), ui: await app.page.evaluate(async () => {
        const id = localStorage.getItem('classifier-import')
        return { uploadStatus: document.getElementById('upload-status').textContent, disabled: document.getElementById('file').disabled, job: id ? await (await fetch(`/api/imports/${id}`)).json() : null }
      }).catch(() => null) }
      throw error
    } finally { await app.close() }
    await checkpoint()
  }
  report.completed = true
} catch (error) { report.error = error.message; report.errorStack = error.stack; report.completed = false; process.exitCode = 1 }
await checkpoint()
if (Object.values(report.gates).some(passed => !passed)) process.exitCode = 1
console.log(JSON.stringify({ file: join(outputDir, `${process.platform}-${process.arch}-${mode}.json`), completed: report.completed, gates: report.gates, error: report.error }, null, 2))
