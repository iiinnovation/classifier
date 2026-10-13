import test from 'node:test'
import assert from 'node:assert/strict'
import { createApi } from '../apps/web/api.js'

test('API client distinguishes business, non-JSON, empty and malformed responses', async () => {
  const cases = [
    [new Response('<html>proxy failure</html>', { status: 503, headers: { 'content-type': 'text/html' } }), 'UNAVAILABLE', 503],
    [new Response('', { status: 200 }), 'INVALID_RESPONSE', 200],
    [new Response('{broken', { headers: { 'content-type': 'application/json' } }), 'INVALID_RESPONSE', 200],
    [new Response(JSON.stringify({ error: '版本已变化' }), { status: 409, headers: { 'content-type': 'application/json' } }), 'CONFLICT', 409],
  ]
  for (const [response, code, status] of cases) {
    const api = createApi({ fetchImpl: async () => response })
    await assert.rejects(api('/api/test'), error => error.code === code && error.status === status && !/Unexpected token|<html>/.test(error.message))
  }
  assert.equal(await createApi({ fetchImpl: async () => new Response(null, { status: 204 }) })('/api/test'), null)
  assert.deepEqual(await createApi({ fetchImpl: async () => new Response('{"saved":true}', { headers: { 'content-type': 'application/json' } }) })('/api/test'), { saved: true })
})

test('API client distinguishes cancellation and timeout and never retries uncertain writes', async () => {
  let calls = 0
  const api = createApi({ fetchImpl: async () => { calls++; throw new TypeError('fetch failed') } })
  await assert.rejects(api('/api/test', { method: 'POST' }), error => error.code === 'UNAVAILABLE' && error.uncertain && !error.retryable && /提交结果尚未确认/.test(error.message))
  assert.equal(calls, 1)
  await assert.rejects(api('/api/test'), error => error.code === 'UNAVAILABLE' && error.retryable)
  const pending = createApi({ timeoutMs: 5, fetchImpl: (_path, { signal }) => new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }) })
  await assert.rejects(pending('/api/test'), error => error.code === 'TIMEOUT')
  const controller = new AbortController(); controller.abort()
  await assert.rejects(pending('/api/test', { signal: controller.signal }), error => error.code === 'CANCELLED')
})
