import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, writeFile, readFile, rm, readdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createStore } from '../apps/api/src/store.mjs'
import { prepareMigration, prepareMigrationFromBackup, resumeMigration, verifyBackup } from '../apps/api/src/storage-maintenance.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'classifier-prepare-recovery-')); t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source'), destination = join(root, 'sqlite'), backup = join(root, 'before'), id = randomUUID(), store = await createStore(source)
  const topic = { id, title: 'fixed snapshot', question: 'research', createdAt: new Date().toISOString(), documents: [] }
  await store.write('topics', topic)
  return { root, source, destination, backup, store, topic }
}
for (const phase of ['preparation-backup', 'preparation-layout', 'preparation-state', 'preparation-database', 'preparation-ready']) test(`migration rebuilds from its fixed backup after actual SIGKILL at ${phase}`, { timeout: 20000 }, async t => {
  const f = await fixture(t)
  const child = fork(new URL('./helpers/preparation-child.mjs', import.meta.url), [f.source, f.destination, f.backup, phase], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const exited = once(child, 'exit')
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  const checkpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('No preparation checkpoint')) }, 10000)
    child.once('message', value => { clearTimeout(timer); value.type === 'checkpoint' ? resolve(value.progress) : reject(new Error(JSON.stringify(value))) })
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Preparation exited before checkpoint')) })
    child.once('error', reject)
  })
  child.kill('SIGKILL'); assert.equal((await exited)[1], 'SIGKILL')
  const originalBackup = await readFile(join(f.backup, 'backup-manifest.json'))
  assert.equal((await verifyBackup(f.backup)).storage, 'json')
  const before = new Map()
  if (checkpoint.stage) for (const name of await readdir(checkpoint.stage)) if (!name.startsWith('.classifier-lock')) before.set(name, await readFile(join(checkpoint.stage, name)))
  await f.store.write('topics', { ...f.topic, title: 'newer source edit' })
  const prepared = await prepareMigrationFromBackup(f.backup, join(f.root, 'new-target'))
  await resumeMigration(prepared.stage)
  const migrated = await createStore(prepared.destination)
  try { assert.deepEqual(await migrated.read('topics', f.topic.id), f.topic) } finally { migrated.close() }
  assert.equal((await f.store.read('topics', f.topic.id)).title, 'newer source edit')
  assert.deepEqual(await readFile(join(f.backup, 'backup-manifest.json')), originalBackup)
  if (checkpoint.stage) for (const [name, bytes] of before) assert.deepEqual(await readFile(join(checkpoint.stage, name)), bytes)
  await assert.rejects(access(f.destination))
})

test('failed preparation reports the preserved backup and rejects tampered snapshots or non-JSON backups', async t => {
  const f = await fixture(t)
  await assert.rejects(prepareMigration(f.source, f.destination, f.backup, { onProgress: progress => { if (progress.phase === 'preparation-layout') throw new Error('injected disk failure') } }), error => /升级前备份保留于/.test(error.message) && error.message.includes(f.backup))
  const manifestPath = join(f.backup, 'backup-manifest.json'), bytes = await readFile(join(f.backup, 'topics', f.topic.id + '.json'))
  await writeFile(join(f.backup, 'topics', f.topic.id + '.json'), 'tampered')
  await assert.rejects(prepareMigrationFromBackup(f.backup, join(f.root, 'refused')), /校验失败/)
  await writeFile(join(f.backup, 'topics', f.topic.id + '.json'), bytes)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); manifest.storage = 'sqlite'; manifest.formatVersion = 1
  await writeFile(manifestPath, JSON.stringify(manifest))
  await assert.rejects(prepareMigrationFromBackup(f.backup, join(f.root, 'also-refused')))
})
