/**
 * Append Fintual goal NAV polls to `fund_unit_daily` (marquee, rates charts).
 */
import { db } from "./db.js";
import { fintualGoalUnitsFromMovements } from "./fintualGoalUnits.js";
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

/** Resolve valor cuota: publish price (evening API) → implied from history → NAV ÷ Σ cuotas bootstrap. */
export function resolveFintualUnitClp(opts: {
  accountId: number;
  seriesKey: string;
  navClp: number;
  asOfYmd: string;
  fundPriceClp?: number | null;
  units?: number | null;
}): number | null {
  if (
    opts.fundPriceClp != null &&
    Number.isFinite(opts.fundPriceClp) &&
    opts.fundPriceClp > 0
  ) {
    return Math.round(opts.fundPriceClp * 10000) / 10000;
  }

  const implied = impliedFintualUnitClpFromNav(
    opts.accountId,
    opts.seriesKey,
    opts.navClp,
    opts.asOfYmd
  );
  if (implied != null && implied > 0) return implied;

  let shares = opts.units;
  if (shares == null || !Number.isFinite(shares) || shares <= 0) {
    shares = fintualGoalUnitsFromMovements(opts.accountId);
  }
  if (shares != null && shares > 0 && Number.isFinite(opts.navClp) && opts.navClp > 0) {
    return Math.round((opts.navClp / shares) * 10000) / 10000;
  }

  return null;
}

export function recordFintualGoalFundUnitDaily(opts: {
  accountId: number;
  importNotes: string;
  asOfYmd: string;
  navClp: number;
  dryRun: boolean;
  fundPriceClp?: number | null;
  units?: number | null;
}): { recorded: boolean; unitClp: number | null; gapDaysFilled: number } {
  const seriesKey = fundSeriesKeyFromImportNotes(opts.importNotes);
  if (!seriesKey) return { recorded: false, unitClp: null, gapDaysFilled: 0 };

  const unitClp = resolveFintualUnitClp({
    accountId: opts.accountId,
    seriesKey,
    navClp: opts.navClp,
    asOfYmd: opts.asOfYmd,
    fundPriceClp: opts.fundPriceClp,
    units: opts.units,
  });
  if (unitClp == null || unitClp <= 0) {
    return { recorded: false, unitClp: null, gapDaysFilled: 0 };
  }

  const note =
    opts.fundPriceClp != null && opts.fundPriceClp > 0
      ? `fintual:real_assets:publish|${opts.importNotes}`
      : `fintual:api:goal-nav|${opts.importNotes}`;

  const { gapDaysFilled } = upsertFundUnitSpotPreservingHistory({
    seriesKey,
    observationDay: opts.asOfYmd,
    unitValueClp: unitClp,
    note,
    carryNote: "fintual:carry-forward",
    dryRun: opts.dryRun,
  });

  return { recorded: true, unitClp, gapDaysFilled };
}
