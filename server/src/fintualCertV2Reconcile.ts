/**
 * Evening Fintual poll: goals API balance vs certificado cuotas × fund_unit_daily must agree
 * before we treat v2 accounts as settled (a v2 bar is only ever written from a Fintual publish price).
 */
import { db } from "./db.js";
import {
  FINTUAL_CERT_V2_ACCOUNT_NAMES,
  FINTUAL_CERT_V2_GOAL_IDS,
  matchFintualCertGoalV2,
} from "./fintualCertV2.js";
import { fintualGoalUnitsFromMovements } from "./fintualGoalUnits.js";
import {
  fundSeriesKeyFromImportNotes,
  isFintualCertV2ValuationNotes,
  isFintualPublishedFundUnitNote,
} from "./fintualFundUnitDaily.js";
import { fintualExpectsCuotaOnPollDay } from "./fintualPublishDate.js";
import { latestFundUnitRow } from "./fundUnitDaily.js";
import type { ChileWallClock } from "./chileDate.js";
import type { GlobalSyncStateFile } from "./globalSyncState.js";
import { loadGlobalSyncState } from "./globalSyncState.js";

/** Max |goals API − cuotas×cuota| (CLP) before v2 is treated as unreconciled. */
export const FINTUAL_CERT_V2_RECONCILE_TOLERANCE_CLP = 1000;

const stmtFundUnitOnDay = db.prepare(
  `SELECT unit_value_clp, note FROM fund_unit_daily WHERE series_key = ? AND day = ?`
);
const stmtDeleteFundUnitOnDay = db.prepare(
  `DELETE FROM fund_unit_daily WHERE series_key = ? AND day = ?`
);

/** Parse `fintualMappedNavSignature` payload (`goalId:navClp|…`). */
export function parseFintualMappedNavSignature(sig: string | null | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!sig?.trim()) return out;
  for (const part of sig.split("|")) {
    const i = part.indexOf(":");
    if (i <= 0) continue;
    const goalId = part.slice(0, i).trim();
    const nav = Number(part.slice(i + 1));
    if (!goalId || !Number.isFinite(nav)) continue;
    out.set(goalId, Math.round(nav));
  }
  return out;
}

/** Fintual goal id for a v2 `import:fintual|cert|key=…` account, if mapped. */
export function fintualCertV2GoalIdForImportNotes(importNotes: string): string | null {
  for (const [goalId, notes] of Object.entries(FINTUAL_CERT_V2_GOAL_IDS)) {
    if (notes === importNotes) return goalId;
  }
  return null;
}

/** Latest polled goals API NAV for a v2 account (from global sync signature). */
export function fintualGoalsApiNavClpForImportNotes(
  importNotes: string,
  state: GlobalSyncStateFile = loadGlobalSyncState()
): number | null {
  const goalId = fintualCertV2GoalIdForImportNotes(importNotes);
  if (!goalId) return null;
  const sig = state.fintualLastCheckSig ?? state.fintualLastAppliedSig;
  const nav = parseFintualMappedNavSignature(sig).get(goalId);
  return nav != null && Number.isFinite(nav) ? nav : null;
}

/**
 * Chile day the goals NAV read by {@link fintualGoalsApiNavClpForImportNotes} was last polled —
 * mirrors that function's `fintualLastCheckSig ?? fintualLastAppliedSig` selection so the day
 * matches the signature the NAV came from. Null when never polled.
 */
export function fintualGoalsApiPollYmdForState(
  state: GlobalSyncStateFile = loadGlobalSyncState()
): string | null {
  return state.fintualLastCheckSig != null
    ? state.fintualLastCheckYmd ?? null
    : state.fintualLastAppliedYmd ?? null;
}

export function fintualCertV2PositionFromCuotaClp(
  accountId: number,
  importNotes: string,
  asOfYmd: string
): number | null {
  if (!isFintualCertV2ValuationNotes(importNotes)) return null;
  const seriesKey = fundSeriesKeyFromImportNotes(importNotes);
  if (!seriesKey) return null;
  const units = fintualGoalUnitsFromMovements(accountId);
  if (units == null || units <= 0) return null;
  const row = stmtFundUnitOnDay.get(seriesKey, asOfYmd) as
    | { unit_value_clp: number; note: string }
    | undefined;
  if (row?.unit_value_clp == null || !Number.isFinite(row.unit_value_clp) || row.unit_value_clp <= 0) {
    return null;
  }
  return Math.round(units * row.unit_value_clp);
}

export function fintualCertV2GoalsCuotaReconciled(opts: {
  goalsNavClp: number;
  cuotaPositionClp: number;
  toleranceClp?: number;
}): boolean {
  const tol = opts.toleranceClp ?? FINTUAL_CERT_V2_RECONCILE_TOLERANCE_CLP;
  return Math.abs(opts.goalsNavClp - opts.cuotaPositionClp) <= tol;
}

/** Dashboard mark when goals API and cuota position diverge (prefer goals balance). */
export function fintualCertV2PreferGoalsNavDisplay(opts: {
  goalsNavClp: number | null;
  cuotaPositionClp: number | null;
  asOfYmd: string;
  todayYmd: string;
  /** Chile day the goals NAV was last polled (see {@link fintualGoalsApiPollYmdForState}). */
  lastGoalsPollYmd?: string | null;
  /** Newest `occurred_on` of a cuota-changing movement on the account (null when none). */
  newestLocalCuotaFlowYmd?: string | null;
  /**
   * The goals NAV equals the position at an OLDER stored cuota (see
   * {@link fintualGoalsNavMatchesPriorPublishPosition}) — it lags the newest publish rather than
   * disagreeing with it, so the local cuota position is the fresher truth.
   */
  navMatchesPriorPublishPosition?: boolean;
}): boolean {
  if (opts.asOfYmd !== opts.todayYmd) return false;
  if (opts.goalsNavClp == null || opts.cuotaPositionClp == null) return false;
  // A local cuota-changing flow dated strictly after the last goals poll cannot be reflected in
  // that NAV yet, so the divergence is our own unsynced edit — trust the local cuota position
  // until the next Fintual sync re-polls. Same-day flows stay NAV-preferred (the evening poll
  // reflects Fintual's real same-day balance).
  if (
    opts.newestLocalCuotaFlowYmd != null &&
    opts.lastGoalsPollYmd != null &&
    opts.newestLocalCuotaFlowYmd > opts.lastGoalsPollYmd
  ) {
    return false;
  }
  if (opts.navMatchesPriorPublishPosition) return false;
  return !fintualCertV2GoalsCuotaReconciled({
    goalsNavClp: opts.goalsNavClp,
    cuotaPositionClp: opts.cuotaPositionClp,
  });
}

const stmtRecentFundUnitsBeforeDay = db.prepare(
  `SELECT day, unit_value_clp FROM fund_unit_daily
   WHERE series_key = ? AND day < ?
   ORDER BY day DESC LIMIT 7`
);

/**
 * The polled goals NAV reproduces (within tolerance) the account's position at a stored cuota
 * OLDER than the newest bar — i.e. Fintual's goals endpoint has not rolled to the fund's newest
 * publish yet (it lags the fund publish by hours). Such a NAV is stale, not divergent: displaying it
 * would show yesterday's balance with a phantom day P/L against the fresher cuotas × px.
 */
export function fintualGoalsNavMatchesPriorPublishPosition(
  accountId: number,
  importNotes: string,
  goalsNavClp: number | null | undefined
): boolean {
  if (goalsNavClp == null || !Number.isFinite(goalsNavClp)) return false;
  if (!isFintualCertV2ValuationNotes(importNotes)) return false;
  const seriesKey = fundSeriesKeyFromImportNotes(importNotes);
  if (!seriesKey) return false;
  const units = fintualGoalUnitsFromMovements(accountId);
  if (units == null || units <= 1e-9) return false;
  const latest = latestFundUnitRow(seriesKey);
  if (!latest) return false;
  const rows = stmtRecentFundUnitsBeforeDay.all(seriesKey, latest.day) as {
    day: string;
    unit_value_clp: number;
  }[];
  for (const row of rows) {
    if (!(row.unit_value_clp > 0)) continue;
    const pos = Math.round(units * row.unit_value_clp);
    if (Math.abs(goalsNavClp - pos) <= FINTUAL_CERT_V2_RECONCILE_TOLERANCE_CLP) return true;
  }
  return false;
}

/**
 * A held v2 fund (cuotas > 0) whose `fund_unit_daily` series has not reached the publish day:
 * no bar on the day AND no newer bar either — the fund's cuota for that day has not been
 * recorded, e.g. it publishes later in the evening than the faster funds that already satisfied
 * the global publish-day hints (Very Conservative Streep, 2026-08-24). Interior historical gaps
 * (older days a later bar superseded) do not count — nothing left for a re-poll to heal there.
 */
export function fintualCertV2HeldFundMissingDayRow(
  accountId: number,
  importNotes: string,
  asOfYmd: string
): boolean {
  if (!isFintualCertV2ValuationNotes(importNotes)) return false;
  const seriesKey = fundSeriesKeyFromImportNotes(importNotes);
  if (!seriesKey) return false;
  const units = fintualGoalUnitsFromMovements(accountId);
  if (units == null || units <= 1e-9) return false;
  const row = stmtFundUnitOnDay.get(seriesKey, asOfYmd) as
    | { unit_value_clp: number; note: string }
    | undefined;
  if (row?.unit_value_clp != null && Number.isFinite(row.unit_value_clp) && row.unit_value_clp > 0) {
    return false;
  }
  const latest = latestFundUnitRow(seriesKey);
  return latest == null || latest.day < asOfYmd;
}

export function fintualCertV2AccountReconciledOnDay(
  accountId: number,
  importNotes: string,
  asOfYmd: string,
  goalsNavClp: number | null | undefined
): boolean {
  if (goalsNavClp == null || !Number.isFinite(goalsNavClp)) return true;
  // Missing publish-day bar on a held fund is NOT vacuously reconciled — it is exactly the
  // late-publish gap the poll loop must keep retrying for.
  if (fintualCertV2HeldFundMissingDayRow(accountId, importNotes, asOfYmd)) return false;
  const cuotaPos = fintualCertV2PositionFromCuotaClp(accountId, importNotes, asOfYmd);
  if (cuotaPos == null) return true;
  return fintualCertV2GoalsCuotaReconciled({ goalsNavClp, cuotaPositionClp: cuotaPos });
}

/**
 * Before 18:00 Chile: yesterday's poll evening left a held fund without its publish-day bar
 * (per-fund late publish the sig/publish-date caught-up checks cannot see) — keep the source
 * stale so the morning carry re-polls and lands the value the fund published overnight.
 * Missing-bar driven only (NAV mismatches are the evening machinery's business), and vacuously
 * resolved when no mapped v2 account exists. Bounded: `fintualLastPublishYmd` advances at the
 * next evening poll, so a fund that truly never publishes a day stops being demanded once the
 * publish day moves on.
 */
export function fintualMorningCarryPerFundUnresolved(
  cl: ChileWallClock,
  state: GlobalSyncStateFile
): boolean {
  if (cl.hour >= 18) return false;
  const pollYmd = state.fintualLastCheckYmd;
  if (!pollYmd || pollYmd >= cl.ymd) return false;
  if (!fintualExpectsCuotaOnPollDay(pollYmd)) return false;
  const publishYmd = state.fintualLastPublishYmd ?? pollYmd;
  return fintualCertV2AnyHeldFundMissingDayRow(publishYmd, state);
}

/** Any mapped held v2 fund is still missing its `publishYmd` bar (see the per-account check). */
export function fintualCertV2AnyHeldFundMissingDayRow(
  publishYmd: string,
  state: GlobalSyncStateFile = loadGlobalSyncState()
): boolean {
  const goalsById = parseFintualMappedNavSignature(
    state.fintualLastCheckSig ?? state.fintualLastAppliedSig
  );
  if (goalsById.size === 0) return false;
  const accStmt = db.prepare(`SELECT id FROM accounts WHERE import_key = ?`);
  for (const [goalId, importNotes] of Object.entries(FINTUAL_CERT_V2_GOAL_IDS)) {
    if (goalsById.get(goalId) == null) continue;
    const acc = accStmt.get(importNotes) as { id: number } | undefined;
    if (!acc) continue;
    if (fintualCertV2HeldFundMissingDayRow(acc.id, importNotes, publishYmd)) return true;
  }
  return false;
}

/** All mapped v2 cert accounts reconcile goals API vs cuotas×cuota on `publishYmd`. */
export function fintualCertV2PollReconciled(
  publishYmd: string,
  state: GlobalSyncStateFile = loadGlobalSyncState()
): boolean {
  const goalsById = parseFintualMappedNavSignature(
    state.fintualLastCheckSig ?? state.fintualLastAppliedSig
  );
  if (goalsById.size === 0) return true;

  const accStmt = db.prepare(`SELECT id, notes FROM accounts WHERE import_key = ?`);
  let checked = 0;
  for (const [goalId, importNotes] of Object.entries(FINTUAL_CERT_V2_GOAL_IDS)) {
    const goalsNav = goalsById.get(goalId);
    if (goalsNav == null) continue;
    const acc = accStmt.get(importNotes) as { id: number; notes: string } | undefined;
    if (!acc) continue;
    if (!fintualCertV2AccountReconciledOnDay(acc.id, importNotes, publishYmd, goalsNav)) {
      return false;
    }
    checked += 1;
  }
  return checked > 0;
}

export type FintualCertV2ReconcileRow = {
  goalId: string;
  goalName: string;
  importNotes: string;
  accountId: number;
  goalsNavClp: number;
  cuotaPositionClp: number | null;
  unitClp: number | null;
  reconciled: boolean;
};

export function listFintualCertV2ReconcileRows(
  publishYmd: string,
  state: GlobalSyncStateFile = loadGlobalSyncState()
): FintualCertV2ReconcileRow[] {
  const goalsById = parseFintualMappedNavSignature(
    state.fintualLastCheckSig ?? state.fintualLastAppliedSig
  );
  const accStmt = db.prepare(`SELECT id FROM accounts WHERE import_key = ?`);
  const out: FintualCertV2ReconcileRow[] = [];
  for (const [goalId, importNotes] of Object.entries(FINTUAL_CERT_V2_GOAL_IDS)) {
    const goalsNav = goalsById.get(goalId);
    if (goalsNav == null) continue;
    const acc = accStmt.get(importNotes) as { id: number } | undefined;
    if (!acc) continue;
    const seriesKey = fundSeriesKeyFromImportNotes(importNotes);
    const unitRow =
      seriesKey != null
        ? (stmtFundUnitOnDay.get(seriesKey, publishYmd) as
            | { unit_value_clp: number; note: string }
            | undefined)
        : undefined;
    const cuotaPos = fintualCertV2PositionFromCuotaClp(acc.id, importNotes, publishYmd);
    out.push({
      goalId,
      goalName: FINTUAL_CERT_V2_ACCOUNT_NAMES[importNotes] ?? goalId,
      importNotes,
      accountId: acc.id,
      goalsNavClp: goalsNav,
      cuotaPositionClp: cuotaPos,
      unitClp: unitRow?.unit_value_clp ?? null,
      reconciled: fintualCertV2AccountReconciledOnDay(acc.id, importNotes, publishYmd, goalsNav),
    });
  }
  return out;
}

/** Drop inferred fund_unit rows that disagree with goals API (goals balance lagging cuota publish). */
export function cleanupUnreconciledFintualCertFundUnits(
  publishYmd: string,
  goalsNavByGoalId: Map<string, number>,
  dryRun: boolean
): number {
  const accStmt = db.prepare(`SELECT id FROM accounts WHERE import_key = ?`);
  let removed = 0;
  for (const [goalId, importNotes] of Object.entries(FINTUAL_CERT_V2_GOAL_IDS)) {
    const goalsNav = goalsNavByGoalId.get(goalId);
    if (goalsNav == null) continue;
    const acc = accStmt.get(importNotes) as { id: number } | undefined;
    if (!acc) continue;
    if (fintualCertV2AccountReconciledOnDay(acc.id, importNotes, publishYmd, goalsNav)) continue;

    const seriesKey = fundSeriesKeyFromImportNotes(importNotes);
    if (!seriesKey) continue;
    const row = stmtFundUnitOnDay.get(seriesKey, publishYmd) as
      | { unit_value_clp: number; note: string }
      | undefined;
    if (row == null) continue;
    if (isFintualPublishedFundUnitNote(row.note)) continue;
    if (!dryRun) stmtDeleteFundUnitOnDay.run(seriesKey, publishYmd);
    removed += 1;
  }
  return removed;
}

/** Goal id from evening poll row (v2 map or legacy matched notes). */
export function fintualGoalIdFromPollRow(goal: {
  id: number | string;
  name: string;
  matchedNotes: string | null;
}): string {
  return String(goal.id);
}

export function fintualGoalsNavFromResolution(
  resolution: { goalsApiNavClp: number } | undefined,
  goalNavClp: number
): number {
  return resolution?.goalsApiNavClp ?? goalNavClp;
}

export function matchFintualCertGoalV2ForPoll(goal: {
  id: number | string;
  name: string;
  matchedNotes: string | null;
}): string | null {
  return matchFintualCertGoalV2(String(goal.id), goal.name);
}
