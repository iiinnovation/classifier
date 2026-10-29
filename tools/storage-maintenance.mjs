import { backupLibrary, restoreLibrary, migrateLibrary, verifyBackup, prepareMigration, prepareMigrationFromBackup, resumeMigration, migrationStatus } from '../apps/api/src/storage-maintenance.mjs'
import { inspectLibrary } from '../apps/api/src/library-inspection.mjs'
import { backupZipLibrary, verifyZipBackup, restoreZipLibrary } from '../apps/api/src/storage-zip.mjs'
import { preserveLibrary, previewLibraryRecovery, recoverLibrary } from '../apps/api/src/library-recovery.mjs'
import { lstat, readFile } from 'node:fs/promises'
const [command, source, destination, backup, preservation, selectionFile] = process.argv.slice(2)
try {
  if (!source || !['inspect', 'backup', 'verify', 'restore', 'backup-zip', 'verify-zip', 'restore-zip', 'preserve', 'recovery-preview', 'recover', 'migrate', 'prepare-migration', 'prepare-from-backup', 'resume-migration', 'migration-status'].includes(command) || (['backup', 'restore', 'backup-zip', 'restore-zip', 'preserve', 'recovery-preview', 'recover', 'migrate', 'prepare-migration', 'prepare-from-backup'].includes(command) && !destination) || (['migrate', 'prepare-migration', 'recover'].includes(command) && !backup) || command === 'recover' && (!preservation || !selectionFile)) throw new Error('用法：node tools/storage-maintenance.mjs inspect <资料库目录>；backup|restore|preserve <来源目录> <新目标目录>；verify <备份目录>；backup-zip <资料库目录> <新ZIP文件>；verify-zip <ZIP文件>；restore-zip <ZIP文件> <新目标目录>；recovery-preview <资料库> <备份> [directory|zip]；recover <资料库> <备份> <新目标目录> <新保全目录> <选择JSON文件>；migrate|prepare-migration <旧JSON目录> <新SQLite目录> <新备份目录>；prepare-from-backup <升级前JSON目录备份> <新SQLite目录>；resume-migration|migration-status <迁移目录>。应用必须先退出。')
  let selection
  if (command === 'recover') {
    const entry = await lstat(selectionFile)
    if (!entry.isFile() || entry.size > 1024 * 1024) throw new Error('恢复选择清单无效或过大。')
    selection = JSON.parse(await readFile(selectionFile, 'utf8'))
  }
  const onProgress = progress => { console.error(JSON.stringify({ event: 'migration-progress', ...progress })) }
  const result = command === 'inspect' ? await inspectLibrary(source)
    : command === 'preserve' ? await preserveLibrary(source, destination)
    : command === 'recovery-preview' ? await previewLibraryRecovery(source, destination, { format: backup || 'directory' })
    : command === 'recover' ? await recoverLibrary(source, destination, backup, preservation, { format: selection.format, revision: selection.revision, selections: selection.selections })
    : command === 'backup-zip' ? await backupZipLibrary(source, destination, { onProgress })
    : command === 'verify-zip' ? await verifyZipBackup(source, { onProgress })
    : command === 'restore-zip' ? await restoreZipLibrary(source, destination, { onProgress })
    : command === 'backup' ? await backupLibrary(source, destination)
    : command === 'restore' ? await restoreLibrary(source, destination)
    : command === 'migrate' ? await migrateLibrary(source, destination, backup, { onProgress })
    : command === 'prepare-migration' ? await prepareMigration(source, destination, backup, { onProgress })
    : command === 'prepare-from-backup' ? await prepareMigrationFromBackup(source, destination, { onProgress })
    : command === 'resume-migration' ? await resumeMigration(source, { onProgress })
    : command === 'migration-status' ? await migrationStatus(source)
    : await verifyBackup(source)
  console.log(JSON.stringify(result, null, 2))
  if (command === 'inspect' && result.issueCount > 0 && (result.truncated || result.issues.some(issue => issue.severity === 'error'))) process.exitCode = 2
} catch (error) { console.error(error.message); process.exitCode = 1 }
