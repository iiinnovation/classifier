import { inspectLibrary } from '../api/src/library-inspection.mjs'
import { backupLibrary, verifyBackup, restoreLibrary, prepareMigration, resumeMigration, migrationStatus } from '../api/src/storage-maintenance.mjs'

// Shared by the utility worker and Node integration tests. Keep large manifests
// inside the worker; only presentation fields cross the process boundary.
export async function executeMaintenance(command, { source, destination, backup }, { onProgress = async () => {} } = {}) {
  switch (command) {
    case 'inspect': return inspectLibrary(source)
    case 'backup': {
      const result = await backupLibrary(source, destination)
      return { destination: result.destination, files: result.manifest.files.length }
    }
    case 'verify': {
      const result = await verifyBackup(source)
      return { storage: result.storage, createdAt: result.createdAt }
    }
    case 'restore': return restoreLibrary(source, destination)
    case 'prepare-migration': return prepareMigration(source, destination, backup)
    case 'resume-migration': return resumeMigration(source, { onProgress })
    case 'migration-status': return migrationStatus(source)
    default: throw new Error('未知资料库操作。')
  }
}
