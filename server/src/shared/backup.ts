/** Legacy SQLite archives must never overwrite keys for a live PostgreSQL database. */
export const legacyBackupUnavailable =
  "Legacy SQLite backup/restore is unavailable for PostgreSQL. Use deploy/scripts/backup-stack.sh and docs/backup-recovery.md to preserve the database, server keys, and Node-RED state together.";
