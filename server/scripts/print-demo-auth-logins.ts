import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

/**
 * Prints the recruiter-login log (`demo_auth_logins`) — admin tooling, meant for the
 * Render shell (`npm run demo:logins` from the repo root). Read-only: never creates
 * or migrates anything, and does not boot the app (no db.ts import).
 *
 * Reads `DEMO_AUTH_LOG_DB` (the persistent-disk SQLite file on the hosted demo, see
 * server/src/demoAuthLog.ts); unset → falls back to the local main DB, where the
 * table lives when a local AUTH_PASSWORD run logged logins.
 */

const here = dirname(fileURLToPath(import.meta.url));
const envPath = process.env.DEMO_AUTH_LOG_DB?.trim();
const dbPath = envPath || resolve(here, "../data/nw-tracker.db");

if (!existsSync(dbPath)) {
  console.error(`No log database at ${dbPath} — no logins have been recorded yet.`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const tableExists = db
  .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'demo_auth_logins'")
  .get();
if (!tableExists) {
  console.error(`${dbPath} has no demo_auth_logins table — no logins have been recorded yet.`);
  process.exit(1);
}

const rows = db
  .prepare(
    `SELECT day, email, request_count, first_seen_at, last_seen_at
     FROM demo_auth_logins
     ORDER BY day DESC, last_seen_at DESC`
  )
  .all();

console.log(`demo_auth_logins — ${rows.length} row(s) from ${dbPath}\n`);
console.table(rows);
