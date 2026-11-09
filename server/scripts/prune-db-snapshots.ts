/**
 * Prune the database snapshots by the retention rule (`dbSnapshotRetention.ts`: one per day for the
 * last DB_BACKUP_KEEP days, one per month before) — what the backup scheduler does after each daily
 * snapshot, run by hand:
 *
 *   npx tsx scripts/prune-db-snapshots.ts [--dir=<folder>] [--apply]
 *
 * Report-first: without `--apply` it lists what would stay and what would go.
 */
import path from "node:path";
import { planSnapshotRetention } from "../src/dbSnapshotRetention.js";
import { listDbSnapshots } from "../src/dbSnapshot.js";
import { pruneDbSnapshots } from "../src/dbBackupScheduler.js";
import { chileCalendarTodayYmd } from "../src/chileDate.js";
import { initServerConfig, serverConfig } from "../src/config.js";
import { loadRootDotenv } from "../src/rootDotenv.js";

loadRootDotenv();
initServerConfig();
const dirArg = process.argv.find((a) => a.startsWith("--dir="))?.slice("--dir=".length);
const apply = process.argv.includes("--apply");
const dailyDays = dirArg ? serverConfig().dbBackup.dirKeep : serverConfig().dbBackup.keep;
const snapshots = listDbSnapshots(dirArg);
const plan = planSnapshotRetention(snapshots.map((s) => path.basename(s.path)), chileCalendarTodayYmd(), dailyDays);
const bytes = (names: string[]) => snapshots.filter((s) => names.includes(path.basename(s.path))).reduce((a, s) => a + s.bytes, 0);
const mb = (n: number) => `${(n / 1048576).toFixed(0)} MB`;
console.log(`${snapshots.length} snapshot(s), ${mb(bytes([...plan.keep, ...plan.prune]))}; daily window ${dailyDays} day(s).`);
console.log(`keep ${plan.keep.length} (${mb(bytes(plan.keep))}):`);
for (const n of plan.keep) console.log(`  ${n}`);
console.log(`prune ${plan.prune.length} (${mb(bytes(plan.prune))}):`);
for (const n of plan.prune) console.log(`  ${n}`);
if (!apply) {
  console.log("Report only — nothing deleted. Re-run with --apply.");
} else {
  const gone = pruneDbSnapshots(dirArg, dailyDays);
  console.log(`Deleted ${gone.length} snapshot(s).`);
}
