import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createApp } from '../../apps/api/src/server.mjs'
import { createStore } from '../../apps/api/src/store.mjs'
import { migrateLibrary } from '../../apps/api/src/storage-maintenance.mjs'
import { desktopOrigin, instanceHeader } from '../../apps/api/src/desktop-security.mjs'

const desktopBackends = new Map()
export const desktopBackendFor = origin => desktopBackends.get(origin)

export async function testApp(options = {}) {
  const desktopToken = process.env.CLASSIFIER_E2E_TRANSPORT === 'electron' ? randomBytes(32).toString('hex') : null
  const headers = desktopToken ? { origin: desktopOrigin, [instanceHeader]: desktopToken } : {}
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'classifier-m1-'))
  let dataDir = fixtureRoot, migrationRoot
  const original = '既有文献：研究者比较了两组材料，具体条件需结合原文核对。'
  const legacy = { id: randomUUID(), title: '既有研究资料', fileName: 'legacy.txt', mediaType: 'text/plain', createdAt: '2026-09-23T00:00:00.000Z', warnings: [], sections: [{ title: '原文', text: original }], references: [{ id: 'ref_00001', title: '原文第 1 段', text: original }] }
  await mkdir(join(dataDir, 'documents'), { recursive: true })
  await mkdir(join(dataDir, 'originals'), { recursive: true })
  await writeFile(join(dataDir, 'documents', `${legacy.id}.json`), JSON.stringify(legacy))
  await writeFile(join(dataDir, 'originals', legacy.id), original)
  if (process.env.CLASSIFIER_TEST_STORAGE === 'sqlite') {
    const migrated = await mkdtemp(join(tmpdir(), 'classifier-m1-sqlite-'))
    try {
      await migrateLibrary(dataDir, join(migrated, 'library'), join(migrated, 'before'))
      dataDir = join(migrated, 'library')
    } catch (error) {
      await rm(migrated, { recursive: true, force: true })
      await rm(fixtureRoot, { recursive: true, force: true })
      throw error
    }
    // Keep both the original fixture and migration evidence until test cleanup.
    migrationRoot = migrated
  }
  delete process.env.CLASSIFIER_MODEL_API_URL
  delete process.env.CLASSIFIER_MODEL_API_KEY
  let server, fixtureStore, port = 0
  async function start() {
    server = await createApp({ ...options, ...(desktopToken ? { desktopToken } : {}), dataDir, storeFactory: async root => {
      fixtureStore = await (options.storeFactory || createStore)(root)
      return fixtureStore
    } })
    server.listen(port, '127.0.0.1')
    await once(server, 'listening')
    port = server.address().port
  }
  async function stop() {
    if (server) await server.shutdown()
  }
  await start()
  const base = `http://127.0.0.1:${port}`
  if (desktopToken) desktopBackends.set(base, { port, token: desktopToken })
  return { base, dataDir, legacy, original, stop,
    // Test-only parse replacement goes through the owned store for either format.
    async changeDocument(id, change) {
      return fixtureStore.update('documents', id, current => { change(current); return current })
    },
    request: (path, options) => fetch(base + path, { ...options, headers: { ...headers, ...options?.headers } }),
    async restart() { await stop(); await start() },
    async close() { await stop(); desktopBackends.delete(base); await rm(fixtureRoot, { recursive: true, force: true }); if (migrationRoot) await rm(migrationRoot, { recursive: true, force: true }) },
  }
}

export const json = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
export function upload(text, fileName = 'study.txt', topicId) {
  const body = new FormData()
  body.append('file', new Blob([text]), fileName)
  if (topicId) body.append('topicId', topicId)
  return { method: 'POST', body }
}
export async function waitJob(request, id) {
  for (let i = 0; i < 300; i++) {
    const job = await (await request(`/api/imports/${id}`)).json()
    if (!['queued', 'running'].includes(job.status)) return job
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error('Import did not finish')
}
