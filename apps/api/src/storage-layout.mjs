import { readFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'

export const recordBuckets = ['documents', 'runs', 'imports', 'topics', 'notes', 'comparisons', 'reports']
export const storageManifestName = 'library-manifest.json'
export async function storageLayout(root) {
  let manifest
  try {
    const entry = await lstat(join(root, storageManifestName))
    if (!entry.isFile() || entry.size > 64 * 1024) throw new Error('Invalid library manifest path or size')
    manifest = JSON.parse(await readFile(join(root, storageManifestName), 'utf8'))
  }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('资料库版本清单损坏，已停止写入。', { cause: error })
    try { await lstat(join(root, 'library.sqlite')) }
    catch (missing) { if (missing.code === 'ENOENT') return { formatVersion: 0, storage: 'json' }; throw missing }
    throw new Error('资料库数据库存在但版本清单缺失，请恢复备份或完成迁移。')
  }
  if (manifest?.formatVersion !== 1 || manifest.storage !== 'sqlite' || manifest.state !== 'ready' || (manifest.recordVersion ?? 1) !== 1) {
    throw new Error('资料库格式不受支持或迁移尚未完成，请使用兼容版本或从备份恢复到新目录。')
  }
  return manifest
}
