import { monthEndsBetweenInclusive } from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { listYahooFxRejectedAsc } from "./fxYahooRejectedDb.js";
import { fxMonthEndForBalanceUsd, fxRowOnOrBefore } from "./fxRates.js";
import { portfolioStartYmd } from "./portfolioStart.js";
import type { FxConversionWarning } from "./fxConversionWarnings.js";
import { takeFxConversionWarnings } from "./fxConversionWarnings.js";

/** Minimum daily rows expected after Yahoo CLP=X EOD backfill (~252 NYSE sessions/year). */
const SPARSE_DAILY_MIN = 500;

export type FxCoverage = {
  complete: boolean;
  first_missing_date: string | null;
  missing_count: number;
  fx_min: string | null;
  fx_max: string | null;
  /** Rows that are not calendar month-ends (Yahoo CLP=X EOD daily bars). */
  daily_count: number;
  row_count: number;
  /** True when daily history is thin or largest gap exceeds 7 days. */
  is_sparse: boolean;
  max_gap_days: number;
  /** Yahoo CLP=X bars rejected at ingest (conversions use prior good fx_daily row). */
  yahoo_rejected: { date: string; raw_clp_per_usd: number; reason: string }[];
  /** FX rate fallbacks / reference CLP conversions during this payload build. */
  conversion_warnings: FxConversionWarning[];
};

function fxDailyStats(): {
  fx_min: string | null;
  fx_max: string | null;
  daily_count: number;
  row_count: number;
  max_gap_days: number;
} {
  const bounds = db
    .prepare(`SELECT MIN(date) AS fx_min, MAX(date) AS fx_max, COUNT(*) AS row_count FROM fx_daily`)
    .get() as { fx_min: string | null; fx_max: string | null; row_count: number };
  const daily = db
    .prepare(
      `SELECT COUNT(*) AS c FROM fx_daily
       WHERE date != date(date, 'start of month', '+1 month', '-1 day')`
    )
    .get() as { c: number };

  let maxGap = 0;
  const dates = db
    .prepare(`SELECT date FROM fx_daily ORDER BY date ASC`)
    .all() as { date: string }[];
  for (let i = 1; i < dates.length; i++) {
    const prev = new Date(`${dates[i - 1]!.date}T12:00:00Z`).getTime();
    const cur = new Date(`${dates[i]!.date}T12:00:00Z`).getTime();
    const gap = Math.round((cur - prev) / 86_400_000);
    if (gap > maxGap) maxGap = gap;
  }

  return {
    fx_min: bounds.fx_min,
    fx_max: bounds.fx_max,
    row_count: bounds.row_count,
    daily_count: daily.c,
    max_gap_days: maxGap,
  };
}

/** Whether `fx_daily` covers portfolio month-ends + today for USD balance conversion. */
export function buildFxCoverage(): FxCoverage {
  const stats = fxDailyStats();
  const is_sparse =
    stats.row_count === 0 ||
    stats.daily_count < SPARSE_DAILY_MIN ||
    stats.max_gap_days > 7;

  if (stats.row_count === 0) {
    return {
      complete: false,
      first_missing_date: portfolioStartYmd(),
      missing_count: 1,
      ...stats,
      is_sparse: true,
      yahoo_rejected: listYahooFxRejectedForCoverage(),
      conversion_warnings: [],
    };
  }

  const start = portfolioStartYmd();
  const today = chileCalendarTodayYmd();
  const datesToCheck = [...new Set([...monthEndsBetweenInclusive(start, today), today])].sort();

  let first_missing_date: string | null = null;
  let missing_count = 0;
  for (const d of datesToCheck) {
    if (fxMonthEndForBalanceUsd(d) == null) {
      missing_count++;
      if (first_missing_date == null) first_missing_date = d;
    }
  }

  return {
    complete: missing_count === 0 && !is_sparse,
    first_missing_date,
    missing_count,
    ...stats,
    is_sparse,
    yahoo_rejected: listYahooFxRejectedForCoverage(),
    conversion_warnings: [],
  };
}

/** `buildFxCoverage()` plus conversion warnings collected since last `clearFxConversionWarnings()`. */
export function buildFxCoverageWithConversionWarnings(): FxCoverage {
  return {
    ...buildFxCoverage(),
    conversion_warnings: takeFxConversionWarnings(),
  };
}

function listYahooFxRejectedForCoverage(): { date: string; raw_clp_per_usd: number; reason: string }[] {
  return listYahooFxRejectedAsc().map((r) => ({
    date: r.date,
    raw_clp_per_usd: r.raw_clp_per_usd,
    reason: r.reason,
  }));
}

/** True when any non-zero deposit event lacks FX on or before its date. */
export function depositEventsMissingFx(eventDatesWithClp: readonly { occurred_on: string; clp: number }[]): boolean {
  for (const e of eventDatesWithClp) {
    if (!Number.isFinite(e.clp) || e.clp === 0) continue;
    const fx = fxRowOnOrBefore(e.occurred_on);
    if (!fx || fx.clp_per_usd <= 0) return true;
  }
  return false;
}
