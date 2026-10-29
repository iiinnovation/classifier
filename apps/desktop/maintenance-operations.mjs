import { inspectLibrary } from '../api/src/library-inspection.mjs'
import { backupLibrary, verifyBackup, restoreLibrary, prepareMigration, prepareMigrationFromBackup, resumeMigration, migrationStatus } from '../api/src/storage-maintenance.mjs'
import { backupZipLibrary, verifyZipBackup, restoreZipLibrary } from '../api/src/storage-zip.mjs'
import { preserveLibrary, previewLibraryRecovery, recoverLibrary, backupCompatibility, restoreUnavailableLibrary } from '../api/src/library-recovery.mjs'

// Shared by the utility worker and Node integration tests. Keep large manifests
// inside the worker; only presentation fields cross the process boundary.
export async function executeMaintenance(command, { source, destination, backup, preservation, format, revision, selections }, { onProgress = async () => {} } = {}) {
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
    case 'backup-zip': return backupZipLibrary(source, destination, { onProgress })
    case 'verify-zip': {
      const result = await verifyZipBackup(source, { onProgress })
      return { storage: result.storage, createdAt: result.createdAt, files: result.files.length }
    }
    case 'restore-zip': return restoreZipLibrary(source, destination, { onProgress })
    case 'preserve': {
      const result = await preserveLibrary(source, destination)
      return { destination: result.destination, files: result.manifest.files.length, databaseIntegrityNotGuaranteed: true }
    }
    case 'recovery-preview': return previewLibraryRecovery(source, backup, { format })
    case 'recover': return recoverLibrary(source, backup, destination, preservation, { format, revision, selections })
    case 'backup-compatibility': return backupCompatibility(source, { format })
    case 'restore-unavailable': return restoreUnavailableLibrary(source, backup, destination, preservation, { format, revision })
    case 'prepare-migration': return prepareMigration(source, destination, backup, { onProgress })
    case 'prepare-from-backup': return prepareMigrationFromBackup(source, destination, { onProgress })
    case 'resume-migration': return resumeMigration(source, { onProgress })
    case 'migration-status': return migrationStatus(source)
    default: throw new Error('未知资料库操作。')
  }
}
