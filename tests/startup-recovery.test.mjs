import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, access, mkdir, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createStore } from '../apps/api/src/store.mjs'
import { createApp } from '../apps/api/src/server.mjs'
import { backupLibrary, migrateLibrary } from '../apps/api/src/storage-maintenance.mjs'
import { backupZipLibrary } from '../apps/api/src/storage-zip.mjs'
import { backupCompatibility, restoreUnavailableLibrary } from '../apps/api/src/library-recovery.mjs'
import { createLibraryManager, selectedLibrary, saveLibrarySelection } from '../apps/desktop/library-manager.mjs'
import { recoverStartup } from '../apps/desktop/startup-recovery.mjs'
import { executeMaintenance } from '../apps/desktop/maintenance-operations.mjs'
import { acquireDataLock } from '../apps/api/src/data-lock.mjs'

async function fixture(t, { format = 'directory', storage = 'json', persistSelection } = {}) {
  const profile = await mkdtemp(join(tmpdir(), 'classifier-startup-recovery-')), source = join(profile, 'data')
  const store = await createStore(source), id = randomUUID(), jobId = randomUUID(), createdAt = new Date().toISOString()
  await store.write('topics', { id, title: 'compatible snapshot', question: 'Research', createdAt, documents: [] })
  await store.write('runs', { id: jobId, status: 'running', createdAt })
  let snapshotSource = source
  if (storage === 'sqlite') { snapshotSource = join(profile, 'sqlite'); await migrateLibrary(source, snapshotSource, join(profile, 'before')) }
  const backup = join(profile, format === 'zip' ? 'backup.zip' : 'backup')
  if (format === 'zip') await backupZipLibrary(snapshotSource, backup); else await backupLibrary(snapshotSource, backup)
  await store.update('topics', id, value => ({ ...value, title: 'newer work retained only in original' }))
  const futureManifest = JSON.stringify({ formatVersion: 99, storage: 'sqlite', state: 'ready', recordVersion: 9 })
  await writeFile(join(source, 'library-manifest.json'), futureManifest)
  let server, starts = [], stops = 0
  const controller = { dataDir: source, async start() { starts.push(this.dataDir); server = await createApp({ dataDir: this.dataDir }) }, async stop() { stops++; await server?.shutdown(); server = null } }
  t.after(async () => { await controller.stop(); await rm(profile, { recursive: true, force: true }) })
  await assert.rejects(controller.start(), /格式不受支持/)
  const calls = [], run = async (command, args, options) => { calls.push(command); return executeMaintenance(command, args, options) }
  const manager = createLibraryManager({ profile, controller, run, ...(persistSelection ? { persistSelection } : {}) })
  return { profile, source, backup, format, storage, controller, manager, run, calls, starts, id, jobId, futureManifest, running: () => Boolean(server) }
}

for (const format of ['directory', 'zip']) for (const storage of ['json', 'sqlite']) test(`startup recovery opens ${format} ${storage} compatibility snapshot after preserving an unreadable future library`, async t => {
  const f = await fixture(t, { format, storage })
  const preview = await backupCompatibility(f.backup, { format })
  assert.equal(preview.storage, storage)
  const result = await f.manager.restoreUnavailable(f.backup, { format, revision: preview.revision })
  assert.equal(f.running(), true); assert.equal(await selectedLibrary(f.profile), f.controller.dataDir)
  assert.equal(await readFile(join(f.source, 'library-manifest.json'), 'utf8'), f.futureManifest)
  assert.equal(await readFile(join(result.preservation, 'library-manifest.json'), 'utf8'), f.futureManifest)
  assert.equal(JSON.parse(await readFile(join(f.source, 'runs', f.jobId + '.json'), 'utf8')).status, 'running')
  assert.equal(JSON.parse(await readFile(join(f.source, 'topics', f.id + '.json'), 'utf8')).title, 'newer work retained only in original')
  assert.equal(JSON.parse(await readFile(join(result.preservation, 'topics', f.id + '.json'), 'utf8')).title, 'newer work retained only in original')
  await f.controller.stop()
  const recovered = await createStore(result.destination)
  try { assert.equal((await recovered.read('topics', f.id)).title, 'compatible snapshot'); assert.equal((await recovered.read('runs', f.jobId)).status, 'interrupted') }
  finally { recovered.close?.() }
})

test('startup dialogs show the exact compatibility cutoff before recovery and return success only after activation', async t => {
  const f = await fixture(t), messages = [], responses = [3, 1, 1, 0]
  const dialog = {
    async showMessageBox(options) { messages.push(options); return { response: responses.shift() ?? 0 } },
    async showOpenDialog() { return { canceled: false, filePaths: [f.backup] } },
  }
  assert.equal(await recoverStartup({ error: new Error('unsupported library'), controller: f.controller, manager: f.manager, run: f.run, dialog }), true)
  assert.match(messages[0].detail, /没有兼容备份/)
  assert.match(messages[2].detail, /备份时点：/); assert.match(messages[2].detail, /不会合并/)
  assert.equal(messages[3].message, '已打开兼容备份的恢复副本'); assert.equal(f.running(), true)
})

test('cancel or quit during compatibility preview never starts or preserves a library', async t => {
  for (const quit of [false, true]) {
    const f = await fixture(t), responses = [3, 1, 0, 0]
    let closing = false
    const run = async (command, args) => { const value = await f.run(command, args); if (quit && command === 'backup-compatibility') closing = true; return value }
    const dialog = { async showMessageBox() { return { response: responses.shift() ?? 0 } }, async showOpenDialog() { return { canceled: false, filePaths: [f.backup] } } }
    assert.equal(await recoverStartup({ error: new Error('unsupported'), controller: f.controller, manager: f.manager, run, dialog, closing: () => closing }), false)
    assert.deepEqual(f.calls, ['backup-compatibility']); assert.equal(f.starts.length, 1)
    await assert.rejects(access(join(f.profile, 'library-backups')))
  }
})

for (const failure of ['selection', 'startup', 'preservation']) test(`compatibility recovery ${failure} failure keeps the original selection and original bytes`, async t => {
  const f = await fixture(t, failure === 'selection' ? { persistSelection: async () => { throw new Error('selection disk full') } } : {})
  await saveLibrarySelection(f.profile, f.source)
  const preview = await backupCompatibility(f.backup)
  if (failure === 'startup') f.controller.start = async () => { throw new Error('target cannot start') }
  if (failure === 'preservation') {
    await mkdir(join(f.profile, 'external')); await symlink(join(f.profile, 'external'), join(f.source, 'quarantine'), 'dir')
  }
  await assert.rejects(f.manager.restoreUnavailable(f.backup, { revision: preview.revision }))
  assert.equal(f.running(), false); assert.equal(f.controller.dataDir, f.source)
  assert.equal(await selectedLibrary(f.profile), await realpath(f.source))
  assert.equal(await readFile(join(f.source, 'library-manifest.json'), 'utf8'), f.futureManifest)
  assert.equal(JSON.parse(await readFile(join(f.source, 'runs', f.jobId + '.json'), 'utf8')).status, 'running')
})

test('compatibility restores reject changed backup confirmation and active original ownership', async t => {
  const f = await fixture(t), preview = await backupCompatibility(f.backup)
  const owner = await acquireDataLock(f.source)
  try { await assert.rejects(f.manager.restoreUnavailable(f.backup, { revision: preview.revision }), { message: /原资料库位置保留/ }) }
  finally { owner.release() }
  const manifestPath = join(f.backup, 'backup-manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  await writeFile(manifestPath, JSON.stringify({ ...manifest, createdAt: '2026-10-25T00:00:00Z' }))
  await assert.rejects(f.manager.restoreUnavailable(f.backup, { revision: preview.revision }), /备份在确认后发生变化/)
  assert.equal(f.running(), false); assert.equal(f.starts.length, 1)
})

test('format guard refuses symlinked or oversized manifests before updating queued records', async t => {
  const f = await fixture(t), path = join(f.source, 'library-manifest.json'), external = join(f.profile, 'external-manifest.json')
  await writeFile(external, JSON.stringify({ formatVersion: 1, storage: 'sqlite', state: 'ready' }))
  await rm(path); await symlink(external, path)
  await assert.rejects(createApp({ dataDir: f.source }), /版本清单损坏/)
  await rm(path); await writeFile(path, ' '.repeat(64 * 1024 + 1))
  await assert.rejects(createApp({ dataDir: f.source }), /版本清单损坏/)
  assert.equal(JSON.parse(await readFile(join(f.source, 'runs', f.jobId + '.json'), 'utf8')).status, 'running')
})
