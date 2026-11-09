import fs from "node:fs";
import path from "node:path";
import { createDbSnapshot, listDbSnapshots } from "./dbSnapshot.js";
import { planSnapshotRetention } from "./dbSnapshotRetention.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { serverConfig } from "./config.js";
import { ScheduledJob, atStartThen } from "./schedulerKernel.js";

/**
 * Daily automatic DB snapshot while the server runs. The SQLite file is the only
 * durable copy of years of reconciled history (imports are incremental; the source
 * Excel is no longer authoritative), so it must not depend on remembering
 * `npm run db:snapshot`.
 *
 * Env (`config.ts`):
 * - `DB_BACKUP_ENABLED`   — off disables (default on; the demo profile defaults it off).
 * - `DB_BACKUP_KEEP`      — days with one snapshot each (default 30); before that one per month
 *                           (`dbSnapshotRetention.ts`). Every label is pruned alike — the deploy
 *                           agent's `before-deploy-<sha>` and hand-made `db:snapshot` files too
 *                           (until 2026-11-09 only `auto-daily` was, and 171 deploy snapshots had
 *                           piled up: 4,2 GB in ten days).
 * - `DB_BACKUP_DIR`       — optional second copy (ideally another volume / synced folder).
 * - `DB_BACKUP_DIR_KEEP`  — the daily window for `DB_BACKUP_DIR` (default 60 days).
 */

const CHECK_INTERVAL_MS = 60 * 60_000;
const AUTO_LABEL = "auto-daily";

let lastBackupChileYmd: string | null = null;

/** Deletes the snapshots in `dir` the retention rule does not keep; returns what went. */
export function pruneDbSnapshots(dir: string | undefined, dailyDays: number, todayYmd = chileCalendarTodayYmd()): string[] {
  const snapshots = listDbSnapshots(dir);
  const plan = planSnapshotRetention(snapshots.map((s) => path.basename(s.path)), todayYmd, dailyDays);
  const byName = new Map(snapshots.map((s) => [path.basename(s.path), s.path]));
  for (const name of plan.prune) fs.rmSync(byName.get(name)!);
  return plan.prune;
}

function pruneSnapshots(): void {
  for (const name of pruneDbSnapshots(undefined, serverConfig().dbBackup.keep)) console.log(`db-backup: pruned ${name}`);
}

function copyToSecondaryDir(snapshotPath: string): void {
  const dir = serverConfig().dbBackup.dir;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.basename(snapshotPath));
  fs.copyFileSync(snapshotPath, dest);
  console.log(`db-backup: secondary copy ${dest}`);
  for (const name of pruneDbSnapshots(dir, serverConfig().dbBackup.dirKeep)) console.log(`db-backup: pruned secondary ${name}`);
}

/** Latest existing auto snapshot's Chile day (survives server restarts within a day). */
function lastAutoSnapshotYmd(): string | null {
  const auto = listDbSnapshots().find((s) =>
    path.basename(s.path).endsWith(`-${AUTO_LABEL}.db`)
  );
  if (!auto) return null;
  const m = /^(\d{4})(\d{2})(\d{2})-/.exec(path.basename(auto.path));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

async function backupTick(): Promise<void> {
  const today = chileCalendarTodayYmd();
  if (lastBackupChileYmd === today) return;
  try {
    const r = await createDbSnapshot({ label: AUTO_LABEL });
    lastBackupChileYmd = today;
    console.log(`db-backup: ${path.basename(r.path)} (${(r.bytes / 1024 / 1024).toFixed(1)} MiB)`);
    copyToSecondaryDir(r.path);
    pruneSnapshots();
  } catch (e) {
    console.error(`db-backup: failed — ${e instanceof Error ? e.message : e}`);
  }
}

/** Checked at start and every hour after the last check (the kernel's in-flight guard keeps one at a time). */
let lastCheckAtMs = 0;
const backupJob = new ScheduledJob({
  name: "db-backup",
  enabled: () => serverConfig().dbBackup.enabled,
  next: atStartThen(() => lastCheckAtMs + CHECK_INTERVAL_MS),
  run: async () => {
    lastCheckAtMs = Date.now();
    await backupTick();
    return "ok";
  },
});

export function startDbBackupScheduler(): void {
  if (backupJob.isEnabled) return;
  if (!serverConfig().dbBackup.enabled) {
    console.log("db-backup: disabled (DB_BACKUP_ENABLED=0)");
    return;
  }
  lastBackupChileYmd = lastAutoSnapshotYmd();
  backupJob.start();
}

