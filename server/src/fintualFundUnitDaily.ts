/**
 * Append Fintual goal NAV polls to `fund_unit_daily` when we can infer a share price.
 */
import { db } from "./db.js";
import { latestFundUnitRow, upsertFundUnitSpotPreservingHistory } from "./fundUnitDaily.js";

/** `import:excel|key=…` → rates chart series key. */
export function fundSeriesKeyFromImportNotes(importNotes: string): string | null {
  const key = importNotes.match(/import:excel\|key=([\w_]+)/)?.[1];
  if (!key) return null;
  switch (key) {
    case "fintual_rn":
      return "fintual_risky_norris";
    case "apv_a":
      return "fintual_risky_norris_apv";
    default:
      return null;
  }
}

function latestValuationClp(accountId: number, onOrBefore: string): number | null {
  const r = db
    .prepare(
      `SELECT value_clp FROM valuations
       WHERE account_id = ? AND as_of_date <= ? AND value_clp > 0
       ORDER BY as_of_date DESC LIMIT 1`
    )
    .get(accountId, onOrBefore) as { value_clp: number } | undefined;
  const v = r?.value_clp;
  return v != null && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Implied valor cuota ≈ goal NAV ÷ shares, with shares from last (valuation ÷ unit) pair.
 * Returns null on first observation when we cannot anchor shares.
 */
export function impliedFintualUnitClpFromNav(
  accountId: number,
  seriesKey: string,
  navClp: number,
  asOfYmd: string
): number | null {
  const prevUnit = latestFundUnitRow(seriesKey);
  if (!prevUnit) return null;
  const val = latestValuationClp(accountId, asOfYmd);
  if (val == null || val <= 0) return null;
  const shares = val / prevUnit.unit_value_clp;
  if (!Number.isFinite(shares) || shares <= 1e-9) return null;
  return Math.round((navClp / shares) * 10000) / 10000;
}

export function recordFintualGoalFundUnitDaily(opts: {
  accountId: number;
  importNotes: string;
  asOfYmd: string;
  navClp: number;
  dryRun: boolean;
}): { recorded: boolean; unitClp: number | null; gapDaysFilled: number } {
  const seriesKey = fundSeriesKeyFromImportNotes(opts.importNotes);
  if (!seriesKey) return { recorded: false, unitClp: null, gapDaysFilled: 0 };

  const unitClp = impliedFintualUnitClpFromNav(opts.accountId, seriesKey, opts.navClp, opts.asOfYmd);
  if (unitClp == null || unitClp <= 0) {
    return { recorded: false, unitClp: null, gapDaysFilled: 0 };
  }

  const { gapDaysFilled } = upsertFundUnitSpotPreservingHistory({
    seriesKey,
    observationDay: opts.asOfYmd,
    unitValueClp: unitClp,
    note: `fintual:api:goal-nav|${opts.importNotes}`,
    carryNote: "fintual:carry-forward",
    dryRun: opts.dryRun,
  });

  return { recorded: true, unitClp, gapDaysFilled };
}
