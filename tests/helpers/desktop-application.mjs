import { test as base, expect, _electron as electron } from '@playwright/test'
import electronExecutable from 'electron'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { processTree, processSnapshot } from '../../tools/process-metrics.mjs'

export { expect }
export const test = base.extend({
  desktop: async ({}, use, testInfo) => {
    const profile = await mkdtemp(join(tmpdir(), 'classifier-lifecycle-'))
    const executable = process.env.CLASSIFIER_PACKAGED_EXECUTABLE || electronExecutable
    const args = [...(process.env.CLASSIFIER_PACKAGED_EXECUTABLE ? [] : [resolve('.')]), `--user-data-dir=${profile}`]
    const env = { ...process.env, PATH: process.platform === 'win32' ? join(process.env.SystemRoot, 'System32') : '/usr/bin:/bin' }
    const observed = new Map()
    let application
    async function snapshot() {
      const tree = await processTree(application.process().pid)
      for (const item of tree) observed.set(item.pid, item.name)
      return tree
    }
    const remaining = async () => (await processSnapshot()).filter(item => observed.get(item.pid) === item.name)
    try {
      application = await electron.launch({ executablePath: executable, args, env, acceptDownloads: true, timeout: 45000 })
      const page = await application.firstWindow()
      await expect(page.locator('#new-topic')).toBeVisible()
      await snapshot()
      const runtime = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, versions: process.versions, platform: process.platform, arch: process.arch }))
      await writeFile(testInfo.outputPath('desktop-runtime.json'), JSON.stringify(runtime, null, 2) + '\n')
      await testInfo.attach('desktop-runtime', { body: JSON.stringify(runtime, null, 2), contentType: 'application/json' })
      await use({ application, page, profile, executable, args, env, snapshot, remaining })
    } finally {
      await application?.close().catch(() => {})
      try {
        await expect.poll(remaining, { timeout: 15000, message: 'All observed application processes must exit' }).toEqual([])
      } finally {
        // Failure cleanup only: keep a failed no-orphan assertion visible.
        for (const item of await remaining()) { try { process.kill(item.pid, 'SIGKILL') } catch {} }
        await rm(profile, { recursive: true, force: true })
      }
    }
  },
})
