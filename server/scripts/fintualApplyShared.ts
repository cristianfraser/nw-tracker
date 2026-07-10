import { assertValuationCurrencyClp } from "../src/valuationValue.js";
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
import {
  fundSeriesKeyFromImportNotes,
  isFintualCertV2ValuationNotes,
  recordFintualGoalFundUnitDaily,
} from "../src/fintualFundUnitDaily.js";
import { formatSyncClp, formatSyncIndex, type SyncFieldChange } from "../src/syncRunLog.js";
import type { FintualGoalNavResolution } from "./fintualRealAssetNav.js";
import {
  cleanupUnreconciledFintualCertFundUnits,
  fintualCertV2GoalsCuotaReconciled,
  fintualCertV2PollReconciled,
  fintualCertV2PositionFromCuotaClp,
  fintualGoalsNavFromResolution,
} from "../src/fintualCertV2Reconcile.js";

export type ValuationChange = SyncFieldChange;

const stmtPriorValuation = db.prepare(
  `SELECT as_of_date, value AS value_clp, currency FROM valuations
   WHERE account_id = ? AND as_of_date < ?
   ORDER BY as_of_date DESC LIMIT 1`
);
const stmtValuationOnDay = db.prepare(
  `SELECT value AS value_clp, currency FROM valuations WHERE account_id = ? AND as_of_date = ?`
);
const stmtFundUnitOnDay = db.prepare(
  `SELECT unit_value_clp FROM fund_unit_daily WHERE series_key = ? AND day = ?`
);
const stmtFundUnitBeforeDay = db.prepare(
  `SELECT day, unit_value_clp FROM fund_unit_daily
   WHERE series_key = ? AND day < ?
   ORDER BY day DESC LIMIT 1`
);

/** Latest stored valuation strictly before `beforeYmd`. */
export function priorAccountValuation(
  accountId: number,
  beforeYmd: string
): { as_of_date: string; value_clp: number } | null {
  const row = stmtPriorValuation.get(accountId, beforeYmd) as
    | { as_of_date: string; value_clp: number; currency: string }
    | undefined;
  if (row) assertValuationCurrencyClp(row.currency, "fintualApplyShared prior");
  if (row?.value_clp == null || !Number.isFinite(row.value_clp)) return null;
  return row;
}

type FintualGoalApplyTarget = { accountId: number; importNotes: string };

/** Prefer certificado v2 account when present; fall back to legacy `import:excel|key=…` map. */
export function resolveFintualGoalApplyAccount(goal: {
  id: number | string;
  name: string;
  matchedNotes: string | null;
}): FintualGoalApplyTarget | null {
  const accStmt = db.prepare("SELECT id FROM accounts WHERE import_key = ?");
  const v2Notes = matchFintualCertGoalV2(String(goal.id), goal.name);
  if (v2Notes) {
    const v2Acc = accStmt.get(v2Notes) as { id: number } | undefined;
    if (v2Acc) return { accountId: v2Acc.id, importNotes: v2Notes };
  }
  if (goal.matchedNotes) {
    const row = accStmt.get(goal.matchedNotes) as { id: number } | undefined;
    if (row) return { accountId: row.id, importNotes: goal.matchedNotes };
  }
  return null;
}

function storedFintualGoalNavAt(
  accountId: number,
  importNotes: string,
  asOfYmd: string
): number | null {
  if (isFintualCertV2ValuationNotes(importNotes)) {
    const seriesKey = fundSeriesKeyFromImportNotes(importNotes);
    if (!seriesKey) return null;
    const units = fintualGoalUnitsFromMovements(accountId);
    if (units == null || units <= 0) return null;
    const row = stmtFundUnitOnDay.get(seriesKey, asOfYmd) as { unit_value_clp: number } | undefined;
    if (row?.unit_value_clp == null || !Number.isFinite(row.unit_value_clp)) return null;
    return Math.round(units * row.unit_value_clp);
  }
  const row = stmtValuationOnDay.get(accountId, asOfYmd) as
    | { value_clp: number; currency: string }
    | undefined;
  if (row) assertValuationCurrencyClp(row.currency, "fintualApplyShared onDay");
  if (row?.value_clp == null || !Number.isFinite(row.value_clp)) return null;
  return Math.round(row.value_clp);
}

function priorFintualGoalNav(
  accountId: number,
  importNotes: string,
  beforeYmd: string
): { as_of_date: string; value_clp: number } | null {
  if (isFintualCertV2ValuationNotes(importNotes)) {
    const seriesKey = fundSeriesKeyFromImportNotes(importNotes);
    if (!seriesKey) return null;
    const units = fintualGoalUnitsFromMovements(accountId);
    if (units == null || units <= 0) return null;
    const row = stmtFundUnitBeforeDay.get(seriesKey, beforeYmd) as
      | { day: string; unit_value_clp: number }
      | undefined;
    if (row?.unit_value_clp == null || !Number.isFinite(row.unit_value_clp)) return null;
    return { as_of_date: row.day, value_clp: Math.round(units * row.unit_value_clp) };
  }
  return priorAccountValuation(accountId, beforeYmd);
}

function storedFintualPublishUnitAt(importNotes: string, asOfYmd: string): number | null {
  if (!isFintualCertV2ValuationNotes(importNotes)) return null;
  const seriesKey = fundSeriesKeyFromImportNotes(importNotes);
  if (!seriesKey) return null;
  const row = stmtFundUnitOnDay.get(seriesKey, asOfYmd) as { unit_value_clp: number } | undefined;
  if (row?.unit_value_clp == null || !Number.isFinite(row.unit_value_clp)) return null;
  return Math.round(row.unit_value_clp * 10000) / 10000;
}

function priorFintualPublishUnit(
  importNotes: string,
  beforeYmd: string
): { day: string; unit_value_clp: number } | null {
  if (!isFintualCertV2ValuationNotes(importNotes)) return null;
  const seriesKey = fundSeriesKeyFromImportNotes(importNotes);
  if (!seriesKey) return null;
  const row = stmtFundUnitBeforeDay.get(seriesKey, beforeYmd) as
    | { day: string; unit_value_clp: number }
    | undefined;
  if (row?.unit_value_clp == null || !Number.isFinite(row.unit_value_clp)) return null;
  return { day: row.day, unit_value_clp: Math.round(row.unit_value_clp * 10000) / 10000 };
}

function fintualPublishUnitSynced(
  importNotes: string,
  asOfYmd: string,
  fundPriceClp: number | null | undefined,
  goalsNavClp: number | null | undefined,
  accountId: number
): boolean {
  const stored = storedFintualPublishUnitAt(importNotes, asOfYmd);
  if (stored == null) return false;
  if (fundPriceClp != null && fundPriceClp > 0) {
    if (Math.abs(stored - fundPriceClp) > 0.005) return false;
  }
  if (goalsNavClp != null && Number.isFinite(goalsNavClp)) {
    const cuotaPos = fintualCertV2PositionFromCuotaClp(accountId, importNotes, asOfYmd);
    if (
      cuotaPos != null &&
      !fintualCertV2GoalsCuotaReconciled({ goalsNavClp, cuotaPositionClp: cuotaPos })
    ) {
      return false;
    }
  }
  return fundPriceClp != null && fundPriceClp > 0;
}

/** Evening fund_unit write: real_assets publish, or goals API NAV moved vs prior cuota position. */
export function shouldRecordFintualCertFundUnit(opts: {
  accountId: number;
  importNotes: string;
  asOfYmd: string;
  goalsNavClp: number;
  fundPriceClp: number | null | undefined;
}): boolean {
  if (
    opts.fundPriceClp != null &&
    Number.isFinite(opts.fundPriceClp) &&
    opts.fundPriceClp > 0
  ) {
    return true;
  }
  const priorPos = priorFintualGoalNav(opts.accountId, opts.importNotes, opts.asOfYmd);
  if (priorPos == null) return true;
  return Math.abs(opts.goalsNavClp - priorPos.value_clp) > 1;
}

/** Mapped Fintual goals: v2 logs cuota, cuota position, and goals API; legacy logs valuation NAV. */
export function collectFintualGoalValuationChanges(
  snap: FintualGoalSnapshot,
  resolutions?: FintualGoalNavResolution[]
): ValuationChange[] {
  const byGoalId = new Map(resolutions?.map((r) => [String(r.row.id), r]) ?? []);
  const changes: ValuationChange[] = [];
  for (const g of snap.goals) {
    if (!g.matchedNotes && !matchFintualCertGoalV2(String(g.id), g.name)) continue;
    const target = resolveFintualGoalApplyAccount(g);
    if (!target) continue;
    const resolution = byGoalId.get(String(g.id));
    const goalsNavClp = fintualGoalsNavFromResolution(resolution, g.navClp);
    const appliedNav = resolution?.appliedNavClp ?? g.navClp;
    const nextRounded = Math.round(appliedNav);

    if (isFintualCertV2ValuationNotes(target.importNotes)) {
      const priorPos = priorFintualGoalNav(target.accountId, target.importNotes, snap.asOfDate);
      const priorUnit = priorFintualPublishUnit(target.importNotes, snap.asOfDate);
      const nextUnit =
        resolution?.fundPriceClp != null && resolution.fundPriceClp > 0
          ? Math.round(resolution.fundPriceClp * 10000) / 10000
          : goalsNavClp > 0 && fintualGoalUnitsFromMovements(target.accountId)
            ? Math.round(
                (goalsNavClp / fintualGoalUnitsFromMovements(target.accountId)!) * 10000
              ) / 10000
            : storedFintualPublishUnitAt(target.importNotes, snap.asOfDate);
      const nextPos =
        nextUnit != null && fintualGoalUnitsFromMovements(target.accountId)
          ? Math.round(fintualGoalUnitsFromMovements(target.accountId)! * nextUnit)
          : nextRounded;

      const unitSynced = fintualPublishUnitSynced(
        target.importNotes,
        snap.asOfDate,
        resolution?.fundPriceClp,
        goalsNavClp,
        target.accountId
      );
      const posUnchanged =
        priorPos != null && nextPos != null && Math.abs(priorPos.value_clp - nextPos) <= 1;
      const goalsUnchanged =
        priorPos != null && Math.abs(priorPos.value_clp - goalsNavClp) <= 1;
      if (unitSynced && posUnchanged && goalsUnchanged) continue;

      if (
        priorUnit != null &&
        nextUnit != null &&
        Math.abs(priorUnit.unit_value_clp - nextUnit) > 0.0005
      ) {
        changes.push({
          group: "fintual",
          label: `${g.name} (valor cuota)`,
          oldValue: formatSyncIndex(priorUnit.unit_value_clp),
          newValue: formatSyncIndex(nextUnit),
          oldDate: priorUnit.day,
          newDate: snap.asOfDate,
        });
      }
      if (priorPos != null && nextPos != null && Math.abs(priorPos.value_clp - nextPos) > 1) {
        changes.push({
          group: "fintual",
          label: `${g.name} (posición)`,
          oldValue: formatSyncClp(Math.round(priorPos.value_clp)),
          newValue: formatSyncClp(Math.round(nextPos)),
          oldDate: priorPos.as_of_date,
          newDate: snap.asOfDate,
        });
      }
      if (!goalsUnchanged) {
        changes.push({
          group: "fintual",
          label: `${g.name} (goals API)`,
          oldValue: formatSyncClp(priorPos != null ? Math.round(priorPos.value_clp) : goalsNavClp),
          newValue: formatSyncClp(Math.round(goalsNavClp)),
          oldDate: priorPos?.as_of_date ?? null,
          newDate: snap.asOfDate,
        });
      } else if (!unitSynced || !posUnchanged) {
        changes.push({
          group: "fintual",
          label: `${g.name} (goals API)`,
          oldValue: formatSyncClp(Math.round(goalsNavClp)),
          newValue: formatSyncClp(Math.round(goalsNavClp)),
          oldDate: snap.asOfDate,
          newDate: snap.asOfDate,
        });
      }
      continue;
    }

    const stored = storedFintualGoalNavAt(target.accountId, target.importNotes, snap.asOfDate);
    if (stored != null && Math.abs(stored - nextRounded) <= 1) continue;
    const prior = priorFintualGoalNav(target.accountId, target.importNotes, snap.asOfDate);
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
  const accStmt = db.prepare("SELECT id FROM accounts WHERE import_key = ?");
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
      if (!isFintualCertV2ValuationNotes(target.importNotes)) continue;
      const unitsForTarget =
        target.importNotes === r.row.matchedNotes
          ? r.units
          : fintualGoalUnitsFromMovements(target.accountId);
      if (
        !shouldRecordFintualCertFundUnit({
          accountId: target.accountId,
          importNotes: target.importNotes,
          asOfYmd,
          goalsNavClp: r.goalsApiNavClp,
          fundPriceClp: r.fundPriceClp,
        })
      ) {
        continue;
      }
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
  dryRun: boolean,
  opts?: { logChanges?: ValuationChange[] }
): { applied: number; skipped: number; changes: ValuationChange[] } {
  const accStmt = db.prepare("SELECT id FROM accounts WHERE import_key = ?");
  const upsert = db.prepare(`
    INSERT INTO valuations (account_id, as_of_date, value, currency)
    VALUES (@account_id, @as_of_date, @value_clp, 'clp')
    ON CONFLICT(account_id, as_of_date) DO UPDATE SET
      value = excluded.value,
      currency = excluded.currency
  `);
  /** Poll-day rows stamped before as_of fix (same NAV, date > snap.asOfDate). */
  const deleteMistakenFutureDup = db.prepare(
    `DELETE FROM valuations
     WHERE account_id = @account_id AND as_of_date > @as_of_date
       AND ABS(value - @value_clp) <= 1`
  );

  let applied = 0;
  let skipped = 0;
  const changes = opts?.logChanges ?? collectFintualGoalValuationChanges(snap);

  for (const g of snap.goals) {
    if (!g.matchedNotes && !matchFintualCertGoalV2(String(g.id), g.name)) {
      skipped += 1;
      continue;
    }
    const target = resolveFintualGoalApplyAccount(g);
    if (!target) {
      console.warn(`No account for goal "${g.name}" id=${g.id} (map: ${g.matchedNotes ?? "—"})`);
      skipped += 1;
      continue;
    }
    const row = accStmt.get(target.importNotes) as { id: number } | undefined;
    if (!row) {
      console.warn(`No account with notes=${target.importNotes} (goal "${g.name}" id=${g.id})`);
      skipped += 1;
      continue;
    }
    const value_clp = Math.round(g.navClp * 100) / 100;
    if (!isFintualCertV2ValuationNotes(target.importNotes)) {
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
    if (!isFintualCertV2ValuationNotes(target.importNotes)) {
      recordFintualGoalFundUnitDaily({
        accountId: row.id,
        importNotes: target.importNotes,
        asOfYmd: snap.asOfDate,
        navClp: g.navClp,
        dryRun,
      });
    }
    applied += 1;
  }

  return { applied, skipped, changes };
}

/** True when every mapped goal matches stored DB position for `snap.asOfDate`. */
export function fintualSnapshotMatchesDb(
  snap: FintualGoalSnapshot,
  resolutions?: FintualGoalNavResolution[]
): boolean {
  const byGoalId = new Map(resolutions?.map((r) => [String(r.row.id), r]) ?? []);
  let checked = 0;
  for (const g of snap.goals) {
    if (!g.matchedNotes && !matchFintualCertGoalV2(String(g.id), g.name)) continue;
    const target = resolveFintualGoalApplyAccount(g);
    if (!target) return false;
    const resolution = byGoalId.get(String(g.id));
    if (isFintualCertV2ValuationNotes(target.importNotes)) {
      const goalsNav = fintualGoalsNavFromResolution(resolution, g.navClp);
      if (
        !fintualPublishUnitSynced(
          target.importNotes,
          snap.asOfDate,
          resolution?.fundPriceClp,
          goalsNav,
          target.accountId
        )
      ) {
        return false;
      }
    } else {
      const stored = storedFintualGoalNavAt(target.accountId, target.importNotes, snap.asOfDate);
      if (stored == null || Math.abs(stored - g.navClp) > 1) return false;
    }
    checked++;
  }
  return checked > 0;
}

/** Remove valuations dated after `snap.asOfDate` that duplicate the API NAV (legacy poll-day stamps). */
export function cleanupMistakenPollDayFintualValuations(snap: FintualGoalSnapshot, dryRun: boolean): number {
  const accStmt = db.prepare("SELECT id FROM accounts WHERE import_key = ?");
  const deleteMistakenFutureDup = db.prepare(
    `DELETE FROM valuations
     WHERE account_id = @account_id AND as_of_date > @as_of_date
       AND ABS(value - @value_clp) <= 1`
  );
  let n = 0;
  for (const g of snap.goals) {
    if (!g.matchedNotes && !matchFintualCertGoalV2(String(g.id), g.name)) continue;
    const target = resolveFintualGoalApplyAccount(g);
    if (!target || isFintualCertV2ValuationNotes(target.importNotes)) continue;
    const row = accStmt.get(target.importNotes) as { id: number } | undefined;
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

/** Record that polled NAV for `publishYmd` is already reflected in DB (clears stale checks). */
export function markFintualAppliedFromPoll(
  state: GlobalSyncStateFile,
  cl: ChileWallClock,
  publishYmd: string,
  sig: string,
  dryRun: boolean
): void {
  if (dryRun) return;
  state.fintualLastAppliedYmd = cl.ymd;
  state.fintualLastAppliedPublishYmd = publishYmd;
  state.fintualLastAppliedSig = sig;
}

/** Mark evening poll settled when mapped goals match DB and v2 goals/cuota reconcile. */
export function markFintualEveningSettledWhenCurrent(
  state: GlobalSyncStateFile,
  cl: ChileWallClock,
  snap: FintualGoalSnapshot,
  dryRun: boolean,
  resolutions?: FintualGoalNavResolution[]
): void {
  if (dryRun || cl.hour < 18) return;
  if (fintualPublishLagsPollCalendarDay(cl, snap.asOfDate)) return;
  if (!fintualSnapshotMatchesDb(snap, resolutions)) return;
  if (!fintualCertV2PollReconciled(snap.asOfDate, state)) return;
  state.fintualEveningSettledYmd = cl.ymd;
}

/** Remove unreconciled inferred fund_unit rows for `publishYmd` (goals API lagging cuota). */
export function cleanupUnreconciledFintualCertFundUnitsForPoll(
  publishYmd: string,
  resolutions: FintualGoalNavResolution[],
  dryRun: boolean
): number {
  const goalsById = new Map<string, number>();
  for (const r of resolutions) {
    if (!r.row.matchedNotes && !matchFintualCertGoalV2(String(r.row.id), r.row.name)) continue;
    goalsById.set(String(r.row.id), Math.round(r.goalsApiNavClp));
  }
  return cleanupUnreconciledFintualCertFundUnits(publishYmd, goalsById, dryRun);
}

export function fintualMappedNavSignature(snap: FintualGoalSnapshot): string {
  const parts = snap.goals
    .filter((g) => g.matchedNotes)
    .map((g) => `${g.id}:${Math.round(g.navClp * 100) / 100}`)
    .sort();
  return parts.join("|");
}

/** Goals API NAV signature (evening stale / reconcile); not real_assets applied NAV. */
export function fintualMappedGoalsApiSignature(resolutions: FintualGoalNavResolution[]): string {
  const parts: string[] = [];
  for (const r of resolutions) {
    if (!r.row.matchedNotes && !matchFintualCertGoalV2(String(r.row.id), r.row.name)) continue;
    parts.push(`${r.row.id}:${Math.round(r.goalsApiNavClp * 100) / 100}`);
  }
  parts.sort();
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
