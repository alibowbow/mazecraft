/** Shared by the eager file importer and the lazily loaded backup code. */
export const BACKUP_FORMAT = 'mazecraft-backup'
export const BACKUP_VERSION = 1
export const MAX_BACKUP_FILE_SIZE = 200 * 1024 * 1024

/** A backup file announces its format in its first bytes. */
export function looksLikeBackup(head: string): boolean {
  return head.includes(`"${BACKUP_FORMAT}"`)
}
