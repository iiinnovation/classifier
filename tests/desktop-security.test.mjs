import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { request } from 'node:http'
import { testApp } from './helpers/test-app.mjs'
import { desktopOrigin, instanceHeader } from '../apps/api/src/desktop-security.mjs'

test('desktop API requires instance authentication, exact host and desktop origin on every route', async t => {
  const token = randomBytes(32).toString('hex'), app = await testApp({ desktopToken: token })
  t.after(() => app.close())
  assert.equal((await app.request('/health')).status, 401)
  assert.equal((await app.request('/app.js')).status, 401)
  assert.equal((await app.request('/api/documents', { headers: { [instanceHeader]: 'wrong', origin: desktopOrigin } })).status, 401)
  const headers = { [instanceHeader]: token, origin: desktopOrigin }
  assert.equal((await app.request('/health', { headers })).status, 200)
  assert.equal((await app.request('/health', { headers: { ...headers, origin: 'null' } })).status, 403)
  assert.equal((await app.request('/health', { headers: { ...headers, origin: 'https://example.invalid' } })).status, 403)
  const wrongHostStatus = await new Promise((resolve, reject) => {
    const req = request(`${app.base}/health`, { headers: { ...headers, host: 'example.invalid' } }, response => { response.resume(); resolve(response.statusCode) })
    req.on('error', reject); req.end()
  })
  assert.equal(wrongHostStatus, 403)
  const content = await (await app.request('/app.js', { headers })).text()
  assert.ok(!content.includes(token))
  const second = await testApp({ desktopToken: randomBytes(32).toString('hex') }); t.after(() => second.close())
  assert.equal((await second.request('/health', { headers })).status, 401)
})
