import { assertFundSeriesClp } from "./fundUnitDaily.js";
import { assertValuationCurrency } from "./valuationValue.js";
import { type ChileWallClock } from "./chileDate.js";
import {
  fintualPublishLagsPollCalendarDay,
  priorFintualPublishYmd,
} from "./fintualPublishDate.js";
import { db } from "./db.js";
import type { GlobalSyncStateFile } from "./globalSyncState.js";
import { buildGoalsSnapshot, type FintualGoalRow, type FintualGoalSnapshot } from "./fintualApiLib.js";
import { fintualCertGoalImportKeyById } from "./fintualCertV2.js";
import { fintualGoalUnitsFromMovements } from "./fintualGoalUnits.js";
import {
  fundSeriesKeyFromImportNotes,
  recordFintualGoalFundUnitDaily,
} from "./fintualFundUnitDaily.js";
import { formatSyncClp, formatSyncIndex, type SyncFieldChange } from "./syncRunLog.js";
import type { FintualGoalNavResolution } from "./fintualRealAssetNav.js";
import {
  cleanupUnreconciledFintualCertFundUnits,
  fintualCertV2GoalsCuotaReconciled,
  fintualCertV2PollReconciled,
  fintualCertV2PositionFromCuotaClp,
  fintualGoalsNavFromResolution,
} from "./fintualCertV2Reconcile.js";

export type ValuationChange = SyncFieldChange;

const stmtPriorValuation = db.prepare(
  `SELECT as_of_date, value AS value_clp, currency FROM valuations
   WHERE account_id = ? AND as_of_date < ?
   ORDER BY as_of_date DESC LIMIT 1`
);
const stmtFundUnitOnDay = db.prepare(
  `SELECT unit_value FROM fund_unit_daily WHERE series_key = ? AND day = ?`
);
const stmtFundUnitBeforeDay = db.prepare(
  `SELECT day, unit_value FROM fund_unit_daily
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
  if (row) assertValuationCurrency(row.currency, "clp", "fintualApplyShared prior");
  if (row?.value_clp == null || !Number.isFinite(row.value_clp)) return null;
  return row;
}

type FintualGoalApplyTarget = { accountId: number; importNotes: string };

const stmtAccountByImportKey = db.prepare("SELECT id FROM accounts WHERE import_key = ?");

/** True when the app tracks the goal (`fintualGoals.ts`, the certificado goal map). */
function fintualGoalIsTracked(goal: { id: number | string; name: string }): boolean {
  return fintualCertGoalImportKeyById(String(goal.id)) != null;
}

/**
 * The certificado account a live goal is valued on. A goal is tracked on its certificado account
 * only: one the app does not track (`fintualGoals.ts`) or whose account row is missing throws.
 */
export function resolveFintualGoalApplyAccount(goal: { id: number | string; name: string }): FintualGoalApplyTarget {
  const importNotes = fintualCertGoalImportKeyById(String(goal.id));
  if (!importNotes) {
    throw new Error(
      `Fintual goal ${goal.id} has no certificado account: it is not a tracked goal (fintualGoals.ts)`
    );
  }
  const row = stmtAccountByImportKey.get(importNotes) as { id: number } | undefined;
  if (!row) throw new Error(`Fintual goal ${goal.id}: no account carries ${importNotes}`);
  return { accountId: row.id, importNotes };
}

/** The goal's position on the latest valor cuota strictly before `beforeYmd` (ledger cuotas × that bar). */
function priorFintualGoalNav(
  accountId: number,
  importNotes: string,
  beforeYmd: string
): { as_of_date: string; value_clp: number } | null {
  const seriesKey = fundSeriesKeyFromImportNotes(importNotes);
  if (!seriesKey) return null;
  const units = fintualGoalUnitsFromMovements(accountId);
  if (units == null || units <= 0) return null;
  assertFundSeriesClp(seriesKey, "fintualApplyShared");
  const row = stmtFundUnitBeforeDay.get(seriesKey, beforeYmd) as
    | { day: string; unit_value: number }
    | undefined;
  if (row?.unit_value == null || !Number.isFinite(row.unit_value)) return null;
  return { as_of_date: row.day, value_clp: Math.round(units * row.unit_value) };
}

function storedFintualPublishUnitAt(importNotes: string, asOfYmd: string): number | null {
  const seriesKey = fundSeriesKeyFromImportNotes(importNotes);
  if (!seriesKey) return null;
  assertFundSeriesClp(seriesKey, "fintualApplyShared");
  const row = stmtFundUnitOnDay.get(seriesKey, asOfYmd) as { unit_value: number } | undefined;
  if (row?.unit_value == null || !Number.isFinite(row.unit_value)) return null;
  return Math.round(row.unit_value * 10000) / 10000;
}

function priorFintualPublishUnit(
  importNotes: string,
  beforeYmd: string
): { day: string; unit_value: number } | null {
  const seriesKey = fundSeriesKeyFromImportNotes(importNotes);
  if (!seriesKey) return null;
  assertFundSeriesClp(seriesKey, "fintualApplyShared");
  const row = stmtFundUnitBeforeDay.get(seriesKey, beforeYmd) as
    | { day: string; unit_value: number }
    | undefined;
  if (row?.unit_value == null || !Number.isFinite(row.unit_value)) return null;
  return { day: row.day, unit_value: Math.round(row.unit_value * 10000) / 10000 };
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

/** Tracked Fintual goals: logs the valor cuota, the cuota position and the goals API figure. */
export function collectFintualGoalValuationChanges(
  snap: FintualGoalSnapshot,
  resolutions?: FintualGoalNavResolution[]
): ValuationChange[] {
  const byGoalId = new Map(resolutions?.map((r) => [String(r.row.id), r]) ?? []);
  const changes: ValuationChange[] = [];
  for (const g of snap.goals) {
    const target = resolveFintualGoalApplyAccount(g);
    const resolution = byGoalId.get(String(g.id));
    const goalsNavClp = fintualGoalsNavFromResolution(resolution, g.navClp);
    const appliedNav = resolution?.appliedNavClp ?? g.navClp;
    const nextRounded = Math.round(appliedNav);

    const priorPos = priorFintualGoalNav(target.accountId, target.importNotes, snap.asOfDate);
    const priorUnit = priorFintualPublishUnit(target.importNotes, snap.asOfDate);
    // Without a publish price nothing is written for a v2 account (never NAV ÷ ledger cuotas:
    // the ledger lags Fintual while cash is in transit), so the "next" unit is the stored bar.
    const nextUnit =
      resolution?.fundPriceClp != null && resolution.fundPriceClp > 0
        ? Math.round(resolution.fundPriceClp * 10000) / 10000
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
      Math.abs(priorUnit.unit_value - nextUnit) > 0.0005
    ) {
      changes.push({
        group: "fintual",
        label: `${g.name} (valor cuota)`,
        oldValue: formatSyncIndex(priorUnit.unit_value),
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
  }
  return changes;
}

/** Upsert `fund_unit_daily` from the evening Fintual poll: each tracked goal's publish price, when the poll has one. */
export function syncFintualFundUnitsFromResolutions(
  resolutions: FintualGoalNavResolution[],
  asOfYmd: string,
  dryRun: boolean
): number {
  let recorded = 0;
  for (const r of resolutions) {
    const target = resolveFintualGoalApplyAccount(r.row);
    if (r.fundPriceClp == null || !(r.fundPriceClp > 0)) {
      // No Fintual-priced cuota this poll (empty goal, or its closure day lags the publish
      // day): write nothing. Inferring NAV ÷ ledger cuotas is exactly the derivation that
      // mispriced four Reserva bars while a retiro was in transit (2026-09-17).
      if (r.units != null && r.units > 0) {
        console.log(
          `sync: Fintual — no publish price for ${r.row.name} on ${asOfYmd}; fund_unit_daily untouched.`
        );
      }
      continue;
    }
    const fu = recordFintualGoalFundUnitDaily({
      accountId: target.accountId,
      importNotes: target.importNotes,
      asOfYmd,
      navClp: r.appliedNavClp,
      fundPriceClp: r.fundPriceClp,
      units: fintualGoalUnitsFromMovements(target.accountId),
      dryRun,
    });
    if (!fu.recorded) continue;
    recorded += 1;
    if (!dryRun) {
      console.log(
        `sync: Fintual — fund_unit_daily ${fu.unitClp} (${asOfYmd}, publish, ${target.importNotes})` +
          (fu.gapDaysFilled > 0 ? `, stand-in for ${fu.gapDaysFilled} skipped day(s)` : "")
      );
    }
  }
  return recorded;
}

/**
 * Counts the snapshot's goals as applied. A goal's stored state is its valor cuota bar
 * (`syncFintualFundUnitsFromResolutions`) and its ledger cuotas: a certificado account carries no
 * stored valuation, so nothing is written here. A goal with no certificado account throws.
 */
export function applyFintualGoalsSnapshotToDb(
  snap: FintualGoalSnapshot,
  _dryRun: boolean,
  opts?: { logChanges?: ValuationChange[] }
): { applied: number; skipped: number; changes: ValuationChange[] } {
  const changes = opts?.logChanges ?? collectFintualGoalValuationChanges(snap);
  for (const g of snap.goals) resolveFintualGoalApplyAccount(g);
  return { applied: snap.goals.length, skipped: 0, changes };
}

/** True when every goal's stored valor cuota for `snap.asOfDate` matches the poll (and its cuota position reconciles). */
export function fintualSnapshotMatchesDb(
  snap: FintualGoalSnapshot,
  resolutions?: FintualGoalNavResolution[]
): boolean {
  const byGoalId = new Map(resolutions?.map((r) => [String(r.row.id), r]) ?? []);
  for (const g of snap.goals) {
    const target = resolveFintualGoalApplyAccount(g);
    const resolution = byGoalId.get(String(g.id));
    const goalsNav = fintualGoalsNavFromResolution(resolution, g.navClp);
    if (!fintualPublishUnitSynced(target.importNotes, snap.asOfDate, resolution?.fundPriceClp, goalsNav, target.accountId)) {
      return false;
    }
  }
  return snap.goals.length > 0;
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
    if (!fintualGoalIsTracked(r.row)) continue;
    goalsById.set(String(r.row.id), Math.round(r.goalsApiNavClp));
  }
  return cleanupUnreconciledFintualCertFundUnits(publishYmd, goalsById, dryRun);
}

export function fintualMappedNavSignature(snap: FintualGoalSnapshot): string {
  const parts = snap.goals
    .filter((g) => fintualGoalIsTracked(g))
    .map((g) => `${g.id}:${Math.round(g.navClp * 100) / 100}`)
    .sort();
  return parts.join("|");
}

/** Goals API NAV signature (evening stale / reconcile); not the applied shares valuation. */
export function fintualMappedGoalsApiSignature(resolutions: FintualGoalNavResolution[]): string {
  const parts: string[] = [];
  for (const r of resolutions) {
    if (!fintualGoalIsTracked(r.row)) continue;
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
