import { test, expect } from '../helpers/desktop-application.mjs'
import { resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'

for (const phase of ['records', 'file-published', 'published']) {
  test('D1 packaged migration resumes after utility SIGKILL at ' + phase, async ({ desktop }, testInfo) => {
    const prepared = await desktop.application.evaluate(async ({ app }, profile) => {
      const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
      const { join } = require('node:path'), { randomUUID } = require('node:crypto')
      const { createStore } = require(app.getAppPath() + '/apps/api/src/store.mjs')
      const { prepareMigration } = require(app.getAppPath() + '/apps/api/src/storage-maintenance.mjs')
      const source = join(profile, 'legacy'), target = join(profile, 'migrated'), backup = join(profile, 'before')
      const store = await createStore(source), id = randomUUID(), createdAt = new Date().toISOString()
      const document = { id, title: 'Packaged resumable migration', createdAt, references: [{ id: 'ref_00001', text: 'Evidence' }] }
      await store.saveOriginal(id, Buffer.from('Evidence')); await store.write('documents', document)
      for (let i = 0; i < 105; i++) await store.write('notes', { id: randomUUID(), documentId: id, createdAt, revision: 2, content: 'Note ' + i, history: [{ revision: 1, content: 'Earlier ' + i }] })
      return { ...await prepareMigration(source, target, backup), id }
    }, desktop.profile)
    async function run(stopAt) {
      return desktop.application.evaluate(async ({ app, utilityProcess }, args) => {
        const child = utilityProcess.fork(args.helper, [args.stage, args.stopAt, app.getAppPath() + '/apps/api/src/storage-maintenance.mjs'], { stdio: 'pipe', serviceName: 'Classifier Migration Validation' })
        return new Promise((resolve, reject) => {
          let result, diagnostics = ''
          const timer = setTimeout(() => { child.kill(); reject(new Error('Migration utility timeout: ' + diagnostics)) }, 30000)
          child.stdout?.on('data', () => {}); child.stderr?.on('data', data => { diagnostics += data })
          child.on('message', message => {
            result = message
            if (message.type === 'checkpoint') process.kill(child.pid, 'SIGKILL')
            else child.postMessage({ type: 'finish' })
          })
          child.once('exit', code => {
            clearTimeout(timer)
            if (result?.type === 'checkpoint' || (code === 0 && result?.type === 'result')) resolve(result)
            else reject(new Error(result?.message || 'Migration utility exit ' + code + ': ' + diagnostics))
          })
        })
      }, { helper: resolve('tests/helpers/migration-child.mjs'), stage: prepared.stage, stopAt })
    }
    const killed = await run(phase)
    expect(killed.type).toBe('checkpoint')
    if (phase === 'records') expect(killed.progress.completedRecords).toBe(100)
    const resumed = await run('')
    expect(resumed.result.migrationId).toBe(prepared.migrationId)
    const verification = await desktop.application.evaluate(async ({ app }, prepared) => {
      const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
      const { createStore } = require(app.getAppPath() + '/apps/api/src/store.mjs')
      const { migrationStatus, resumeMigration } = require(app.getAppPath() + '/apps/api/src/storage-maintenance.mjs')
      const store = await createStore(prepared.destination)
      try {
        const notes = await store.list('notes')
        return { packaged: app.isPackaged, runtime: process.versions, document: await store.document(prepared.id), notes: notes.length, historiesPreserved: notes.every(note => note.revision === 2 && note.history[0].content.startsWith('Earlier ')), original: (await store.original(prepared.id)).toString(), status: await migrationStatus(prepared.stage), idempotent: (await resumeMigration(prepared.stage)).alreadyCompleted }
      } finally { store.close() }
    }, prepared)
    expect(verification.notes).toBe(105)
    expect(verification.historiesPreserved).toBe(true)
    expect(verification.original).toBe('Evidence')
    expect(verification.status.phase).toBe('complete')
    expect(verification.idempotent).toBe(true)
    if (process.env.CLASSIFIER_PACKAGED_EXECUTABLE) expect(verification.packaged).toBe(true)
    await writeFile(testInfo.outputPath('migration-recovery.json'), JSON.stringify({ phase, forcedExit: true, resumed: true, verification }, null, 2) + '\n')
  })
}
