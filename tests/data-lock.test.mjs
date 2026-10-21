import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtemp, rm, writeFile, readFile, mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { acquireDataLock } from '../apps/api/src/data-lock.mjs'
import { createApp } from '../apps/api/src/server.mjs'
import { createStore } from '../apps/api/src/store.mjs'
import { once } from 'node:events'

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'classifier-lock-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('D1 directory lock refuses another process and releases after forced exit without PID heuristics', { timeout: 10000 }, async t => {
  const root = await directory(t)
  const child = fork(new URL('./helpers/data-lock-child.mjs', import.meta.url), [root], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const closed = new Promise(resolve => child.once('close', resolve))
  t.after(async () => { child.kill('SIGKILL'); await closed })
  await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', () => reject(new Error('Lock child exited early'))) })
  await assert.rejects(acquireDataLock(root), { code: 'DATA_DIRECTORY_LOCKED' })
  child.kill('SIGKILL'); await closed
  const recovered = await acquireDataLock(root)
  await assert.rejects(acquireDataLock(root), { code: 'DATA_DIRECTORY_LOCKED' })
  recovered.release(); recovered.release()
  const reopened = await acquireDataLock(root); reopened.release()
})

test('D1 directory ownership precedes storage scan and interrupted-task updates', async t => {
  const root = await directory(t), id = randomUUID()
  await mkdir(join(root, 'runs'))
  const path = join(root, 'runs', id + '.json')
  await writeFile(path, JSON.stringify({ id, status: 'running', createdAt: new Date().toISOString() }))
  const owner = await acquireDataLock(root)
  let visited = false
  try {
    await assert.rejects(createApp({ dataDir: root, storeFactory: async () => { visited = true } }), { code: 'DATA_DIRECTORY_LOCKED' })
    assert.equal(visited, false)
    assert.equal(JSON.parse(await readFile(path, 'utf8')).status, 'running')
  } finally { owner.release() }
  const server = await createApp({ dataDir: root })
  assert.equal(JSON.parse(await readFile(path, 'utf8')).status, 'interrupted')
  await server.shutdown()
  const reopened = await createApp({ dataDir: root }); await reopened.shutdown()
})

test('D1 failed storage initialization releases ownership and directory aliases share the lock', async t => {
  const parent = await directory(t), root = join(parent, 'data'), alias = join(parent, 'alias')
  await mkdir(root); await symlink(root, alias, 'dir')
  await assert.rejects(createApp({ dataDir: root, storeFactory: async () => { throw new Error('fixture startup failure') } }), /fixture startup failure/)
  const first = await acquireDataLock(root)
  try { await assert.rejects(acquireDataLock(alias), { code: 'DATA_DIRECTORY_LOCKED' }) }
  finally { first.release() }
  const second = await acquireDataLock(alias); second.release()
})

test('D1 lock corruption fails closed and never erases the evidence', async t => {
  const root = await directory(t), path = join(root, '.classifier-lock.sqlite')
  const bytes = Buffer.from('invalid lock database fixture')
  await writeFile(path, bytes)
  await assert.rejects(acquireDataLock(root))
  assert.deepEqual(await readFile(path), bytes)
})

test('D1 shutdown retains directory ownership until admitted document writes settle', { timeout: 10000 }, async t => {
  const root = await directory(t), writing = Promise.withResolvers(), release = Promise.withResolvers()
  const server = await createApp({ dataDir: root, storeFactory: async directory => {
    const store = await createStore(directory), original = store.saveOriginal
    store.saveOriginal = async (...args) => { writing.resolve(); await release.promise; return original(...args) }
    return store
  } })
  t.after(async () => { release.resolve(); await server.shutdown() })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const body = new FormData(); body.append('file', new Blob(['A pending document']), 'lock.txt')
  const pending = fetch('http://127.0.0.1:' + server.address().port + '/api/documents', { method: 'POST', body }).catch(() => null)
  await writing.promise
  const closed = server.shutdown()
  await assert.rejects(acquireDataLock(root), { code: 'DATA_DIRECTORY_LOCKED' })
  release.resolve(); await closed; await pending
  const next = await acquireDataLock(root); next.release()
})
