/**
 * Counts statements this connection ran that may write (any statement better-sqlite3 does not
 * report as read-only, and every `exec`), so a reader can tell whether this connection wrote
 * since it last looked without asking the database. Writes by other connections are not
 * counted; those show in `PRAGMA data_version`.
 */
let writes = 0;

export function noteDbWrite(): void {
  writes += 1;
}

export function dbWriteCount(): number {
  return writes;
}
