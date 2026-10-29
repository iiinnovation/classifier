import { test, expect } from '../helpers/desktop-application.mjs'
import { resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { _electron as electron } from '@playwright/test'

test('D2 production utility deletion survives commit/unlink crashes and real SQLite FULL with recoverable file failures', async ({ desktop }, testInfo) => {
  const result = await desktop.application.evaluate(async ({ app, utilityProcess }, args) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    const fs = require('node:fs/promises'), { join } = require('node:path'), { randomUUID, createHash } = require('node:crypto')
    const { createStore } = require(app.getAppPath() + '/apps/api/src/store.mjs')
    const { initializeDatabase } = require(app.getAppPath() + '/apps/api/src/sqlite-store.mjs')
    const { deletionPreview } = require(app.getAppPath() + '/apps/api/src/deletion-preview.mjs')
    const results = []
    for (const phase of ['before-commit', 'after-commit', 'before-unlink', 'after-unlink', 'sqlite-full', 'unlink-denied', 'directory-sync-error', 'commit-ack-error']) {
      const directory = await fs.mkdtemp(join(args.profile, 'deletion-fault-')), parameters = join(args.profile, randomUUID() + '.json')
      initializeDatabase(join(directory, 'library.sqlite')).close()
      await fs.writeFile(join(directory, 'library-manifest.json'), JSON.stringify({ formatVersion: 1, storage: 'sqlite', state: 'ready' }))
      const createdAt = new Date().toISOString(), bytes = Buffer.from('Production deletion original')
      const document = { id: randomUUID(), title: 'Shared original', createdAt, sections: [], references: [], source: { sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length } }
      const topics = [1, 2, 3].map(i => ({ id: randomUUID(), title: 'Topic ' + i, createdAt, documents: [{ documentId: document.id }] }))
      const note = { id: randomUUID(), topicId: topics[0].id, documentId: document.id, createdAt, content: 'Preserved research', evidence: [], history: [{ content: 'Preserved history', evidence: [] }] }
      let store = await createStore(directory)
      try { await store.saveOriginal(document.id, bytes); store.write('documents', document); store.write('notes', note); for (const topic of topics) store.write('topics', topic) } finally { store.close() }
      const operationId = randomUUID(); await fs.writeFile(parameters, JSON.stringify({ documentId: document.id, operationId }))
      const child = utilityProcess.fork(args.helper, [directory, parameters, phase, app.getAppPath()], { stdio: 'pipe', serviceName: 'Classifier D2 Deletion Validation' })
      let diagnostics = '', report
      child.stdout?.on('data', () => {}); child.stderr?.on('data', bytes => { diagnostics += bytes.toString() })
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('Deletion fault timed out: ' + phase + ': ' + diagnostics)) }, 30000)
        child.once('message', message => { report = message.report; child.postMessage({ type: 'finish' }) })
        child.once('exit', code => { clearTimeout(timer); resolve(code) })
      })
      const crash = ['before-commit', 'after-commit', 'before-unlink', 'after-unlink'].includes(phase)
      if (crash) { if (await fs.readFile(parameters + '.checkpoint', 'utf8') !== phase || code === 0) throw new Error('Expected real SIGKILL: ' + phase) }
      else if (code !== 0 || !report?.reached) throw new Error('Deletion fault failed: ' + phase + ': ' + diagnostics)
      if (phase === 'sqlite-full' && report.error?.errcode !== 13) throw new Error('Expected actual SQLite FULL')
      store = await createStore(directory)
      try {
        const committed = !['before-commit', 'sqlite-full'].includes(phase)
        if (Boolean(await store.read('documents', document.id)) === committed) throw new Error('Wrong deletion commit boundary: ' + phase)
        if (JSON.stringify(await store.read('notes', note.id)) !== JSON.stringify(note)) throw new Error('Lost saved research: ' + phase)
        for (const topic of topics) if ((await store.read('topics', topic.id)).documents.length !== (committed ? 0 : 1)) throw new Error('Partial topic links: ' + phase)
        if (!committed) await store.commitDeletion(await deletionPreview(store, { bucket: 'documents', id: document.id }), operationId)
        if (!(await store.deletion('documents', document.id)) || (await store.health()).issueCount) throw new Error('Deletion recovery incomplete: ' + phase)
        try { await fs.lstat(join(directory, 'originals', document.id)); throw new Error('Deleted original remains: ' + phase) } catch (error) { if (error.code !== 'ENOENT') throw error }
        results.push({ phase, passed: true, forcedExit: crash, savedResearchAndHistoryPreserved: true, allTopicLinksRemoved: true, fileCleanupCompleted: true, ...(report?.error ? { error: report.error } : {}) })
      } finally { store.close() }
    }
    return { packaged: app.isPackaged, source: app.getAppPath(), versions: process.versions, results }
  }, { profile: desktop.profile, helper: resolve('tests/helpers/deletion-child.mjs') })
  expect(result.results).toHaveLength(8); expect(result.results.every(value => value.passed)).toBe(true)
  if (process.env.CLASSIFIER_PACKAGED_EXECUTABLE) expect(result.packaged).toBe(true)
  await writeFile(testInfo.outputPath('deletion-recovery.json'), JSON.stringify(result, null, 2) + '\n')
})

test('retained D1 binary refuses a database upgraded by actual D2 deletion before changing records or queued tasks', async ({ desktop }, testInfo) => {
  const seed = await desktop.application.evaluate(async ({ app }, profile) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    const fs = require('node:fs/promises'), { join } = require('node:path'), { randomUUID } = require('node:crypto')
    const { initializeDatabase } = require(app.getAppPath() + '/apps/api/src/sqlite-store.mjs')
    const { createStore } = require(app.getAppPath() + '/apps/api/src/store.mjs')
    const { deletionPreview } = require(app.getAppPath() + '/apps/api/src/deletion-preview.mjs')
    const directory = await fs.mkdtemp(join(profile, 'deletion-version-')), olderProfile = await fs.mkdtemp(join(profile, 'older-version-'))
    initializeDatabase(join(directory, 'library.sqlite')).close(); await fs.writeFile(join(directory, 'library-manifest.json'), JSON.stringify({ formatVersion: 1, storage: 'sqlite', state: 'ready' }))
    const store = await createStore(directory), id = randomUUID(), createdAt = new Date().toISOString()
    try {
      await store.saveOriginal(id, Buffer.from('Older version refusal evidence'))
      store.write('documents', { id, title: 'Deleted source', createdAt, sections: [], references: [] })
      await store.commitDeletion(await deletionPreview(store, { bucket: 'documents', id }), randomUUID())
      store.write('runs', { id: randomUUID(), createdAt, status: 'queued', events: [] })
    } finally { store.close() }
    return { directory, olderProfile, newPackaged: app.isPackaged, newSource: app.getAppPath() }
  }, desktop.profile)
  const olderExecutable = resolve('dist/desktop-d1-disk-failures-2026-10-26/mac/Classifier.app/Contents/MacOS/Classifier')
  const older = await electron.launch({ executablePath: olderExecutable, args: [`--user-data-dir=${seed.olderProfile}`], env: desktop.env, timeout: 45000 })
  try {
    await expect((await older.firstWindow()).locator('#new-topic')).toBeVisible()
    const result = await older.evaluate(async ({ app, utilityProcess }, args) => {
      const child = utilityProcess.fork(args.helper, [args.directory, app.getAppPath()], { stdio: 'pipe', serviceName: 'Classifier Preview Compatibility Validation' })
      let diagnostics = '', result
      child.stdout?.on('data', () => {}); child.stderr?.on('data', bytes => { diagnostics += bytes.toString() })
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('Compatibility timeout: ' + diagnostics)) }, 20000)
        child.once('message', message => { result = message; child.postMessage({ type: 'finish' }) })
        child.once('exit', code => { clearTimeout(timer); code === 0 && result ? resolve() : reject(new Error('Compatibility validation failed: ' + diagnostics)) })
      })
      return { ...result, oldPackaged: app.isPackaged }
    }, { directory: seed.directory, helper: resolve('tests/helpers/deletion-compatibility-child.mjs') })
    expect(result.oldPackaged).toBe(true); expect(result.databaseVersion).toBe(2)
    expect(result.oldVersionRefusedBeforeRecordAndTaskWrites).toBe(true)
    await writeFile(testInfo.outputPath('deletion-preview-compatibility.json'), JSON.stringify({ ...seed, ...result, actualPreviewBinaries: true, actualReleaseVersionPairsVerified: false }, null, 2) + '\n')
  } finally { await older.close() }
})
