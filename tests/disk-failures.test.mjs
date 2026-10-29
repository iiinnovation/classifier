import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { diskFaultGroups } from './helpers/disk-fault-cases.mjs'

const scenarios = Object.values(diskFaultGroups).flat()
for (const scenario of scenarios) test(`D1 disk failure preserves data and permits recovery: ${scenario}`, { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'classifier-disk-fault-'))
  const child = fork(new URL('./helpers/disk-fault-child.mjs', import.meta.url), [root, scenario], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes })
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit') }; await rm(root, { recursive: true, force: true }) })
  const [code, signal] = await once(child, 'exit')
  assert.equal(code, 0, stderr); assert.equal(signal, null)
  const result = JSON.parse(await readFile(join(root, 'result.json'), 'utf8'))
  assert.equal(result.scenario, scenario); assert.equal(result.passed, true); assert.ok(result.reached)
})
