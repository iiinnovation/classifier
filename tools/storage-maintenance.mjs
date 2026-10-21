import { backupLibrary, restoreLibrary, migrateLibrary, verifyBackup, prepareMigration, resumeMigration, migrationStatus } from '../apps/api/src/storage-maintenance.mjs'
const [command, source, destination, backup] = process.argv.slice(2)
try {
  if (!source || !['backup', 'verify', 'restore', 'migrate', 'prepare-migration', 'resume-migration', 'migration-status'].includes(command) || (['backup', 'restore', 'migrate', 'prepare-migration'].includes(command) && !destination) || (['migrate', 'prepare-migration'].includes(command) && !backup)) throw new Error('用法：node tools/storage-maintenance.mjs backup|restore <来源目录> <新目标目录>；verify <备份目录>；migrate|prepare-migration <旧JSON目录> <新SQLite目录> <新备份目录>；resume-migration|migration-status <迁移目录>。应用必须先退出。')
  const onProgress = progress => { console.error(JSON.stringify({ event: 'migration-progress', ...progress })) }
  const result = command === 'backup' ? await backupLibrary(source, destination)
    : command === 'restore' ? await restoreLibrary(source, destination)
    : command === 'migrate' ? await migrateLibrary(source, destination, backup, { onProgress })
    : command === 'prepare-migration' ? await prepareMigration(source, destination, backup)
    : command === 'resume-migration' ? await resumeMigration(source, { onProgress })
    : command === 'migration-status' ? await migrationStatus(source)
    : await verifyBackup(source)
  console.log(JSON.stringify(result, null, 2))
} catch (error) { console.error(error.message); process.exitCode = 1 }
