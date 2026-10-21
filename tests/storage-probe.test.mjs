import test from 'node:test'
import { fork } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { storageScenarios } from './helpers/storage-scenarios.mjs'

test('S0 SQLite survives crash boundaries, disk errors, contention and consistent backup restore', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'classifier-s0-node-')), children = new Map()
  t.after(async () => { for (const child of children.values()) child.kill('SIGKILL'); await rm(root, { recursive: true, force: true }) })
  async function run(folder, action, { checkpoint = '', hold = false } = {}) {
    const child = fork(new URL('./helpers/storage-probe.mjs', import.meta.url), [folder, action, checkpoint], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    children.set(child.pid, child)
    return new Promise((resolve, reject) => {
      let response, error = ''
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('S0 probe timed out')) }, 10000)
      child.stderr.on('data', data => { error += data })
      child.on('error', reject)
      child.on('message', message => {
        if (message.type === 'checkpoint') {
          response = { checkpoint: message.stage, killed: !hold, handle: child.pid }
          if (hold) { clearTimeout(timer); resolve(response) } else child.kill('SIGKILL')
        } else response = message
      })
      child.once('close', (code, signal) => {
        clearTimeout(timer); children.delete(child.pid)
        if (response?.type === 'error') reject(new Error(response.message))
        else if (response?.killed && signal === 'SIGKILL') resolve(response)
        else if (code === 0 && response?.type === 'result') resolve(response)
        else reject(new Error('S0 probe exited unexpectedly: ' + code + '/' + signal + ' ' + error))
      })
    })
  }
  async function stop(pid) {
    const child = children.get(pid)
    if (child) await new Promise(resolve => { child.once('close', resolve); child.kill('SIGKILL') })
  }
  await storageScenarios(root, run, stop)
})
