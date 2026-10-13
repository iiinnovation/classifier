import test from 'node:test'
import assert from 'node:assert/strict'
import { createClientStorage } from '../apps/web/storage.js'

function memoryStorage() {
  const values = {}
  const methods = { getItem: key => values[key] ?? null, setItem: (key, value) => { values[key] = String(value) }, removeItem: key => { delete values[key] } }
  return new Proxy({}, { ownKeys: () => Object.keys(values), getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }), get: (_target, key) => methods[key] || values[key] })
}
test('desktop drafts persist across sessions while different windows remain isolated', () => {
  const persistent = memoryStorage(), session = memoryStorage()
  const first = createClientStorage({ persistent, session, desktop: { sessionId: 'primary' } })
  first.drafts.setItem('classifier-comparison-draft:topic:table:cell', 'first edit')
  const other = createClientStorage({ persistent, session: memoryStorage(), desktop: { sessionId: 'secondary' } })
  assert.deepEqual(Object.keys(other.drafts), [])
  other.drafts.setItem('classifier-comparison-draft:topic:table:cell', 'other edit')
  const restored = createClientStorage({ persistent, session: memoryStorage(), desktop: { sessionId: 'primary' } })
  assert.equal(restored.ownerId, first.ownerId)
  assert.equal(restored.drafts.getItem('classifier-comparison-draft:topic:table:cell'), 'first edit')
  assert.equal(restored.drafts.length, 1)
  restored.drafts.clear()
  assert.equal(other.drafts.getItem('classifier-comparison-draft:topic:table:cell'), 'other edit')
  assert.equal(createClientStorage({ persistent, session }).drafts, session)
})
