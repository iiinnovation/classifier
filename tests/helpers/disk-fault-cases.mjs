export const diskFaultGroups = {
  sqlite: ['sqlite-update-full', 'migration-batch-full', 'migration-prepare-full', 'recovery-full'],
  migration: ['copy', 'file-sync', 'file-publish', 'directory-sync', 'ready-marker', 'ready-sync'].map(boundary => 'migration:' + boundary),
  imports: ['import-full', 'import-short-write', 'import-sync', 'import-cleanup'],
  backup: ['copy', 'file-sync', 'publish', 'directory-sync', 'manifest'].map(boundary => 'backup:' + boundary),
  restore: ['copy', 'file-sync', 'publish', 'directory-sync'].map(boundary => 'restore:' + boundary),
  preservation: [...['copy', 'file-sync', 'publish', 'directory-sync', 'manifest'].map(boundary => 'preserve:' + boundary), 'quarantine-full'],
  zip: ['zip-backup', 'zip-restore'].flatMap(operation => ['stream', 'file-sync', 'publish', 'directory-sync'].map(boundary => operation + ':' + boundary)),
}
