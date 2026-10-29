import { test, expect } from '../helpers/desktop-application.mjs'
import { resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'

for (const phase of ['stage-synced', 'before-commit', 'after-commit']) test(`D1 packaged atomic imports survive utility SIGKILL at ${phase}`, async ({ desktop }, testInfo) => {
  const seeded = await desktop.application.evaluate(async ({ app }, profile) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    const { join } = require('node:path'), { mkdir, writeFile } = require('node:fs/promises'), { randomUUID, createHash } = require('node:crypto')
    const { initializeDatabase } = require(app.getAppPath() + '/apps/api/src/sqlite-store.mjs')
    const { createStore } = require(app.getAppPath() + '/apps/api/src/store.mjs')
    const directory = join(profile, 'atomic-import'), parameters = join(profile, 'atomic-input.json')
    await mkdir(directory); initializeDatabase(join(directory, 'library.sqlite')).close()
    await writeFile(join(directory, 'library-manifest.json'), JSON.stringify({ formatVersion: 1, storage: 'sqlite', state: 'ready' }))
    const createdAt = new Date().toISOString(), bytes = 'Packaged import evidence', topicId = randomUUID()
    const document = { id: randomUUID(), title: 'packaged atomic import', createdAt, sections: [], references: [], source: { sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: Buffer.byteLength(bytes) } }
    const job = { id: randomUUID(), topicId, status: 'running', createdAt }
    const store = await createStore(directory)
    try { await store.write('topics', { id: topicId, documents: [], title: 'atomic import', createdAt }); await store.write('imports', job) } finally { store.close() }
    await writeFile(parameters, JSON.stringify({ document, bytes, topicId, job }))
    return { directory, parameters, topicId, documentId: document.id, jobId: job.id }
  }, desktop.profile)
  const result = await desktop.application.evaluate(async ({ app, utilityProcess }, args) => {
    const child = utilityProcess.fork(args.helper, [args.directory, args.parameters, args.phase, app.getAppPath() + '/apps/api/src/store.mjs'], { stdio: 'pipe', serviceName: 'Classifier Atomic Import Validation' })
    let diagnostics = ''
    child.stdout?.on('data', () => {}); child.stderr?.on('data', value => { diagnostics += value.toString() })
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Import checkpoint timeout: ' + diagnostics)) }, 20000)
      child.once('message', () => { clearTimeout(timer); child.kill(); reject(new Error('Import unexpectedly completed')) })
      child.once('exit', code => { clearTimeout(timer); resolve(code) })
    })
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    const { createStore } = require(app.getAppPath() + '/apps/api/src/store.mjs')
    const { acquireDataLock } = require(app.getAppPath() + '/apps/api/src/data-lock.mjs')
    const checkpoint = await require('node:fs/promises').readFile(args.parameters + '.checkpoint', 'utf8')
    if (checkpoint !== args.phase) throw new Error('Unexpected import checkpoint: ' + checkpoint)
    const owner = await acquireDataLock(args.directory)
    try {
      const store = await createStore(args.directory)
      try {
        const document = await store.read('documents', args.documentId), topic = await store.read('topics', args.topicId), job = await store.read('imports', args.jobId)
        return { packaged: app.isPackaged, phase: args.phase, checkpoint, exitCode: code, documentCommitted: Boolean(document), linkedDocuments: topic.documents.length, taskState: job.status, original: document ? (await store.original(document.id)).toString() : null, runtime: process.versions }
      } finally { store.close() }
    } finally { owner.release() }
  }, { ...seeded, phase, helper: resolve('tests/helpers/atomic-import-child.mjs') })
  expect(result.documentCommitted).toBe(phase === 'after-commit')
  expect(result.linkedDocuments).toBe(phase === 'after-commit' ? 1 : 0)
  expect(result.taskState).toBe(phase === 'after-commit' ? 'completed' : 'interrupted')
  if (phase === 'after-commit') expect(result.original).toBe('Packaged import evidence')
  await writeFile(testInfo.outputPath('atomic-import-recovery.json'), JSON.stringify(result, null, 2) + '\n')
})
