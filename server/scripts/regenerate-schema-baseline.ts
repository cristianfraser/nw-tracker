/**
 * Regenerate `server/src/schemaBaseline.ts` from a live DB's `sqlite_master`
 * (schema only, no data). Run when squashing migrations into the baseline:
 *
 *   npx tsx scripts/regenerate-schema-baseline.ts --last 155_movement_mirror_rejections.sql
 *   npx tsx scripts/regenerate-schema-baseline.ts --db data/nw-tracker.db --last <file> --dry-run
 *
 * The DB must have every migration up to `--last` applied (checked against
 * `schema_migrations`). After regenerating: delete the squashed migration files
 * (keep the ones in `BASELINE_REFERENCE_DATA_MIGRATIONS` — they seed reference
 * rows the schema-only baseline skips) and verify a fresh boot. See AGENTS.md
 * "Schema baseline (fresh DBs)".
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
function argValue(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(scriptDir, "..");
const dbPath = path.resolve(serverDir, argValue("--db") ?? "data/nw-tracker.db");
const lastMigration = argValue("--last");
const dryRun = args.includes("--dry-run");
if (!lastMigration || !/^\d+_.+\.sql$/.test(lastMigration)) {
  throw new Error("--last <NNN_name.sql> is required (the newest migration the baseline covers)");
}
if (!fs.existsSync(dbPath)) {
  throw new Error(`DB not found: ${dbPath}`);
}

const db = new Database(dbPath, { readonly: true });
const applied = db
  .prepare("SELECT 1 FROM schema_migrations WHERE id = ?")
  .get(lastMigration) as unknown;
if (!applied) {
  throw new Error(`${lastMigration} is not applied in ${dbPath} — baseline would be stale`);
}
const newerOnDisk = fs
  .readdirSync(path.join(serverDir, "migrations"))
  .filter((f) => f.endsWith(".sql") && f > lastMigration);
for (const f of newerOnDisk) {
  const row = db.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get(f) as unknown;
  if (!row) throw new Error(`${f} is newer than --last but not applied in ${dbPath}`);
  throw new Error(`${f} is applied but newer than --last — bump --last to cover it`);
}

type MasterRow = { type: string; name: string; sql: string };
const rows = db
  .prepare(
    "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'"
  )
  .all() as MasterRow[];

const SUPPORTED = new Set(["table", "index"]);
const statements = rows.map((r) => {
  if (!SUPPORTED.has(r.type)) {
    // Triggers/views would also need `db.ts` splitter care — extend deliberately, not silently.
    throw new Error(`unsupported sqlite_master type '${r.type}' for ${r.name}`);
  }
  const withIfNotExists = r.sql.replace(
    /^CREATE (TABLE|INDEX|UNIQUE INDEX)\s/,
    "CREATE $1 IF NOT EXISTS "
  );
  if (withIfNotExists === r.sql) {
    throw new Error(`could not add IF NOT EXISTS to ${r.type} ${r.name}: ${r.sql.slice(0, 60)}`);
  }
  return withIfNotExists;
});

const header = `/**
 * Full schema baseline generated from the live DB's \`sqlite_master\` (schema only, no data)
 * as of migration ${lastMigration}. \`initSchema()\` executes this on
 * every boot (all statements are IF NOT EXISTS); on a brand-new DB the migrations up to and
 * including the baseline are then marked pre-applied — squashed migration files are deleted,
 * except the reference-row seeds in \`BASELINE_REFERENCE_DATA_MIGRATIONS\` (db.ts).
 *
 * Regenerate when squashing again: npx tsx scripts/regenerate-schema-baseline.ts --last <file>
 */
export const SCHEMA_BASELINE_LAST_MIGRATION = ${JSON.stringify(lastMigration)};

export const SCHEMA_BASELINE_STATEMENTS: readonly string[] = [
${statements.map((s) => `  ${JSON.stringify(s)},`).join("\n")}
];
`;

const outPath = path.join(serverDir, "src", "schemaBaseline.ts");
if (dryRun) {
  console.log(header);
  console.log(`-- dry run: ${statements.length} statements (not written to ${outPath})`);
} else {
  fs.writeFileSync(outPath, header, "utf-8");
  console.log(`wrote ${outPath}: ${statements.length} statements, baseline = ${lastMigration}`);
}
