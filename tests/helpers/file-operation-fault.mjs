import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import assert from 'node:assert/strict'

const [directory, id, fault] = process.argv.slice(2), rename = fs.rename
// Fault the real journal publication, after its replacement bytes are written
// and synced but before the old pending record can be replaced.
fs.rename = async (source, target) => {
  if (target.includes('.file-operations') && target.endsWith('.json')) {
    const operation = JSON.parse(await fs.readFile(source, 'utf8'))
    if (operation.state === 'done') {
      if (fault === 'crash') process.kill(process.pid, 'SIGKILL')
      throw Object.assign(new Error('injected publication failure'), { code: 'EIO' })
    }
  }
  return rename(source, target)
}
syncBuiltinESMExports()
const { createStore } = await import('../../apps/api/src/store.mjs')
const store = await createStore(directory)
await assert.rejects(store.saveOriginal(id, Buffer.from('crash boundary original')), { code: 'EIO' })
