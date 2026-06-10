import { type ChileWallClock } from "../src/chileDate.js";
import {
  fintualPublishLagsPollCalendarDay,
  priorFintualPublishYmd,
} from "../src/fintualPublishDate.js";
import { db } from "../src/db.js";
import type { GlobalSyncStateFile } from "../src/globalSyncState.js";
import { buildGoalsSnapshot, type FintualGoalRow, type FintualGoalSnapshot } from "./fintualApiLib.js";
import { matchFintualCertGoalV2 } from "../src/fintualCertV2.js";
import { fintualGoalUnitsFromMovements } from "../src/fintualGoalUnits.js";
import { isFintualCertV2ValuationNotes, recordFintualGoalFundUnitDaily } from "../src/fintualFundUnitDaily.js";
import { formatSyncClp, type SyncFieldChange } from "../src/syncRunLog.js";
import type { FintualGoalNavResolution } from "./fintualRealAssetNav.js";

export type ValuationChange = SyncFieldChange;

const stmtPriorValuation = db.prepare(
  `SELECT as_of_date, value_clp FROM valuations
   WHERE account_id = ? AND as_of_date < ?
   ORDER BY as_of_date DESC LIMIT 1`
);

/** Latest stored valuation strictly before `beforeYmd`. */
export function priorAccountValuation(
  accountId: number,
  beforeYmd: string
): { as_of_date: string; value_clp: number } | null {
  const row = stmtPriorValuation.get(accountId, beforeYmd) as
    | { as_of_date: string; value_clp: number }
    | undefined;
  if (row?.value_clp == null || !Number.isFinite(row.value_clp)) return null;
  return row;
}

/** Mapped Fintual goals whose API NAV differs from the stored valuation on `snap.asOfDate`. */
export function collectFintualGoalValuationChanges(snap: FintualGoalSnapshot): ValuationChange[] {
  const accStmt = db.prepare("SELECT id FROM accounts WHERE notes = ?");
  const valStmt = db.prepare(
    `SELECT value_clp FROM valuations WHERE account_id = ? AND as_of_date = ?`
  );
  const changes: ValuationChange[] = [];
  for (const g of snap.goals) {
    if (!g.matchedNotes) continue;
    const row = accStmt.get(g.matchedNotes) as { id: number } | undefined;
    if (!row) continue;
    const nextRounded = Math.round(g.navClp);
    const prev = valStmt.get(row.id, snap.asOfDate) as { value_clp: number } | undefined;
    const prevRounded =
      prev?.value_clp != null && Number.isFinite(prev.value_clp)
        ? Math.round(prev.value_clp)
        : null;
    if (prevRounded != null && Math.abs(prevRounded - nextRounded) <= 1) continue;
    const prior = priorAccountValuation(row.id, snap.asOfDate);
    changes.push({
      group: "fintual",
      label: g.name,
      oldValue: prior != null ? formatSyncClp(Math.round(prior.value_clp)) : "—",
      newValue: formatSyncClp(nextRounded),
      oldDate: prior?.as_of_date ?? null,
      newDate: snap.asOfDate,
    });
  }
  return changes;
}

/**
 * Upsert `fund_unit_daily` from evening Fintual poll (publish price and/or NAV), even when valuations are unchanged.
 */
export function syncFintualFundUnitsFromResolutions(
  resolutions: FintualGoalNavResolution[],
  asOfYmd: string,
  dryRun: boolean
): number {
  const accStmt = db.prepare("SELECT id FROM accounts WHERE notes = ?");
  let recorded = 0;
  for (const r of resolutions) {
    const notesTargets: { importNotes: string; accountId: number }[] = [];
    if (r.row.matchedNotes) {
      const acc = accStmt.get(r.row.matchedNotes) as { id: number } | undefined;
      if (acc) notesTargets.push({ importNotes: r.row.matchedNotes, accountId: acc.id });
    }
    const v2Notes = matchFintualCertGoalV2(r.row.id, r.row.name);
    if (v2Notes) {
      const v2Acc = accStmt.get(v2Notes) as { id: number } | undefined;
      if (v2Acc) notesTargets.push({ importNotes: v2Notes, accountId: v2Acc.id });
    }
    for (const target of notesTargets) {
      const unitsForTarget =
        target.importNotes === r.row.matchedNotes
          ? r.units
          : fintualGoalUnitsFromMovements(target.accountId);
      const fu = recordFintualGoalFundUnitDaily({
        accountId: target.accountId,
        importNotes: target.importNotes,
        asOfYmd,
        navClp: r.appliedNavClp,
        fundPriceClp: r.fundPriceClp,
        units: unitsForTarget,
        dryRun,
      });
      if (!fu.recorded) continue;
      recorded += 1;
      if (!dryRun) {
        const src =
          r.fundPriceClp != null && r.fundPriceClp > 0 ? "publish" : "inferred";
        console.log(
          `sync: Fintual — fund_unit_daily ${fu.unitClp} (${asOfYmd}, ${src}, ${target.importNotes})` +
            (fu.gapDaysFilled > 0 ? `, carried ${fu.gapDaysFilled} day(s)` : "")
        );
      }
    }
  }
  return recorded;
}

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

  let applied = 0;
  let skipped = 0;
  const changes = collectFintualGoalValuationChanges(snap);

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
    if (!isFintualCertV2ValuationNotes(g.matchedNotes)) {
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
        deleteMistakenFutureDup.run({
          account_id: row.id,
          as_of_date: snap.asOfDate,
          value_clp,
        });
      }
    }
    recordFintualGoalFundUnitDaily({
      accountId: row.id,
      importNotes: g.matchedNotes,
      asOfYmd: snap.asOfDate,
      navClp: g.navClp,
      dryRun,
    });
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
  _state: GlobalSyncStateFile,
  publishYmd: string
): PickFintualSnapshotResult {
  return { snap: buildGoalsSnapshot(rows, byGoalId, cl, publishYmd), mode: "apply" };
}

export function fintualEveningCatchUpComplete(
  rows: FintualGoalRow[],
  byGoalId: Record<string, string>,
  cl: ChileWallClock,
  publishYmd: string
): boolean {
  if (cl.hour < 18) return true;
  if (fintualPublishLagsPollCalendarDay(cl, publishYmd)) return false;
  const prior = priorFintualPublishYmd(publishYmd);
  const snapPub = buildGoalsSnapshot(rows, byGoalId, cl, publishYmd);
  if (!prior || prior === publishYmd) {
    return fintualSnapshotMatchesDb(snapPub);
  }
  const snapPrior = buildGoalsSnapshot(rows, byGoalId, cl, prior);
  return fintualSnapshotMatchesDb(snapPrior) && fintualSnapshotMatchesDb(snapPub);
}

/** Mark evening poll settled when today's mapped goals already match DB (≥18:00 Chile). */
export function markFintualEveningSettledWhenCurrent(
  state: GlobalSyncStateFile,
  cl: ChileWallClock,
  snap: FintualGoalSnapshot,
  dryRun: boolean
): void {
  if (dryRun || cl.hour < 18) return;
  if (fintualPublishLagsPollCalendarDay(cl, snap.asOfDate)) return;
  if (fintualSnapshotMatchesDb(snap)) state.fintualEveningSettledYmd = cl.ymd;
}

export function fintualMappedNavSignature(snap: FintualGoalSnapshot): string {
  const parts = snap.goals
    .filter((g) => g.matchedNotes)
    .map((g) => `${g.id}:${Math.round(g.navClp * 100) / 100}`)
    .sort();
  return parts.join("|");
}

/** True when mapped goals' NAV matches the last evening apply (Fintual has not published new totals). */
export function fintualNavUnchangedSinceLastApply(
  sig: string,
  state: GlobalSyncStateFile,
  publishYmd?: string
): boolean {
  if (publishYmd != null && publishYmd !== state.fintualLastAppliedPublishYmd) {
    return false;
  }
  return Boolean(state.fintualLastAppliedSig && sig === state.fintualLastAppliedSig);
}
