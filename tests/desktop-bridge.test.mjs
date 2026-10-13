import test from 'node:test'
import assert from 'node:assert/strict'
import { createProtocolBridge, isApplicationUrl } from '../apps/desktop/bridge.mjs'
import { instanceHeader } from '../apps/api/src/desktop-security.mjs'

test('desktop bridge injects its private token and preserves JSON, uploads and binary downloads', async () => {
  const calls = [], token = 'test-instance-private-token'
  const bridge = createProtocolBridge({ backend: () => ({ port: 32123, token }), fetchImpl: async (url, options) => {
    calls.push({ url, options })
    return new Response(new Uint8Array([0, 255, 42]), { headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename=test.bin', [instanceHeader]: token } })
  } })
  const response = await bridge(new Request('app://classifier/api/documents?topic=test', { method: 'POST', headers: { 'content-type': 'application/json', [instanceHeader]: 'forged' }, body: '{"title":"study"}' }))
  assert.equal(calls[0].url, 'http://127.0.0.1:32123/api/documents?topic=test')
  assert.equal(calls[0].options.headers[instanceHeader], token)
  assert.equal(calls[0].options.headers.origin, 'app://classifier')
  assert.equal(calls[0].options.body.toString(), '{"title":"study"}')
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0, 255, 42])
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename=test.bin')
  assert.equal(response.headers.get(instanceHeader), null)
})

test('desktop bridge refuses arbitrary destinations, origins and redirects, and reports disconnection', async () => {
  let calls = 0
  const bridge = createProtocolBridge({ backend: () => ({ port: 32123, token: 'private' }), fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://example.invalid' } }) } })
  for (const url of ['app://foreign/api/documents', 'https://example.invalid/api/documents', 'app://classifier:9000/api/documents']) assert.equal((await bridge(new Request(url))).status, 403)
  assert.equal(isApplicationUrl('app://user@classifier/api/documents'), false)
  assert.equal((await bridge(new Request('app://classifier/api/documents', { headers: { origin: 'null' } }))).status, 403)
  assert.equal(calls, 0)
  assert.equal((await bridge(new Request('app://classifier/api/documents'))).status, 502)
  const unavailable = createProtocolBridge({ backend: () => null })
  assert.equal((await unavailable(new Request('app://classifier/api/documents'))).status, 503)
})
