import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createStore } from '../apps/api/src/store.mjs'
import { acquireDataLock } from '../apps/api/src/data-lock.mjs'
import { maintenanceChannel } from '../apps/desktop/maintenance-channel.mjs'

function run(command, args, options) {
  const child = fork(new URL('./helpers/maintenance-child.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  child.postMessage = data => child.send(data)
  return maintenanceChannel(child, command, args, options)
}

test('production maintenance worker reports migration progress and exits before the library is reopened', async t => {
  const root = await mkdtemp(join(tmpdir(), 'classifier-maintenance-worker-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source'), store = await createStore(source)
  const id = randomUUID()
  await store.write('topics', { id, title: 'worker fixture', createdAt: new Date().toISOString(), documents: [] })
  const prepared = await run('prepare-migration', { source, destination: join(root, 'sqlite'), backup: join(root, 'backup') })
  const progress = []
  const result = await run('resume-migration', { source: prepared.stage }, { onProgress: value => { progress.push(value.phase); throw new Error('presentation failure') } })
  assert.equal(result.storage, 'sqlite')
  assert.ok(progress.includes('records')); assert.equal(progress.at(-1), 'complete')
  const owner = await acquireDataLock(result.destination)
  try {
    const migrated = await createStore(result.destination)
    try { assert.equal((await migrated.read('topics', id)).title, 'worker fixture') } finally { migrated.close() }
  } finally { owner.release() }
  assert.equal((await run('migration-status', { source: prepared.stage })).phase, 'complete')
  await assert.rejects(run('unknown', { source }), /未知资料库操作/)
})

test('maintenance startup timeout waits for child exit before rejecting', async () => {
  const child = new EventEmitter(), killed = Promise.withResolvers()
  child.kill = () => killed.resolve()
  let settled = false
  const pending = maintenanceChannel(child, 'inspect', {}, { readyTimeoutMs: 5 })
  const checked = assert.rejects(pending, /启动超时/).then(() => { settled = true })
  await killed.promise
  assert.equal(settled, false)
  child.emit('exit', 1)
  await checked
})
