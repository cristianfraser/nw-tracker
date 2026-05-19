import { chileCalendarAddDays, type ChileWallClock } from "../src/chileDate.js";
import { db } from "../src/db.js";
import type { GlobalSyncStateFile } from "../src/globalSyncState.js";
import { buildGoalsSnapshot, type FintualGoalRow, type FintualGoalSnapshot } from "./fintualApiLib.js";
import { recordFintualGoalFundUnitDaily } from "../src/fintualFundUnitDaily.js";

export type ValuationChange = { label: string; oldValue: string; newValue: string };

export function applyFintualGoalsSnapshotToDb(
  snap: FintualGoalSnapshot,
  dryRun: boolean
): { applied: number; skipped: number; changes: ValuationChange[] } {
  const accStmt = db.prepare("SELECT id FROM accounts WHERE notes = ?");
  const upsert = db.prepare(`
    INSERT INTO valuations (account_id, as_of_date, value_clp)
    VALUES (@account_id, @as_of_date, @value_clp)
    ON CONFLICT(account_id, as_of_date) DO UPDATE SET
      value_clp = excluded.value_clp
  `);
  /** Poll-day rows stamped before as_of fix (same NAV, date > snap.asOfDate). */
  const deleteMistakenFutureDup = db.prepare(
    `DELETE FROM valuations
     WHERE account_id = @account_id AND as_of_date > @as_of_date
       AND ABS(value_clp - @value_clp) <= 1`
  );

  const valStmt = db.prepare(
    `SELECT value_clp FROM valuations WHERE account_id = ? AND as_of_date = ?`
  );

  let applied = 0;
  let skipped = 0;
  const changes: ValuationChange[] = [];

  for (const g of snap.goals) {
    if (!g.matchedNotes) {
      skipped += 1;
      continue;
    }
    const row = accStmt.get(g.matchedNotes) as { id: number } | undefined;
    if (!row) {
      console.warn(`No account with notes=${g.matchedNotes} (goal "${g.name}" id=${g.id})`);
      skipped += 1;
      continue;
    }
    const value_clp = Math.round(g.navClp * 100) / 100;
    const prev = valStmt.get(row.id, snap.asOfDate) as { value_clp: number } | undefined;
    const prevRounded =
      prev?.value_clp != null && Number.isFinite(prev.value_clp)
        ? Math.round(prev.value_clp)
        : null;
    const nextRounded = Math.round(value_clp);
    if (prevRounded == null || Math.abs(prevRounded - nextRounded) > 1) {
      changes.push({
        label: `${g.name} value_clp`,
        oldValue: prevRounded != null ? String(prevRounded) : "—",
        newValue: String(nextRounded),
      });
    }
    if (dryRun) {
      console.log(
        `[dry-run] account_id=${row.id} as_of=${snap.asOfDate} value_clp=${value_clp} ← goal "${g.name}"`
      );
    } else {
      upsert.run({
        account_id: row.id,
        as_of_date: snap.asOfDate,
        value_clp,
      });
      if (!dryRun) {
        deleteMistakenFutureDup.run({
          account_id: row.id,
          as_of_date: snap.asOfDate,
          value_clp,
        });
      }
    }
    const fu = recordFintualGoalFundUnitDaily({
      accountId: row.id,
      importNotes: g.matchedNotes,
      asOfYmd: snap.asOfDate,
      navClp: g.navClp,
      dryRun,
    });
    if (fu.recorded && fu.gapDaysFilled > 0 && !dryRun) {
      console.log(
        `sync: Fintual — fund_unit_daily ${fu.unitClp} (${snap.asOfDate}), carried ${fu.gapDaysFilled} day(s)`
      );
    }
    applied += 1;
  }

  return { applied, skipped, changes };
}

/** True when every mapped goal matches `valuations` for `snap.asOfDate` within 1 CLP. */
export function fintualSnapshotMatchesDb(snap: FintualGoalSnapshot): boolean {
  const accStmt = db.prepare("SELECT id FROM accounts WHERE notes = ?");
  const valStmt = db.prepare(
    `SELECT value_clp FROM valuations WHERE account_id = ? AND as_of_date = ?`
  );
  let checked = 0;
  for (const g of snap.goals) {
    if (!g.matchedNotes) continue;
    const row = accStmt.get(g.matchedNotes) as { id: number } | undefined;
    if (!row) return false;
    const v = valStmt.get(row.id, snap.asOfDate) as { value_clp: number } | undefined;
    if (!v) return false;
    if (Math.abs(v.value_clp - g.navClp) > 1) return false;
    checked++;
  }
  return checked > 0;
}

/** Remove valuations dated after `snap.asOfDate` that duplicate the API NAV (legacy poll-day stamps). */
export function cleanupMistakenPollDayFintualValuations(snap: FintualGoalSnapshot, dryRun: boolean): number {
  const accStmt = db.prepare("SELECT id FROM accounts WHERE notes = ?");
  const deleteMistakenFutureDup = db.prepare(
    `DELETE FROM valuations
     WHERE account_id = @account_id AND as_of_date > @as_of_date
       AND ABS(value_clp - @value_clp) <= 1`
  );
  let n = 0;
  for (const g of snap.goals) {
    if (!g.matchedNotes) continue;
    const row = accStmt.get(g.matchedNotes) as { id: number } | undefined;
    if (!row) continue;
    const value_clp = Math.round(g.navClp * 100) / 100;
    if (dryRun) continue;
    const r = deleteMistakenFutureDup.run({
      account_id: row.id,
      as_of_date: snap.asOfDate,
      value_clp,
    });
    n += r.changes;
  }
  return n;
}

export type PickFintualSnapshotResult = { snap: FintualGoalSnapshot; mode: "apply" };

/** Evening sync applies `GET /api/goals` NAV to Chile today (`cl.ymd`). */
export function pickFintualApplySnapshot(
  rows: FintualGoalRow[],
  byGoalId: Record<string, string>,
  cl: ChileWallClock,
  _state: GlobalSyncStateFile
): PickFintualSnapshotResult {
  return { snap: buildGoalsSnapshot(rows, byGoalId, cl, cl.ymd), mode: "apply" };
}

export function fintualEveningCatchUpComplete(
  rows: FintualGoalRow[],
  byGoalId: Record<string, string>,
  cl: ChileWallClock
): boolean {
  if (cl.hour < 18) return true;
  const ymd = cl.ymd;
  const yesterday = chileCalendarAddDays(ymd, -1);
  const snapY = buildGoalsSnapshot(rows, byGoalId, cl, yesterday);
  const snapT = buildGoalsSnapshot(rows, byGoalId, cl, ymd);
  return fintualSnapshotMatchesDb(snapY) && fintualSnapshotMatchesDb(snapT);
}

export function fintualMappedNavSignature(snap: FintualGoalSnapshot): string {
  const parts = snap.goals
    .filter((g) => g.matchedNotes)
    .map((g) => `${g.id}:${Math.round(g.navClp * 100) / 100}`)
    .sort();
  return parts.join("|");
}
