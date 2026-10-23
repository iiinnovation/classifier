import { readFile, writeFile, rename, mkdir, open, lstat, realpath, unlink, readdir } from 'node:fs/promises'
import { join, resolve, isAbsolute } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { recordBuckets } from '../api/src/storage-layout.mjs'

const selectionName = 'library-selection.json'
export async function selectedLibrary(profile) {
  let value
  try { value = JSON.parse(await readFile(join(profile, selectionName), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return join(profile, 'data'); throw new Error('资料库位置记录无法读取，未改用空资料库。', { cause: error }) }
  if (value?.version !== 1 || typeof value.path !== 'string' || !isAbsolute(value.path)) throw new Error('资料库位置记录无效，未改用空资料库。')
  if (!(await lstat(value.path)).isDirectory()) throw new Error('所选资料库目录不可用，请恢复该目录后重试。')
  return realpath(value.path)
}
export function libraryScope(profile, directory) {
  const canonical = path => { try { return realpathSync(path) } catch { return resolve(path) } }
  return canonical(directory) === canonical(join(profile, 'data')) ? null : createHash('sha256').update(canonical(directory)).digest('hex').slice(0, 24)
}
export async function saveLibrarySelection(profile, directory) {
  const temporary = join(profile, selectionName + '.' + randomUUID() + '.tmp')
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, path: directory }), { mode: 0o600, flag: 'wx' })
    const handle = await open(temporary, 'r')
    try { await handle.sync() } finally { await handle.close() }
    await rename(temporary, join(profile, selectionName))
  } catch (error) { await unlink(temporary).catch(() => {}); throw error }
}

// One operation owns the offline interval. The UI is disabled for this entire
// interval, and quit waits for idle() before stopping the backend again.
export function createLibraryManager({ profile, controller, run, persistSelection = saveLibrarySelection, onBusy = () => {}, onProgress = () => {} }) {
  let pending = null
  function perform(work) {
    if (pending) return Promise.reject(new Error('资料库操作正在进行，请等待完成。'))
    onBusy(true)
    pending = Promise.resolve().then(work).finally(() => { pending = null; onBusy(false) })
    return pending
  }
  async function offline(work, { keepInspection = false } = {}) {
    await controller.stop()
    let result, failure
    try { result = await work() } catch (error) { failure = error }
    try { await controller.start() }
    catch (error) {
      if (keepInspection && result && !failure) return { ...result, restartError: error.message }
      throw new Error(`${failure ? failure.message + '；' : ''}资料库服务未能重新启动：${error.message}`)
    }
    if (failure) throw failure
    return result
  }
  async function activate(target) {
    const previous = controller.dataDir
    try {
      target = await realpath(target)
      controller.dataDir = target
      await controller.start()
      await persistSelection(profile, target)
    } catch (error) {
      await controller.stop()
      controller.dataDir = previous
      try { await controller.start() }
      catch (recovery) { throw new Error(`新资料库打开失败：${error.message}；原库重启失败：${recovery.message}。两份资料均保留。`) }
      throw new Error(`新资料库打开失败，已回到原资料库：${error.message}；副本保留于 ${target}。`)
    }
  }
  async function safetyBackup() {
    const parent = join(profile, 'library-backups'); await mkdir(parent, { recursive: true, mode: 0o700 })
    return run('backup', { source: controller.dataDir, destination: join(parent, randomUUID()) })
  }
  function progress(value) { try { onProgress(value) } catch { /* UI failure must not change migration outcome. */ } }
  async function checkMigrated(target) {
    const check = await run('inspect', { source: target })
    if (check.truncated || check.issues.some(issue => issue.severity === 'error')) throw new Error(`迁移副本检查未通过，已保留于 ${target}。`)
  }
  async function restartAfterFailure(error, stage) {
    const detail = stage ? `；迁移目录保留于 ${stage}，可查看进度并继续` : ''
    try { await controller.start() }
    catch (restart) { throw new Error(`${error.message}${detail}；原库重启失败：${restart.message}`) }
    throw new Error(`${error.message}${detail}；已回到原资料库。`)
  }
  return {
    get busy() { return Boolean(pending) },
    async idle() { await pending?.catch(() => {}) },
    inspect() { return perform(() => offline(() => run('inspect', { source: controller.dataDir }), { keepInspection: true })) },
    backup(destination) { return perform(() => offline(() => run('backup', { source: controller.dataDir, destination }))) },
    migrationStatus(source) { return perform(() => run('migration-status', { source })) },
    migrate() {
      return perform(async () => {
        await controller.stop()
        let prepared, result
        try {
          progress({ phase: 'preparing' })
          const check = await run('inspect', { source: controller.dataDir })
          if (check.storage !== 'json') throw new Error('当前资料库不是旧 JSON 格式，无需升级。')
          if (check.truncated || check.issues.some(issue => issue.severity === 'error')) throw new Error('当前资料库检查未通过，请先检查并处理损坏内容。')
          const libraries = join(profile, 'libraries'), backups = join(profile, 'library-backups')
          await mkdir(libraries, { recursive: true, mode: 0o700 }); await mkdir(backups, { recursive: true, mode: 0o700 })
          prepared = await run('prepare-migration', { source: controller.dataDir, destination: join(libraries, randomUUID()), backup: join(backups, randomUUID()) })
          progress(prepared)
          result = await run('resume-migration', { source: prepared.stage }, { onProgress: progress })
          await checkMigrated(result.destination)
        } catch (error) { return restartAfterFailure(error, prepared?.stage) }
        await activate(result.destination)
        return result
      })
    },
    resumeMigration(source) {
      return perform(async () => {
        const status = await run('migration-status', { source })
        if (status.phase === 'complete' && await realpath(controller.dataDir) === await realpath(status.destination)) return { ...status, alreadyCompleted: true }
        await controller.stop()
        let result, backup
        try {
          progress({ phase: 'safety-backup' })
          // A resumed migration uses its original snapshot; back up any edits
          // made in the current library since the interruption before switching.
          backup = await safetyBackup()
          result = await run('resume-migration', { source }, { onProgress: progress })
          await checkMigrated(result.destination)
        } catch (error) { return restartAfterFailure(error, source) }
        await activate(result.destination)
        return { ...result, previousBackup: backup.destination }
      })
    },
    restore(source) {
      return perform(async () => {
        await run('verify', { source })
        await controller.stop()
        let target, backup
        try {
          backup = await safetyBackup()
          const parent = join(profile, 'libraries'); await mkdir(parent, { recursive: true, mode: 0o700 })
          target = join(parent, randomUUID())
          await run('restore', { source, destination: target })
          const check = await run('inspect', { source: target })
          if (check.truncated || check.issues.some(issue => issue.severity === 'error')) throw new Error(`恢复副本检查未通过，已保留于 ${target}。`)
        } catch (error) {
          try { await controller.start() } catch (restart) { throw new Error(`${error.message}；原库重启失败：${restart.message}`) }
          throw error
        }
        await activate(target)
        return { destination: target, previousBackup: backup.destination }
      })
    },
    switchTo(source) {
      return perform(async () => {
        if (!(await lstat(source)).isDirectory()) throw new Error('请选择实际资料库目录。')
        const target = await realpath(source)
        if (target === await realpath(controller.dataDir)) return { destination: target }
        // Do not silently turn an arbitrary empty folder into a new library.
        const entries = await readdir(target)
        if (!entries.includes('library-manifest.json') && !recordBuckets.some(bucket => entries.includes(bucket))) throw new Error('未找到已有资料库，请选择包含研究记录或版本清单的目录。')
        const check = await run('inspect', { source: target })
        if (check.truncated || check.issues.some(issue => issue.severity === 'error')) throw new Error('所选资料库检查未通过，请先检查并恢复损坏内容。')
        await controller.stop()
        let backup
        try { backup = await safetyBackup() }
        catch (error) { await controller.start(); throw error }
        await activate(target)
        return { destination: target, previousBackup: backup.destination }
      })
    },
  }
}
