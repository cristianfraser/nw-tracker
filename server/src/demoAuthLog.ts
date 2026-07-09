import Database from "better-sqlite3";
import type { Database as BetterSqliteDb } from "better-sqlite3";
import { db } from "./db.js";

/**
 * Destination for `demo_auth_logins` (recruiter-login analytics).
 *
 * On the hosted demo the synthetic DB is regenerated on every deploy / cold start
 * (see `demoMode.ts`), which would wipe the login log. When `DEMO_AUTH_LOG_DB` points at
 * a file on a persistent disk, the log lives in that separate SQLite file instead, so it
 * survives regeneration. Unset (local personal mode, tests) → the main `db`, so behavior
 * off the hosted demo is unchanged.
 */
let dedicated: BetterSqliteDb | null = null;

export function demoAuthLogDb(): BetterSqliteDb {
  const path = process.env.DEMO_AUTH_LOG_DB?.trim();
  if (!path) return db;
  if (!dedicated) {
    const handle = new Database(path);
    handle.pragma("journal_mode = WAL");
    // Schema mirrors the `demo_auth_logins` definition in schemaBaseline.ts.
    handle.exec(
      `CREATE TABLE IF NOT EXISTS demo_auth_logins (
        email TEXT NOT NULL,
        day TEXT NOT NULL,
        first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        request_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (email, day)
      )`
    );
    dedicated = handle;
  }
  return dedicated;
}
