import fs from "node:fs";
import path from "node:path";
import { createDbSnapshot, listDbSnapshots } from "./dbSnapshot.js";
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
 * - `DB_BACKUP_KEEP`      — retention count for `auto-*` snapshots (default 14). Manual
 *                           `db:snapshot` files have other labels and are never pruned.
 * - `DB_BACKUP_DIR`       — optional second copy (ideally another volume / synced folder).
 * - `DB_BACKUP_DIR_KEEP`  — retention for auto snapshots in `DB_BACKUP_DIR` (default 60).
 */

const CHECK_INTERVAL_MS = 60 * 60_000;
const AUTO_LABEL = "auto-daily";

let lastBackupChileYmd: string | null = null;

function retentionCount(): number {
  return serverConfig().dbBackup.keep;
}

function pruneAutoSnapshots(): void {
  const auto = listDbSnapshots().filter((s) => path.basename(s.path).endsWith(`-${AUTO_LABEL}.db`));
  for (const stale of auto.slice(retentionCount())) {
    fs.rmSync(stale.path);
    console.log(`db-backup: pruned ${path.basename(stale.path)}`);
  }
}

function secondaryRetentionCount(): number {
  return serverConfig().dbBackup.dirKeep;
}

function copyToSecondaryDir(snapshotPath: string): void {
  const dir = serverConfig().dbBackup.dir;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.basename(snapshotPath));
  fs.copyFileSync(snapshotPath, dest);
  console.log(`db-backup: secondary copy ${dest}`);
  const auto = listDbSnapshots(dir).filter((s) =>
    path.basename(s.path).endsWith(`-${AUTO_LABEL}.db`)
  );
  for (const stale of auto.slice(secondaryRetentionCount())) {
    fs.rmSync(stale.path);
    console.log(`db-backup: pruned secondary ${path.basename(stale.path)}`);
  }
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
    pruneAutoSnapshots();
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

