import fs from "node:fs";
import path from "node:path";
import { createDbSnapshot, listDbSnapshots, removeStaleSnapshotTemps, snapshotTempPath } from "./dbSnapshot.js";
import { planSnapshotRetention } from "./dbSnapshotRetention.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { serverConfig } from "./config.js";
import { ScheduledJob, atStartThen } from "./schedulerKernel.js";
import { insertAppMessage } from "./appMessages.js";

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
 * - `DB_BACKUP_DIR`       — optional second copy (ideally another volume / synced folder). The folder
 *                           must exist: a volume that is not mounted is an error, never recreated on
 *                           the local disk.
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
  for (const name of plan.prune) {
    const file = byName.get(name)!;
    fs.rmSync(file);
    // A snapshot opened by a tool may have left its journal files beside it.
    for (const sibling of [`${file}-wal`, `${file}-shm`]) if (fs.existsSync(sibling)) fs.rmSync(sibling);
  }
  return plan.prune;
}

/**
 * Copies a snapshot into the second folder (temp name, then rename, like the snapshot itself) and
 * prunes that folder. The folder must exist (`DB_BACKUP_DIR` names another volume or a synced
 * folder; creating it would put the "second" copy on the local disk when the volume is missing).
 */
export function copySnapshotToDir(snapshotPath: string, dir: string, dirKeep: number, todayYmd = chileCalendarTodayYmd()): string {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`DB_BACKUP_DIR ${dir} does not exist (is the volume mounted?)`);
  }
  for (const name of removeStaleSnapshotTemps(dir)) console.log(`db-backup: removed stale temp file ${name} from the secondary folder`);
  const name = path.basename(snapshotPath);
  const dest = path.join(dir, name);
  const temp = snapshotTempPath(dir, name);
  try {
    fs.copyFileSync(snapshotPath, temp);
    fs.renameSync(temp, dest);
  } catch (e) {
    fs.rmSync(temp, { force: true });
    throw e;
  }
  console.log(`db-backup: secondary copy ${dest}`);
  for (const pruned of pruneDbSnapshots(dir, dirKeep, todayYmd)) console.log(`db-backup: pruned secondary ${pruned}`);
  return dest;
}

export const DB_BACKUP_FAILED_TITLE = "Database backup failed";
export const DB_BACKUP_SECONDARY_FAILED_TITLE = "Database backup: second copy failed";

/** Chile day each failure kind last raised a notification (one per kind per day; the log gets every one). */
const failureNotifiedOn = new Map<string, string>();

function reportBackupFailure(title: string, detail: string, today: string): void {
  console.error(`db-backup: ${title.toLowerCase()} — ${detail}`);
  if (failureNotifiedOn.get(title) === today) return;
  failureNotifiedOn.set(title, today);
  insertAppMessage("notification", title, `${detail}\nThe check runs again every hour; this notification is raised once a day.`);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Tests: forget the day's backup and the failures already notified. */
export function resetDbBackupStateForTest(): void {
  lastBackupChileYmd = null;
  failureNotifiedOn.clear();
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

/**
 * Today's snapshot, once per Chile day. The primary folder is pruned whatever happens to the second
 * copy, and each failure (the snapshot, the second copy) is reported on its own.
 */
export async function backupTick(opts?: { destDir?: string }): Promise<void> {
  const today = chileCalendarTodayYmd();
  if (lastBackupChileYmd === today) return;
  let snapshotPath: string;
  try {
    const r = await createDbSnapshot({ label: AUTO_LABEL, destDir: opts?.destDir });
    lastBackupChileYmd = today;
    snapshotPath = r.path;
    console.log(`db-backup: ${path.basename(r.path)} (${(r.bytes / 1024 / 1024).toFixed(1)} MiB)`);
  } catch (e) {
    reportBackupFailure(DB_BACKUP_FAILED_TITLE, errorText(e), today);
    return;
  }
  const { dir, dirKeep, keep } = serverConfig().dbBackup;
  if (dir) {
    try {
      copySnapshotToDir(snapshotPath, dir, dirKeep, today);
    } catch (e) {
      reportBackupFailure(DB_BACKUP_SECONDARY_FAILED_TITLE, errorText(e), today);
    }
  }
  try {
    for (const name of pruneDbSnapshots(opts?.destDir, keep, today)) console.log(`db-backup: pruned ${name}`);
  } catch (e) {
    reportBackupFailure(DB_BACKUP_FAILED_TITLE, `pruning old snapshots: ${errorText(e)}`, today);
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

