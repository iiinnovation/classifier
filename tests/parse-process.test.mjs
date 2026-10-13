import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { textPdf } from './helpers/pdf-fixture.mjs'

test('isolated parser flushes a large document result before exiting', async t => {
  const child = fork(fileURLToPath(new URL('../apps/api/src/parse-process.mjs', import.meta.url)), [], { execArgv: [], serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  t.after(() => { if (child.exitCode === null) child.kill() })
  let result, failure
  child.on('message', message => {
    if (message.type === 'result') result = message.parsed
    if (message.type === 'error') failure = message.error
  })
  const exited = once(child, 'exit')
  child.send({ type: 'start', workerData: { fileName: 'fifty-pages.pdf', contentType: 'application/pdf', bytes: textPdf(50) } })
  assert.deepEqual(await exited, [0, null])
  assert.equal(failure, undefined)
  assert.equal(result.sections.length, 50)
  assert.match(result.sections[49].text, /Research page 50 line 48/)
  assert.ok(result.markdown.length > 150000)
})
