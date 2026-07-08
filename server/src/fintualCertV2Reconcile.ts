/**
 * Evening Fintual poll: goals API balance vs certificado cuotas × fund_unit_daily must agree
 * before we treat v2 accounts as settled or write inferred cuotas without real_assets publish.
 */
import { db } from "./db.js";
import {
  FINTUAL_CERT_V2_ACCOUNT_NAMES,
  FINTUAL_CERT_V2_GOAL_IDS,
  matchFintualCertGoalV2,
} from "./fintualCertV2.js";
import { fintualGoalUnitsFromMovements } from "./fintualGoalUnits.js";
import { fundSeriesKeyFromImportNotes, isFintualCertV2ValuationNotes } from "./fintualFundUnitDaily.js";
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
  return !fintualCertV2GoalsCuotaReconciled({
    goalsNavClp: opts.goalsNavClp,
    cuotaPositionClp: opts.cuotaPositionClp,
  });
}

export function fintualCertV2AccountReconciledOnDay(
  accountId: number,
  importNotes: string,
  asOfYmd: string,
  goalsNavClp: number | null | undefined
): boolean {
  if (goalsNavClp == null || !Number.isFinite(goalsNavClp)) return true;
  const cuotaPos = fintualCertV2PositionFromCuotaClp(accountId, importNotes, asOfYmd);
  if (cuotaPos == null) return true;
  return fintualCertV2GoalsCuotaReconciled({ goalsNavClp, cuotaPositionClp: cuotaPos });
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

  const accStmt = db.prepare(`SELECT id, notes FROM accounts WHERE notes = ?`);
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
  const accStmt = db.prepare(`SELECT id FROM accounts WHERE notes = ?`);
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
      reconciled:
        cuotaPos == null ||
        fintualCertV2GoalsCuotaReconciled({ goalsNavClp: goalsNav, cuotaPositionClp: cuotaPos }),
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
  const accStmt = db.prepare(`SELECT id FROM accounts WHERE notes = ?`);
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
    if (row.note.includes("real_assets:publish")) continue;
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
