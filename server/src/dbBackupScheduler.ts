import fs from "node:fs";
import path from "node:path";
import { createDbSnapshot, listDbSnapshots } from "./dbSnapshot.js";
import { chileCalendarTodayYmd } from "./chileDate.js";

/**
 * Daily automatic DB snapshot while the server runs. The SQLite file is the only
 * durable copy of years of reconciled history (imports are incremental; the source
 * Excel is no longer authoritative), so it must not depend on remembering
 * `npm run db:snapshot`.
 *
 * Env:
 * - `DB_BACKUP_ENABLED`   — `0` disables (default on; set 0 on hosted demos with synthetic data).
 * - `DB_BACKUP_KEEP`      — retention count for `auto-*` snapshots (default 14). Manual
 *                           `db:snapshot` files have other labels and are never pruned.
 * - `DB_BACKUP_DIR`       — optional second copy (ideally another volume / synced folder).
 * - `DB_BACKUP_DIR_KEEP`  — retention for auto snapshots in `DB_BACKUP_DIR` (default 60).
 */

const CHECK_INTERVAL_MS = 60 * 60_000;
const AUTO_LABEL = "auto-daily";

let timerHandle: ReturnType<typeof setInterval> | null = null;
let lastBackupChileYmd: string | null = null;
let runInFlight = false;

function backupEnabled(): boolean {
  return process.env.DB_BACKUP_ENABLED !== "0";
}

function retentionCount(): number {
  const n = Number(process.env.DB_BACKUP_KEEP);
  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : 14;
}

function pruneAutoSnapshots(): void {
  const auto = listDbSnapshots().filter((s) => path.basename(s.path).endsWith(`-${AUTO_LABEL}.db`));
  for (const stale of auto.slice(retentionCount())) {
    fs.rmSync(stale.path);
    console.log(`db-backup: pruned ${path.basename(stale.path)}`);
  }
}

function secondaryRetentionCount(): number {
  const n = Number(process.env.DB_BACKUP_DIR_KEEP);
  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : 60;
}

function copyToSecondaryDir(snapshotPath: string): void {
  const dir = process.env.DB_BACKUP_DIR?.trim();
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
  if (runInFlight) return;
  const today = chileCalendarTodayYmd();
  if (lastBackupChileYmd === today) return;
  runInFlight = true;
  try {
    const r = await createDbSnapshot({ label: AUTO_LABEL });
    lastBackupChileYmd = today;
    console.log(`db-backup: ${path.basename(r.path)} (${(r.bytes / 1024 / 1024).toFixed(1)} MiB)`);
    copyToSecondaryDir(r.path);
    pruneAutoSnapshots();
  } catch (e) {
    console.error(`db-backup: failed — ${e instanceof Error ? e.message : e}`);
  } finally {
    runInFlight = false;
  }
}

export function startDbBackupScheduler(): void {
  if (!backupEnabled()) {
    console.log("db-backup: disabled (DB_BACKUP_ENABLED=0)");
    return;
  }
  if (timerHandle != null) return;
  lastBackupChileYmd = lastAutoSnapshotYmd();
  timerHandle = setInterval(() => {
    void backupTick();
  }, CHECK_INTERVAL_MS);
  timerHandle.unref?.();
  void backupTick();
}

export function stopDbBackupScheduler(): void {
  if (timerHandle != null) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
}
