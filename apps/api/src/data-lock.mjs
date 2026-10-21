import { DatabaseSync } from 'node:sqlite'
import { mkdir, realpath, lstat, open, chmod } from 'node:fs/promises'
import { join } from 'node:path'

// Keep this connection/transaction alive until every application writer stops.
// Never unlink the lock database: doing so permits two owners on separate inodes.
// SQLite releases its OS locks on process death; PID reuse and stale filenames
// therefore cannot grant or prevent ownership.
export async function acquireDataLock(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const root = await realpath(directory), path = join(root, '.classifier-lock.sqlite')
  try { const file = await open(path, 'wx', 0o600); await file.close() }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('数据目录锁文件类型无效，未打开资料库。')
  await chmod(path, 0o600)
  let db
  try {
    db = new DatabaseSync(path)
    db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;')
    // Creating a page inside the held transaction also exercises recovery of
    // an abandoned journal without committing any business data.
    db.exec('CREATE TABLE IF NOT EXISTS ownership(singleton INTEGER PRIMARY KEY CHECK(singleton=1)); INSERT OR IGNORE INTO ownership VALUES(1);')
  } catch (error) {
    db?.close()
    if (error.errcode === 5 || error.errcode === 6 || /database is locked|database table is locked/i.test(error.message)) {
      const locked = new Error('资料库正在被另一个进程使用，请关闭该进程后重试。', { cause: error })
      locked.code = 'DATA_DIRECTORY_LOCKED'
      throw locked
    }
    throw error
  }
  let released = false
  return { root, release() { if (released) return; released = true; try { db.exec('ROLLBACK') } finally { db.close() } } }
}
