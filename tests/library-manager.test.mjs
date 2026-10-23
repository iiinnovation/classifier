import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, realpath, mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createStore } from '../apps/api/src/store.mjs'
import { createApp } from '../apps/api/src/server.mjs'
import { inspectLibrary } from '../apps/api/src/library-inspection.mjs'
import { backupLibrary, restoreLibrary, verifyBackup, migrateLibrary } from '../apps/api/src/storage-maintenance.mjs'
import { createLibraryManager, selectedLibrary, libraryScope, saveLibrarySelection } from '../apps/desktop/library-manager.mjs'
import { executeMaintenance } from '../apps/desktop/maintenance-operations.mjs'

async function fixture(t, extras = {}) {
  const profile = await mkdtemp(join(tmpdir(), 'classifier-library-manager-')), source = join(profile, 'data')
  const store = await createStore(source), id = randomUUID()
  await store.write('topics', { id, title: 'current research', createdAt: new Date().toISOString(), documents: [] })
  const backup = join(profile, 'original-backup'); await backupLibrary(source, backup)
  let server, running = false, failTarget = false
  const controller = { dataDir: source,
    async stop() { await server?.shutdown(); server = null; running = false },
    async start() {
      assert.equal(running, false)
      if (failTarget && this.dataDir !== source) throw new Error('injected target startup failure')
      server = await createApp({ dataDir: this.dataDir }); running = true
    },
  }
  t.after(async () => { await controller.stop(); await rm(profile, { recursive: true, force: true }) })
  await controller.start()
  const calls = [], busy = []
  const run = async (command, args, options) => {
    calls.push(command)
    return executeMaintenance(command, args, options)
  }
  const manager = createLibraryManager({ profile, controller, run, onBusy: value => busy.push(value), ...extras })
  return { profile, source, store, id, backup, controller, manager, calls, busy, run, running: () => running, failTarget: () => { failTarget = true } }
}

test('desktop inspection and backup release ownership and restart the original library', async t => {
  const f = await fixture(t)
  assert.equal((await f.manager.inspect()).records, 1)
  assert.equal(f.running(), true)
  const result = await f.manager.backup(join(f.profile, 'new-backup'))
  assert.equal((await verifyBackup(result.destination)).storage, 'json')
  assert.equal(f.controller.dataDir, f.source)
  assert.equal(f.running(), true)
  assert.deepEqual(f.busy, [true, false, true, false])
  await assert.rejects(inspectLibrary(f.source), { code: 'DATA_DIRECTORY_LOCKED' })
})

test('desktop restore preserves current edits makes a safety backup and commits selection only after startup', async t => {
  const f = await fixture(t)
  await f.store.update('topics', f.id, value => ({ ...value, title: 'newer research' }))
  const result = await f.manager.restore(f.backup)
  assert.equal((await f.store.read('topics', f.id)).title, 'newer research')
  assert.equal((await createStore(result.destination)).read instanceof Function, true)
  assert.equal((await (await createStore(result.destination)).read('topics', f.id)).title, 'current research')
  const safety = JSON.parse(await readFile(join(result.previousBackup, 'topics', f.id + '.json'), 'utf8'))
  assert.equal(safety.title, 'newer research')
  assert.equal(await selectedLibrary(f.profile), await realpath(result.destination))
  assert.notEqual(libraryScope(f.profile, result.destination), libraryScope(f.profile, f.source))
  assert.equal(f.running(), true)
  assert.deepEqual(f.calls, ['verify', 'backup', 'restore', 'inspect'])
})

for (const failure of ['startup', 'selection']) test(`desktop restore rolls back after ${failure} failure`, async t => {
  const f = await fixture(t, failure === 'selection' ? { persistSelection: async () => { throw new Error('injected selection write failure') } } : {})
  if (failure === 'startup') f.failTarget()
  await assert.rejects(f.manager.restore(f.backup), /已回到原资料库/)
  assert.equal(f.controller.dataDir, f.source)
  assert.equal(f.running(), true)
  assert.equal(await selectedLibrary(f.profile), f.source)
  assert.equal((await f.store.read('topics', f.id)).title, 'current research')
})

test('corrupt backup and failed restore do not change the selected library', async t => {
  const f = await fixture(t)
  await writeFile(join(f.backup, 'topics', f.id + '.json'), 'tampered')
  await assert.rejects(f.manager.restore(f.backup), /校验失败/)
  assert.equal(f.running(), true)
  assert.equal(f.controller.dataDir, f.source)
  assert.deepEqual(f.calls, ['verify'])
  const manager = createLibraryManager({ profile: f.profile, controller: f.controller, run: async (command, args) => {
    if (command === 'restore') throw new Error('copy failed')
    if (command === 'verify') return {}
    return f.run(command, args)
  } })
  await assert.rejects(manager.restore(f.backup), /copy failed/)
  assert.equal(f.running(), true)
  assert.equal(await selectedLibrary(f.profile), f.source)
})

test('switching to an existing library verifies it and prevents concurrent maintenance', async t => {
  const f = await fixture(t), target = join(f.profile, 'another-library')
  await restoreLibrary(f.backup, target)
  const result = await f.manager.switchTo(target)
  assert.equal(result.destination, await realpath(target))
  assert.equal(await selectedLibrary(f.profile), await realpath(target))
  const gate = Promise.withResolvers()
  const manager = createLibraryManager({ profile: f.profile, controller: f.controller, run: async () => { await gate.promise; return {} } })
  const first = manager.inspect()
  await assert.rejects(manager.backup(join(f.profile, 'other-backup')), /正在进行/)
  let idle = false; const waiting = manager.idle().then(() => { idle = true })
  await new Promise(resolve => setImmediate(resolve)); assert.equal(idle, false)
  gate.resolve(); await first; await waiting
  assert.equal(f.running(), true)
})

test('invalid saved selection and empty target fail without creating a replacement library', async t => {
  const f = await fixture(t), empty = join(f.profile, 'empty')
  await mkdir(empty)
  await assert.rejects(f.manager.switchTo(empty), /未找到已有资料库/)
  await saveLibrarySelection(f.profile, join(f.profile, 'missing'))
  await assert.rejects(selectedLibrary(f.profile))
  await writeFile(join(f.profile, 'library-selection.json'), '{broken')
  await assert.rejects(selectedLibrary(f.profile), /未改用空资料库/)
  assert.equal(f.running(), true)
})

test('inspection remains available when damaged records prevent backend restart', async t => {
  const f = await fixture(t)
  await writeFile(join(f.source, 'runs', randomUUID() + '.json'), '{broken')
  const result = await f.manager.inspect()
  assert.equal(result.issues[0].code, 'invalid-record')
  assert.ok(result.restartError)
  assert.equal(f.running(), false)
  assert.equal(f.controller.dataDir, f.source)
})

test('restore aborts if the current safety backup cannot be made', async t => {
  const f = await fixture(t)
  const manager = createLibraryManager({ profile: f.profile, controller: f.controller, run: async (command, args) => {
    if (command === 'backup') throw new Error('backup disk full')
    if (command === 'restore') assert.fail('restore must not run without the safety backup')
    return f.run(command, args)
  } })
  await assert.rejects(manager.restore(f.backup), /backup disk full/)
  assert.equal(f.running(), true)
  assert.equal(await selectedLibrary(f.profile), f.source)
})

test('SQLite restore opens through the actual backend and library aliases share draft scope', async t => {
  const f = await fixture(t), sqlite = join(f.profile, 'sqlite')
  await f.controller.stop()
  await migrateLibrary(f.source, sqlite, join(f.profile, 'before-migration'))
  f.controller.dataDir = sqlite; await f.controller.start()
  const snapshot = await f.manager.backup(join(f.profile, 'sqlite-backup'))
  const result = await f.manager.restore(snapshot.destination)
  assert.equal(f.running(), true)
  assert.equal((await verifyBackup(result.previousBackup)).storage, 'sqlite')
  const alias = join(f.profile, 'alias'); await symlink(result.destination, alias)
  assert.equal(libraryScope(f.profile, alias), libraryScope(f.profile, result.destination))
  assert.equal(await selectedLibrary(f.profile), await realpath(result.destination))
})

test('desktop migration keeps the JSON source and verified backup and publishes progress before switching', async t => {
  const events = [], f = await fixture(t, { onProgress: event => events.push(event) })
  const before = await readFile(join(f.source, 'topics', f.id + '.json'))
  const result = await f.manager.migrate()
  assert.equal(result.storage, 'sqlite'); assert.equal(result.sourcePreserved, true)
  assert.equal((await verifyBackup(result.backup)).storage, 'json')
  assert.deepEqual(await readFile(join(f.source, 'topics', f.id + '.json')), before)
  assert.equal(await selectedLibrary(f.profile), await realpath(result.destination))
  assert.ok(events.some(event => event.phase === 'prepared' && event.stage))
  assert.equal(events.at(-1).phase, 'complete')
  assert.equal(f.running(), true)
  await assert.rejects(f.manager.migrate(), /无需升级/)
  assert.equal(f.running(), true)
})

test('interrupted desktop migration resumes its original snapshot and backs up later current-library edits', async t => {
  const f = await fixture(t)
  for (let i = 0; i < 105; i++) await f.store.write('topics', { id: randomUUID(), title: 'batch ' + i, createdAt: new Date().toISOString(), documents: [] })
  let prepared, failOnce = true
  const run = async (command, args, options) => {
    if (command === 'resume-migration') return executeMaintenance(command, args, { onProgress: async event => {
      await options?.onProgress?.(event)
      if (event.phase === 'records' && failOnce) { failOnce = false; throw new Error('injected migration interruption') }
    } })
    const result = await f.run(command, args, options)
    if (command === 'prepare-migration') prepared = result
    return result
  }
  const manager = createLibraryManager({ profile: f.profile, controller: f.controller, run })
  await assert.rejects(manager.migrate(), /已回到原资料库/)
  assert.equal(f.controller.dataDir, f.source); assert.equal(f.running(), true)
  const interrupted = await manager.migrationStatus(prepared.stage)
  assert.equal(interrupted.completedRecords, 100)
  await f.store.update('topics', f.id, current => ({ ...current, title: 'changes after interruption' }))
  const result = await manager.resumeMigration(prepared.stage)
  assert.equal(f.running(), true)
  assert.equal((await manager.migrationStatus(prepared.stage)).phase, 'complete')
  const preserved = JSON.parse(await readFile(join(result.previousBackup, 'topics', f.id + '.json'), 'utf8'))
  assert.equal(preserved.title, 'changes after interruption')
  const migrated = await createStore(result.destination)
  try {
    assert.equal((await migrated.read('topics', f.id)).title, 'current research')
    await migrated.update('topics', f.id, current => ({ ...current, title: 'edits in completed target' }))
    assert.equal((await manager.resumeMigration(prepared.stage)).alreadyCompleted, true)
    assert.equal((await migrated.read('topics', f.id)).title, 'edits in completed target')
  } finally { migrated.close() }
})

test('migration activation failure leaves a completed target that can be selected on retry', async t => {
  let prepared
  const f = await fixture(t, { onProgress: event => { if (event.phase === 'prepared') prepared = event }, persistSelection: async () => { throw new Error('selection write failed') } })
  await assert.rejects(f.manager.migrate(), /已回到原资料库/)
  assert.equal(f.controller.dataDir, f.source); assert.equal(f.running(), true)
  assert.equal((await f.manager.migrationStatus(prepared.stage)).phase, 'complete')
  const manager = createLibraryManager({ profile: f.profile, controller: f.controller, run: f.run })
  const result = await manager.resumeMigration(prepared.stage)
  assert.equal(result.alreadyCompleted, true)
  assert.equal(await selectedLibrary(f.profile), await realpath(result.destination))
})

test('resume rejects a changed snapshot without switching away from the current library', async t => {
  const f = await fixture(t)
  await f.controller.stop()
  const prepared = await executeMaintenance('prepare-migration', { source: f.source, destination: join(f.profile, 'target'), backup: join(f.profile, 'migration-backup') })
  await f.controller.start()
  await writeFile(join(prepared.backup, 'topics', f.id + '.json'), 'modified snapshot')
  await assert.rejects(f.manager.resumeMigration(prepared.stage), /校验失败/)
  assert.equal(f.controller.dataDir, f.source); assert.equal(f.running(), true)
  assert.equal(await selectedLibrary(f.profile), f.source)
  assert.equal((await f.manager.migrationStatus(prepared.stage)).completedRecords, 0)
})
