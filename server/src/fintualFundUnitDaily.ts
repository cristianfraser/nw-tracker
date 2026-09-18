import { assertValuationCurrencyClp } from "./valuationValue.js";
/**
 * Append Fintual goal NAV polls to `fund_unit_daily` (marquee, rates charts).
 */
import { fundSeriesKeyForAccount, fundSeriesKeyFromImportNotes } from "./accountFundSeriesKey.js";
import { db } from "./db.js";
import { isFintualCertV2AccountNotes } from "./fintualCertV2.js";

export { fundSeriesKeyFromImportNotes } from "./accountFundSeriesKey.js";
import { fintualGoalUnitsFromMovements } from "./fintualGoalUnits.js";
import { latestFundUnitRow, upsertFundUnitSpotPreservingHistory } from "./fundUnitDaily.js";
import type { FintualCertificadoAggregateScan } from "./fintualCertificadoTransacciones.js";
import type { GoalToImportNote } from "./fintualCertificadoTransacciones.js";

export function isFintualCertV2ValuationNotes(importNotes: string | null | undefined): boolean {
  return isFintualCertV2AccountNotes(importNotes);
}

function latestValuationClp(accountId: number, onOrBefore: string): number | null {
  const r = db
    .prepare(
      `SELECT value AS value_clp, currency FROM valuations
       WHERE account_id = ? AND as_of_date <= ? AND value > 0
       ORDER BY as_of_date DESC LIMIT 1`
    )
    .get(accountId, onOrBefore) as { value_clp: number; currency: string } | undefined;
  if (r) assertValuationCurrencyClp(r.currency, "fintualFundUnitDaily");
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

/**
 * Max relative step for an inferred (non-publish) valor cuota vs the last stored bar. A goals NAV
 * net of a pending retiro whose cuotas are still local would otherwise bootstrap a wildly wrong
 * cuota that then self-reconciles — refuse and stay unresolved until a real publish arrives.
 */
export const FINTUAL_INFERRED_UNIT_MAX_REL_STEP = 0.05;

function inferredUnitWithinBand(seriesKey: string, candidate: number): boolean {
  const prev = latestFundUnitRow(seriesKey);
  if (!prev || !(prev.unit_value_clp > 0)) return true; // first-ever bar: nothing to compare
  return Math.abs(candidate / prev.unit_value_clp - 1) <= FINTUAL_INFERRED_UNIT_MAX_REL_STEP;
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
  if (implied != null && implied > 0) {
    if (!inferredUnitWithinBand(opts.seriesKey, implied)) {
      console.warn(
        `fintual: refusing implied valor cuota ${implied} for ${opts.seriesKey} (out of ±${FINTUAL_INFERRED_UNIT_MAX_REL_STEP * 100}% band vs last bar)`
      );
      return null;
    }
    return implied;
  }

  let shares = opts.units;
  if (shares == null || !Number.isFinite(shares) || shares <= 0) {
    shares = fintualGoalUnitsFromMovements(opts.accountId);
  }
  if (shares != null && shares > 0 && Number.isFinite(opts.navClp) && opts.navClp > 0) {
    const bootstrap = Math.round((opts.navClp / shares) * 10000) / 10000;
    if (!inferredUnitWithinBand(opts.seriesKey, bootstrap)) {
      console.warn(
        `fintual: refusing NAV÷cuotas bootstrap ${bootstrap} for ${opts.seriesKey} (out of ±${FINTUAL_INFERRED_UNIT_MAX_REL_STEP * 100}% band vs last bar)`
      );
      return null;
    }
    return bootstrap;
  }

  return null;
}

/**
 * Provenance note prefixes of a REAL published cuota. Carries and the unreconciled-inferred
 * cleanup never touch these; the official-serie verifier (`fintualPublicSeriePrice.ts`)
 * corrects them only beyond its tolerance.
 * - `fintual:real_assets:publish` — the retired `GET /api/real_assets/:id` price (≤ 2026-09-14)
 *   and the one-day graph ÷ ledger-cuotas derivation that replaced it (2026-09-16/17 bars).
 * - `fintual:gql:shares-publish` — evening `/gql/` accrued balance: valuation ÷ Fintual's shares.
 * - `fintual:public-serie:publish` — the official public serie price (next-day verifier).
 */
export const FINTUAL_PUBLISHED_FUND_UNIT_NOTE_PREFIXES = [
  "fintual:real_assets:publish",
  "fintual:gql:shares-publish",
  "fintual:public-serie:publish",
] as const;

export const FINTUAL_GQL_SHARES_PUBLISH_NOTE_PREFIX = "fintual:gql:shares-publish";

export function isFintualPublishedFundUnitNote(note: string | null | undefined): boolean {
  if (!note) return false;
  return FINTUAL_PUBLISHED_FUND_UNIT_NOTE_PREFIXES.some(
    (prefix) => note === prefix || note.startsWith(`${prefix}|`)
  );
}

/** Placeholder rows a later observation may overwrite (the previous bar carried across a gap). */
export const FINTUAL_CARRY_FORWARD_NOTES: ReadonlySet<string> = new Set([
  "fintual:carry-forward",
  "fintual:cert-carry-forward",
  "spot:carry-forward",
]);

export function isFintualCarryForwardFundUnitNote(note: string | null | undefined): boolean {
  return note != null && FINTUAL_CARRY_FORWARD_NOTES.has(note);
}

export function recordFintualGoalFundUnitDaily(opts: {
  accountId: number;
  importNotes: string;
  asOfYmd: string;
  navClp: number;
  dryRun: boolean;
  /** Valor cuota from Fintual's own share count (evening `/gql/` accrued balance). */
  fundPriceClp?: number | null;
  units?: number | null;
}): { recorded: boolean; unitClp: number | null; gapDaysFilled: number } {
  const seriesKey =
    fundSeriesKeyForAccount(opts.accountId) ?? fundSeriesKeyFromImportNotes(opts.importNotes);
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

  const isPublish = opts.fundPriceClp != null && opts.fundPriceClp > 0;
  const note = isPublish
    ? `${FINTUAL_GQL_SHARES_PUBLISH_NOTE_PREFIX}|${opts.importNotes}`
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

export function backfillFintualCertValorCuotaFromScan(
  scan: FintualCertificadoAggregateScan,
  matchGoal: GoalToImportNote,
  dryRun: boolean
): number {
  let n = 0;
  for (const a of scan.sortedAggregates) {
    const importNote = matchGoal(a.goalId, a.name);
    if (!importNote || !isFintualCertV2AccountNotes(importNote)) continue;
    const seriesKey = fundSeriesKeyFromImportNotes(importNote);
    const vq = a.valorCuotaHint;
    if (!seriesKey || vq == null || !(vq > 0)) continue;
    if (!dryRun) {
      upsertFundUnitSpotPreservingHistory({
        seriesKey,
        observationDay: a.ymd,
        unitValueClp: Math.round(vq * 10000) / 10000,
        note: `fintual:certificado|${importNote}`,
        carryNote: "fintual:cert-carry-forward",
        dryRun: false,
      });
    }
    n += 1;
  }
  return n;
}
