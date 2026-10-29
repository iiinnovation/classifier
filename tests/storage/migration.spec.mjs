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
      const document = { id, title: 'Packaged resumable migration', createdAt, sections: [], references: [{ id: 'ref_00001', text: 'Evidence' }] }
      await store.saveOriginal(id, Buffer.from('Evidence')); await store.write('documents', document)
      for (let i = 0; i < 105; i++) await store.write('notes', { id: randomUUID(), documentId: id, createdAt, revision: 2, content: 'Note ' + i, evidence: [], history: [{ revision: 1, content: 'Earlier ' + i, evidence: [] }] })
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

test('D1 packaged migration validates records and live references while preserving copied snapshots', async ({ desktop }, testInfo) => {
  const verification = await desktop.application.evaluate(async ({ app }, profile) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    const assert = require('node:assert/strict'), { join } = require('node:path'), { randomUUID } = require('node:crypto')
    const { readFile, writeFile, access } = require('node:fs/promises')
    const { createStore } = require(app.getAppPath() + '/apps/api/src/store.mjs')
    const { migrateLibrary, verifyBackup } = require(app.getAppPath() + '/apps/api/src/storage-maintenance.mjs')
    const results = []
    for (const scenario of ['damaged-record', 'missing-current-document', 'retained-snapshots', 'uuid-casing']) {
      const source = join(profile, scenario), target = source + '-migrated', backup = source + '-before'
      const store = await createStore(source), createdAt = new Date().toISOString(), missingDocument = randomUUID(), missingNote = randomUUID(), columnId = randomUUID()
      const document = { id: randomUUID(), createdAt, title: 'Current document', sections: [], references: [] }
      const topic = { id: randomUUID(), createdAt, title: 'Research', documents: [{ documentId: document.id }] }
      const oldEvidence = { id: 'saved-citation', documentId: missingDocument, documentVersion: 'saved-version', reference: { id: 'ref_00001', text: 'Historical source text' } }
      const note = { id: randomUUID(), createdAt, documentId: document.id, topicId: topic.id, content: 'Saved note', evidence: [], history: [] }
      const comparison = { id: randomUUID(), createdAt, topicId: topic.id, documentIds: [document.id], columns: [{ id: columnId, name: 'Evidence' }],
        cells: [{ documentId: document.id, columnId, value: 'Copied note', evidence: [], noteSources: [{ id: missingNote, revision: 1 }], origin: { type: 'note' } }],
        analyses: [{ columnId, value: 'Saved analysis', rows: [{ documentId: missingDocument, value: 'Old input' }], evidence: [oldEvidence], origin: { type: 'user' } }],
        history: [{ documentIds: [missingDocument], columns: [{ id: columnId, name: 'Evidence' }], cells: [], analyses: [] }] }
      const material = { key: 'note:' + missingNote, type: 'note', id: missingNote, documentIds: [missingDocument], documents: [{ id: missingDocument, title: 'Old document' }], evidence: [oldEvidence], content: [{ field: '主要发现', text: 'Copied note', citationIds: ['saved-citation'] }] }
      const report = { id: randomUUID(), createdAt, topicId: topic.id, title: 'Saved report', sources: [material], evidence: [oldEvidence], blocks: [], history: [{ sources: [material], evidence: [oldEvidence], blocks: [] }] }
      const records = { documents: document, topics: topic, notes: note, comparisons: comparison, reports: report }
      if (scenario === 'uuid-casing') { comparison.documentIds = [document.id.toUpperCase()]; comparison.cells[0].documentId = document.id.toUpperCase() }
      await store.saveOriginal(document.id, Buffer.from('Current original'))
      for (const [bucket, record] of Object.entries(records)) await store.write(bucket, record)
      if (scenario === 'damaged-record') { delete note.evidence; await writeFile(join(source, 'notes', note.id + '.json'), JSON.stringify(note)) }
      if (scenario === 'missing-current-document') { comparison.documentIds.push(missingDocument); await writeFile(join(source, 'comparisons', comparison.id + '.json'), JSON.stringify(comparison)) }
      const originals = new Map()
      for (const [bucket, record] of Object.entries(records)) originals.set(bucket, await readFile(join(source, bucket, record.id + '.json')))
      if (scenario === 'retained-snapshots' || scenario === 'uuid-casing') {
        await migrateLibrary(source, target, backup)
        const migrated = await createStore(target)
        try {
          for (const [bucket, record] of Object.entries(records)) assert.deepEqual(await migrated.read(bucket, record.id), record)
          assert.equal((await migrated.original(document.id)).toString(), 'Current original')
        } finally { migrated.close() }
      } else {
        await assert.rejects(migrateLibrary(source, target, backup), scenario === 'damaged-record' ? { code: 'RECORD_CORRUPT' } : /比较表引用缺失文献/)
        await assert.rejects(access(target), { code: 'ENOENT' })
      }
      await verifyBackup(backup)
      for (const [bucket, record] of Object.entries(records)) {
        assert.deepEqual(await readFile(join(source, bucket, record.id + '.json')), originals.get(bucket))
        assert.deepEqual(await readFile(join(backup, bucket, record.id + '.json')), originals.get(bucket))
      }
      results.push({ scenario, passed: true, sourceAndBackupBytesPreserved: true })
    }
    return { packaged: app.isPackaged, runtime: process.versions, source: app.getAppPath(), results }
  }, desktop.profile)
  expect(verification.packaged).toBe(Boolean(process.env.CLASSIFIER_PACKAGED_EXECUTABLE))
  expect(verification.results).toHaveLength(4)
  expect(verification.results.every(result => result.passed && result.sourceAndBackupBytesPreserved)).toBe(true)
  await writeFile(testInfo.outputPath('migration-validation.json'), JSON.stringify(verification, null, 2) + '\n')
})
