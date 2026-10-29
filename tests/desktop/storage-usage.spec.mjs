import { clickControl, revealControl, moreAction } from '../helpers/ui-actions.mjs'
import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createStore } from '../../apps/api/src/store.mjs'
import { migrateLibrary } from '../../apps/api/src/storage-maintenance.mjs'

for (const storage of ['json', 'sqlite']) test(`D2 ${storage} real desktop backend measures profile backups separately from the selected library`, async ({}, testInfo) => {
  const profile = await mkdtemp(join(tmpdir(), 'classifier-desktop-usage-'))
  let application
  try {
    const source = join(profile, storage === 'json' ? 'data' : 'legacy'), store = await createStore(source)
    const document = { id: randomUUID(), createdAt: new Date().toISOString(), title: '桌面用量样本', sections: [], references: [] }
    await store.write('documents', document); await store.saveOriginal(document.id, Buffer.from('desktop original'))
    if (storage === 'sqlite') await migrateLibrary(source, join(profile, 'data'), join(profile, 'migration-backup'))
    const backups = join(profile, 'library-backups'); await mkdir(backups); await writeFile(join(backups, 'preserved.bin'), Buffer.alloc(4096, 7))
    application = await electron.launch({ ...(process.env.CLASSIFIER_PACKAGED_EXECUTABLE ? { executablePath: process.env.CLASSIFIER_PACKAGED_EXECUTABLE } : {}), args: [...(process.env.CLASSIFIER_PACKAGED_EXECUTABLE ? [] : [resolve('.')]), `--user-data-dir=${profile}`], timeout: 45000 })
    const page = await application.firstWindow(), errors = []; page.on('pageerror', error => errors.push(error.message))
    await clickControl(page, '#storage-usage-open')
    const dialog = page.locator('#storage-usage-dialog')
    await expect(dialog).toContainText('本次扫描完成')
    const value = await page.evaluate(async () => (await fetch('/api/storage-usage')).json())
    expect(value.storage).toBe(storage); expect(value.records.count).toBe(1); expect(value.complete).toBe(true)
    expect(value.managedBackups.available).toBe(true); expect(value.managedBackups.bytes).toBe(4096)
    expect(value.library.categories.find(group => group.id === 'originals').bytes).toBe(Buffer.byteLength('desktop original'))
    await expect(dialog.locator('p').filter({ hasText: /^自动备份与保全副本：/ })).toContainText('4.0 KiB')
    await page.screenshot({ path: testInfo.outputPath('desktop-storage-usage.png'), fullPage: true })
    expect(await readFile(join(backups, 'preserved.bin'))).toEqual(Buffer.alloc(4096, 7))
    expect(errors).toEqual([])
  } finally { await application?.close(); await rm(profile, { recursive: true, force: true }) }
})
