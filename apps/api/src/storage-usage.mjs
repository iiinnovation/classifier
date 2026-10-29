import { lstat, opendir, open, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { recordBuckets, storageLayout } from './storage-layout.mjs'
import { decodeRecord, recordSizeLimit } from './record-integrity.mjs'

const labels = { originals: '原文件', records: 'JSON 记录与历史', database: '数据库与辅助文件', quarantine: '隔离副本', operations: '文件操作与迁移记录', other: '其他文件' }
const bytes = value => Buffer.byteLength(JSON.stringify(value))
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
const inside = (parent, child) => { const path = relative(parent, child); return !path || path !== '..' && !path.startsWith('..' + sep) && !path.startsWith(sep) }
const category = path => {
  const first = path.split(sep)[0]
  if (first === 'originals' || first === 'quarantine') return first
  if (recordBuckets.includes(first)) return 'records'
  if (/^library\.sqlite(?:-(?:wal|shm|journal))?$/.test(first)) return 'database'
  if (['.file-operations', 'migration-work', 'migration-state.json', 'library-manifest.json'].includes(first)) return 'operations'
  return 'other'
}

// Sizes are logical file lengths, not allocated blocks or reclaimable space.
// Only trusted application configuration supplies roots; HTTP accepts no paths.
export async function storageUsage(root, { managedBackupDir, inspectRecordBodies, limits = {} } = {}) {
  const startedAt = new Date().toISOString(), started = Date.now()
  const bound = { entries: 200000, recordBytes: 256 * 1024 ** 2, milliseconds: 15000, ...limits }
  let entries = 0, parsedBytes = 0, issueCount = 0, stopped = false
  const issues = [], recordSummary = { complete: true, count: 0, archived: 0, historyVersions: 0, currentBytes: 0, historyBytes: 0, byBucket: Object.fromEntries(recordBuckets.map(bucket => [bucket, 0])) }
  function issue(scope, code, path = '') { issueCount++; if (issues.length < 20) issues.push({ scope, code, path }) }
  function budget() {
    if (stopped) return false
    if (++entries > bound.entries || Date.now() - started > bound.milliseconds) { stopped = true; issue('all', 'SCAN_LIMIT'); return false }
    return true
  }
  function record(bucket, id, raw) {
    try {
      const size = Buffer.byteLength(raw)
      if (parsedBytes + size > bound.recordBytes) { if (recordSummary.complete) issue('records', 'RECORD_SCAN_LIMIT'); recordSummary.complete = false; return }
      parsedBytes += size
      const value = decodeRecord(bucket, id, raw), { history, ...current } = value
      recordSummary.count++; recordSummary.byBucket[bucket]++
      if (value.archived === true) recordSummary.archived++
      recordSummary.currentBytes += bytes(current)
      for (const version of Array.isArray(history) ? history : []) { recordSummary.historyVersions++; recordSummary.historyBytes += bytes(version) }
    } catch { recordSummary.complete = false; issue('records', 'RECORD_UNREADABLE', bucket + '/' + id) }
  }
  const canonical = await realpath(root), layout = await storageLayout(canonical)
  async function scan(directory, scope, optional = false) {
    const result = { available: true, complete: true, files: 0, bytes: 0, categories: Object.entries(labels).map(([id, label]) => ({ id, label, files: 0, bytes: 0 })) }
    const groups = Object.fromEntries(result.categories.map(item => [item.id, item])), initialIssues = issueCount
    async function walk(path, depth) {
      if (!budget()) return
      let before
      try {
        before = await lstat(path)
        if (before.isSymbolicLink()) { issue(scope, 'SYMLINK_SKIPPED', relative(directory, path)); return }
        if (before.isFile()) {
          if (await realpath(dirname(path)) !== dirname(path)) { issue(scope, 'PATH_CHANGED', relative(directory, path)); return }
          const local = relative(directory, path), group = groups[category(local)]
          result.files++; result.bytes += before.size; group.files++; group.bytes += before.size
          const parts = local.split(sep)
          if (scope === 'library' && layout.storage === 'json' && parts.length === 2 && recordBuckets.includes(parts[0]) && parts[1].endsWith('.json')) {
            if (before.size > recordSizeLimit || parsedBytes + before.size > bound.recordBytes) { recordSummary.complete = false; issue('records', 'RECORD_SCAN_LIMIT', local); return }
            const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
            try {
              if (!same(before, await handle.stat())) { recordSummary.complete = false; issue(scope, 'PATH_CHANGED', local); return }
              record(parts[0], parts[1].slice(0, -5), await handle.readFile())
              if (!same(before, await handle.stat())) { recordSummary.complete = false; issue(scope, 'FILE_CHANGED', local) }
            } finally { await handle.close() }
          }
          return
        }
        if (!before.isDirectory()) { issue(scope, 'SPECIAL_FILE_SKIPPED', relative(directory, path)); return }
        if (depth > 64) { issue(scope, 'DEPTH_LIMIT', relative(directory, path)); return }
        if (await realpath(path) !== path) { issue(scope, 'PATH_CHANGED', relative(directory, path)); return }
        const handle = await opendir(path)
        for await (const entry of handle) { if (stopped) break; await walk(join(path, entry.name), depth + 1) }
        if (!same(before, await lstat(path))) issue(scope, 'DIRECTORY_CHANGED', relative(directory, path))
      } catch (error) {
        if (optional && path === directory && error.code === 'ENOENT') return
        issue(scope, error.code === 'ENOENT' ? 'FILE_CHANGED' : 'READ_FAILED', relative(directory, path))
        if (scope === 'library') recordSummary.complete = false
      }
    }
    await walk(directory, 0)
    result.complete = !stopped && issueCount === initialIssues
    return result
  }
  const library = await scan(canonical, 'library')
  if (layout.storage === 'sqlite') {
    try {
      // Even a fresh read-only WAL connection can create sidecar files. Use the
      // already owned store connection, with a synchronous read-only visitor.
      if (!inspectRecordBodies) throw new Error('Owned record reader unavailable')
      inspectRecordBodies(row => { if (!budget()) { recordSummary.complete = false; return false }; record(row.bucket, row.id, row.body); return true })
    } catch { recordSummary.complete = false; issue('records', 'DATABASE_UNREADABLE') }
  }
  let managedBackups = { available: false, complete: false, files: null, bytes: null }
  if (managedBackupDir) {
    // Managed backups belong to the profile, including other library selections.
    // Never count a nested or enclosing library twice as a separate total.
    let directory = managedBackupDir
    try { directory = await realpath(dirname(directory)) + sep + directory.split(sep).at(-1) }
    catch { issue('managedBackups', 'READ_FAILED') }
    if (inside(canonical, directory) || inside(directory, canonical)) issue('managedBackups', 'OVERLAPPING_SCOPE')
    else managedBackups = await scan(directory, 'managedBackups', true)
  }
  if (stopped || !library.complete) recordSummary.complete = false
  return {
    usageVersion: 1, readOnly: true, startedAt, finishedAt: new Date().toISOString(), storage: layout.storage,
    complete: !issueCount, library, managedBackups, records: recordSummary,
    issueCount, issues, issuesTruncated: issueCount > issues.length,
    unmeasured: ['用户另存的目录／ZIP 备份、导出文件和其他资料库', '浏览器／桌面草稿与缓存、系统日志和崩溃报告；独立诊断存储尚未实现'],
    notices: [
      '文件大小按读取时各文件的字节长度累计；不等于磁盘实际分配空间或可释放空间，硬链接按路径重复计数。',
      '这是扫描期间的用量快照；导入、编辑和任务写入可能使数值变化，请在任务结束后刷新。',
      '记录正文与历史按有效内容重新序列化后的 UTF-8 字节估算，不含格式空白和数据库开销；它们已包含在文件统计中，不应再次相加。',
      '归档只改变展示状态，不删除原文件、记录或历史，不释放空间。当前没有清理或删除执行入口。',
      '备份、隔离副本、历史和已导出材料可能保留同一内容；普通删除不代表彻底清除。',
    ],
  }
}
