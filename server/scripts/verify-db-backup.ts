/**
 * Backup restore drill: prove the latest DB snapshot actually restores.
 *
 *   npm run db:verify-backup -w nw-tracker-server
 *   npm run db:verify-backup -w nw-tracker-server -- --snapshot=/path/to/file.db
 *
 * Checks, on a readonly connection to the snapshot:
 *   1. PRAGMA integrity_check == ok
 *   2. PRAGMA foreign_key_check returns no rows
 *   3. Key-table row counts vs the live DB — a snapshot with an empty table that is
 *      populated live means the backup is not restorable and the drill fails.
 * Also verifies the newest auto-daily snapshot is recent (default max 3 days,
 * --max-age-days=N) so a silently-dead scheduler is caught here too.
 * Scans `server/data/snapshots/` and, when set, `DB_BACKUP_DIR` (root .env is loaded).
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { loadRootDotenv } from "../src/rootDotenv.js";
import { listDbSnapshots, resolveDatabaseFilePath } from "../src/dbSnapshot.js";

loadRootDotenv();

const KEY_TABLES = ["accounts", "movements", "valuations", "cc_statement_lines"] as const;

function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : undefined;
}

function newestSnapshot(): { path: string; mtimeMs: number } {
  const explicit = arg("snapshot");
  if (explicit) {
    const p = path.resolve(explicit);
    if (!fs.existsSync(p)) throw new Error(`snapshot not found: ${p}`);
    return { path: p, mtimeMs: fs.statSync(p).mtimeMs };
  }
  const dirs = [undefined, process.env.DB_BACKUP_DIR?.trim() || undefined];
  const all = dirs.flatMap((d) => (d === undefined ? listDbSnapshots() : listDbSnapshots(d)));
  if (all.length === 0) {
    throw new Error("no snapshots found in server/data/snapshots/ or DB_BACKUP_DIR");
  }
  return all.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]!;
}

function tableCounts(dbPath: string): Record<string, number> {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const out: Record<string, number> = {};
    for (const t of KEY_TABLES) {
      const exists = db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(t);
      out[t] = exists ? (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c : -1;
    }
    return out;
  } finally {
    db.close();
  }
}

const snap = newestSnapshot();
const ageDays = (Date.now() - snap.mtimeMs) / 86_400_000;
console.log(`snapshot: ${snap.path} (${ageDays.toFixed(1)} days old)`);

const errors: string[] = [];

const snapDb = new Database(snap.path, { readonly: true, fileMustExist: true });
try {
  const integrity = snapDb.pragma("integrity_check") as { integrity_check: string }[];
  if (integrity.length !== 1 || integrity[0]!.integrity_check !== "ok") {
    errors.push(`integrity_check failed: ${JSON.stringify(integrity).slice(0, 300)}`);
  } else {
    console.log("integrity_check: ok");
  }

  const fkViolations = snapDb.pragma("foreign_key_check") as unknown[];
  if (fkViolations.length > 0) {
    errors.push(`foreign_key_check: ${fkViolations.length} violation(s), first: ${JSON.stringify(fkViolations[0])}`);
  } else {
    console.log("foreign_key_check: ok");
  }
} finally {
  snapDb.close();
}

const snapCounts = tableCounts(snap.path);
const livePath = resolveDatabaseFilePath();
const liveCounts = fs.existsSync(livePath) ? tableCounts(livePath) : null;

for (const t of KEY_TABLES) {
  const s = snapCounts[t]!;
  const l = liveCounts?.[t];
  console.log(`${t}: snapshot=${s === -1 ? "missing" : s}${l != null ? ` live=${l === -1 ? "missing" : l}` : ""}`);
  if (s === -1) {
    errors.push(`snapshot is missing table ${t}`);
  } else if (l != null && l > 0 && s === 0) {
    errors.push(`snapshot has 0 rows in ${t} but the live DB has ${l} — backup not restorable`);
  }
}

const maxAgeDays = Number(arg("max-age-days") ?? 3);
if (Number.isFinite(maxAgeDays) && ageDays > maxAgeDays && !arg("snapshot")) {
  errors.push(
    `newest snapshot is ${ageDays.toFixed(1)} days old (max ${maxAgeDays}) — is the backup scheduler running?`
  );
}

if (errors.length > 0) {
  console.error(`\nverify-db-backup: FAILED\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  process.exit(1);
}
console.log("\nverify-db-backup: ok — snapshot restores cleanly");
