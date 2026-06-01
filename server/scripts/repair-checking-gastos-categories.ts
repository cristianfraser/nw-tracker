/**
 * Migrate checking gastos Único categories from legacy `checking-mv:{id}` keys to
 * stable cartola note keys; optionally recover orphans from a DB snapshot.
 *
 *   npm run repair:checking-gastos-categories -w nw-tracker-server [--dry-run]
 *   npm run repair:checking-gastos-categories -w nw-tracker-server -- --snapshot=server/data/snapshots/foo.db
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateAllCheckingGastosCategoriesToStableKeys } from "../src/checkingGastosCategoryPersist.js";
import { checkingAccountId } from "../src/checkingCartolaImport.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function resolveSnapshotPath(): string | undefined {
  const arg = process.argv.find((a) => a.startsWith("--snapshot="));
  if (arg) return path.resolve(arg.slice("--snapshot=".length));
  const dir = path.join(REPO_ROOT, "server", "data", "snapshots");
  if (!fs.existsSync(dir)) return undefined;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".db"))
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files[0] ? path.join(dir, files[0].f) : undefined;
}

const dryRun = process.argv.includes("--dry-run");
const snapshot = resolveSnapshotPath();
const accountId = checkingAccountId();

const result = migrateAllCheckingGastosCategoriesToStableKeys({
  accountId,
  snapshotDbPath: snapshot,
  dryRun,
});

console.log(
  `${dryRun ? "[dry-run] " : ""}Checking gastos categories (account ${accountId})${
    snapshot ? `, snapshot ${path.basename(snapshot)}` : ""
  }:`
);
console.log(`  migrated legacy → stable: ${result.migrated_from_legacy}`);
console.log(`  recovered from snapshot: ${result.recovered_from_snapshot}`);
console.log(`  orphaned legacy removed: ${result.orphaned_legacy_removed}`);
console.log(`  stable keys total: ${result.stable_keys_total}`);
