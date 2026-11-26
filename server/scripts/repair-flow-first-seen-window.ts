/**
 * Removes the arrival stamps (`flow_first_seen`) written inside a time window onto flows that were
 * on file before it, or onto a statement cuota line's flow: the rows a statement close or a cartola
 * settled, which jumped to the top of «Últimos movimientos» as if they had just arrived. «On file
 * before» is read from a snapshot taken before the window (a daily `auto-daily` or a
 * `before-deploy-<sha>` one); the rule is in `src/flows/flowFirstSeenWindowRepair.ts`.
 *
 *   npx tsx scripts/repair-flow-first-seen-window.ts --from=<ISO instant> --to=<ISO instant> --snapshot=<db file> [--apply] [--migrate]
 *
 * The window is UTC instants, `[from, to)` (e.g. `--from=2026-11-25T01:00:00Z --to=2026-11-25T02:30:00Z`:
 * the ingest run that imported the statement). Report-first: every flow it would touch is printed
 * as it is now and as the snapshot held it, for a human to approve; `--apply` deletes the listed
 * stamps in one IMMEDIATE transaction. Opens the database `db.ts` would (`NW_TRACKER_TEST_DB`, else
 * `data/nw-tracker.db`) without applying migrations: a database with pending migrations is refused
 * unless `--migrate` is passed, which applies them first (importing `db.ts`). Take a snapshot first
 * (`npm run db:snapshot`).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { applyFirstSeenWindowRepair, planFirstSeenWindowRepair, windowInstant } from "../src/flows/flowFirstSeenWindowRepair.js";

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name: string) => process.argv.includes(`--${name}`);

const fromRaw = arg("from");
const toRaw = arg("to");
if (!fromRaw || !toRaw) throw new Error("--from=<ISO instant> and --to=<ISO instant> are required");
const fromIso = windowInstant(fromRaw, "--from");
const snapshotFile = arg("snapshot");
if (!snapshotFile) throw new Error("--snapshot=<a database snapshot taken before the window> is required");
if (!fs.existsSync(snapshotFile)) throw new Error(`no snapshot at ${snapshotFile}`);
const toIso = windowInstant(toRaw, "--to");

function databasePath(): string {
  const override = process.env.NW_TRACKER_TEST_DB?.trim();
  if (!override) return path.join(serverDir, "data", "nw-tracker.db");
  if (override === ":memory:") throw new Error("NW_TRACKER_TEST_DB=:memory: has nothing to repair");
  return path.isAbsolute(override) ? override : path.join(serverDir, "data", override);
}

function pendingMigrations(dbi: Database.Database): string[] {
  const files = fs.readdirSync(path.join(serverDir, "migrations")).filter((f) => f.endsWith(".sql"));
  const done = new Set((dbi.prepare(`SELECT id FROM schema_migrations`).all() as { id: string }[]).map((r) => r.id));
  return files.filter((f) => !done.has(f)).sort();
}

const file = databasePath();
if (!fs.existsSync(file)) throw new Error(`no database at ${file}`);
let dbi = new Database(file, { fileMustExist: true });
const pending = pendingMigrations(dbi);
if (pending.length > 0) {
  if (!flag("migrate")) {
    throw new Error(
      `${file} has ${pending.length} pending migration(s) (${pending.join(", ")}): this script reads the current schema. ` +
        `Boot the server on it, or pass --migrate to apply them here.`
    );
  }
  dbi.close();
  await import("../src/db.js"); // applies the pending migrations to the same file
  dbi = new Database(file, { fileMustExist: true });
}
dbi.pragma("foreign_keys = ON");

const snapshot = new Database(snapshotFile, { readonly: true, fileMustExist: true });
const plan = planFirstSeenWindowRepair(dbi, snapshot, fromIso, toIso);
snapshot.close();
console.log(`database: ${file}`);
console.log(`snapshot: ${snapshotFile}`);
console.log(`window: ${plan.fromIso} → ${plan.toIso}; ${plan.inWindow} stamp(s) inside it`);
console.log(`witness flow (same write order in both): ${plan.witnessFlowId ?? "none"}`);
for (const r of plan.remove) {
  const before = r.before ? `${r.before.occurred_on} ${r.before.amount} ${r.before.currency} «${r.before.description ?? ""}»` : "not in the snapshot";
  console.log(
    `  flow ${r.flow_id} (${r.reason}) stamped ${r.first_seen_at}: now ${r.kind} ${r.occurred_on} ${r.amount} ${r.currency} «${r.description ?? ""}»; before: ${before}`
  );
}
console.log(`${plan.remove.length} stamp(s) to remove; ${plan.inWindow - plan.remove.length} kept (first seen in the window)`);
if (!flag("apply")) {
  console.log("report only: pass --apply to remove them");
} else {
  const removed = applyFirstSeenWindowRepair(dbi, plan);
  console.log(`removed ${removed} stamp(s)`);
}
dbi.close();
