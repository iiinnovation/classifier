import { test, expect } from '../helpers/desktop-application.mjs'
import { writeFile } from 'node:fs/promises'

test('D1 packaged storage migrates restores and serves a SQLite library with directory ownership', async ({ desktop }, testInfo) => {
  const result = await desktop.application.evaluate(async ({ app }, profile) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    const { join } = require('node:path'), { randomUUID } = require('node:crypto')
    const { createStore } = require(app.getAppPath() + '/apps/api/src/store.mjs')
    const { migrateLibrary, backupLibrary, restoreLibrary } = require(app.getAppPath() + '/apps/api/src/storage-maintenance.mjs')
    const { BackendController } = require(app.getAppPath() + '/apps/desktop/backend-controller.mjs')
    const source = join(profile, 'legacy'), target = join(profile, 'migrated'), backup = join(profile, 'before'), restored = join(profile, 'restored')
    const store = await createStore(source), id = randomUUID()
    const document = { id, title: 'Packaged migration', fileName: 'fixture.txt', mediaType: 'text/plain', createdAt: new Date().toISOString(), warnings: [], sections: [{ title: 'Text', text: 'Local test evidence' }], references: [{ id: 'ref_00001', title: 'Text', text: 'Local test evidence' }] }
    await store.saveOriginal(id, Buffer.from('Local test evidence')); await store.write('documents', document)
    const migration = await migrateLibrary(source, target, backup)
    const snapshot = await backupLibrary(target, join(profile, 'sqlite-backup'))
    await restoreLibrary(snapshot.destination, restored)
    const ocrRoot = app.isPackaged ? join(process.resourcesPath, 'ocr') : join(app.getAppPath(), 'resources/ocr', process.platform + '-' + process.arch)
    const controller = new BackendController({ dataDir: restored, ocrRoot })
    try {
      await controller.start()
      const { port, token } = controller.connection
      const response = await fetch('http://127.0.0.1:' + port + '/api/documents/' + id, { headers: { origin: 'app://classifier', 'x-classifier-instance': token } })
      const read = await response.json()
      let busy
      try { await backupLibrary(restored, join(profile, 'must-not-exist')) } catch (error) { busy = error.code }
      return { packaged: app.isPackaged, migrationRecords: migration.records, storage: snapshot.manifest.storage, status: response.status, title: read.title, busy, backendRuntime: controller.info.versions }
    } finally { await controller.stop() }
  }, desktop.profile)
  expect(result.status).toBe(200)
  expect(result.migrationRecords).toBe(1)
  expect(result.storage).toBe('sqlite')
  expect(result.title).toBe('Packaged migration')
  expect(result.busy).toBe('DATA_DIRECTORY_LOCKED')
  if (process.env.CLASSIFIER_PACKAGED_EXECUTABLE) expect(result.packaged).toBe(true)
  await writeFile(testInfo.outputPath('maintenance-validation.json'), JSON.stringify(result, null, 2) + '\n')
})
