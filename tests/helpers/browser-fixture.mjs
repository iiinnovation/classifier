import { test as browserTest, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { desktopBackendFor } from './test-app.mjs'
import { desktopOrigin, instanceHeader } from '../../apps/api/src/desktop-security.mjs'
import { createDesktopRouting } from './desktop-routing.mjs'

export { expect }
const primaryPage = Symbol('primary page')
export const test = process.env.CLASSIFIER_E2E_TRANSPORT !== 'electron' ? browserTest : browserTest.extend({
  context: async ({}, use, testInfo) => {
    const profile = await mkdtemp(join(tmpdir(), 'classifier-electron-e2e-'))
    let application, routing
    try {
      routing = await createDesktopRouting()
      application = await electron.launch({ args: [fileURLToPath(new URL('./electron-main.mjs', import.meta.url)), profile], acceptDownloads: true, timeout: 45000 })
      const context = application.context()
      function prepare(page, id) {
        const goto = page.goto.bind(page), initialized = routing.install(page, id)
        page.goto = async (url, options) => {
          await initialized
          const requested = new URL(url), backend = desktopBackendFor(requested.origin)
          if (!backend) throw new Error(`No isolated test backend registered for ${requested.origin}`)
          await application.evaluate((_electron, value) => globalThis.classifierTest.configure(value), { ...backend, control: routing.connection })
          return goto(`${desktopOrigin}${requested.pathname}${requested.search}`, options)
        }
        return page
      }
      context[primaryPage] = prepare(await application.firstWindow(), 'primary')
      context.newPage = async () => {
        const created = application.waitForEvent('window')
        const id = randomUUID()
        await application.evaluate((_electron, id) => { globalThis.classifierTest.createWindow(id) }, id)
        return prepare(await created, id)
      }
      await use(context)
    } finally {
      if (application && testInfo.status !== testInfo.expectedStatus) {
        const downloads = await application.evaluate(() => globalThis.classifierTest?.downloads || []).catch(() => [])
        await testInfo.attach('electron-downloads', { body: JSON.stringify(downloads), contentType: 'application/json' })
      }
      await application?.close(); await routing?.close(); await rm(profile, { recursive: true, force: true })
    }
  },
  page: async ({ context }, use) => { await use(context[primaryPage]) },
})

export async function readSessionDraft(page, key) {
  return page.evaluate(key => {
    const desktop = globalThis.classifierDesktop
    return desktop ? localStorage.getItem(`classifier-desktop-session:v1:${desktop.sessionId}:${key}`) : sessionStorage.getItem(key)
  }, key)
}
