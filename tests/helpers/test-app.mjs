import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createApp } from '../../apps/api/src/server.mjs'

export async function testApp(options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'classifier-m1-'))
  const original = '既有文献：研究者比较了两组材料，具体条件需结合原文核对。'
  const legacy = { id: randomUUID(), title: '既有研究资料', fileName: 'legacy.txt', mediaType: 'text/plain', createdAt: '2026-09-23T00:00:00.000Z', warnings: [], sections: [{ title: '原文', text: original }], references: [{ id: 'ref_00001', title: '原文第 1 段', text: original }] }
  await mkdir(join(dataDir, 'documents'), { recursive: true })
  await mkdir(join(dataDir, 'originals'), { recursive: true })
  await writeFile(join(dataDir, 'documents', `${legacy.id}.json`), JSON.stringify(legacy))
  await writeFile(join(dataDir, 'originals', legacy.id), original)
  delete process.env.CLASSIFIER_MODEL_API_URL
  delete process.env.CLASSIFIER_MODEL_API_KEY
  let server, port = 0
  async function start() {
    server = await createApp({ ...options, dataDir })
    server.listen(port, '127.0.0.1')
    await once(server, 'listening')
    port = server.address().port
  }
  async function stop() {
    if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
  }
  await start()
  const base = `http://127.0.0.1:${port}`
  return { base, dataDir, legacy, original,
    request: (path, options) => fetch(base + path, options),
    async restart() { await stop(); await start() },
    async close() { await stop(); await rm(dataDir, { recursive: true, force: true }) },
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
