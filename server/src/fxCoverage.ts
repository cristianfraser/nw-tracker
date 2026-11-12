import { monthEndsBetweenInclusive } from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { listYahooFxRejectedAsc } from "./fxYahooRejectedDb.js";
import { portfolioStartYmd } from "./portfolioStart.js";
import type { FxConversionWarning } from "./fxConversionWarnings.js";
import { takeFxConversionWarnings } from "./fxConversionWarnings.js";
import {
  conversionPairs,
  isCurrencyCode,
  pairHasStoredQuote,
  pairStoredDates,
  type DisplayUnitCode,
  type RatePair,
} from "./rates.js";

/** Minimum daily rows expected after a daily backfill (~252 sessions/year). */
const SPARSE_DAILY_MIN = 500;

/** One rate pair the display unit walks, and how well its stored rows cover the portfolio. */
export type FxCoveragePair = {
  base: string;
  quote: string;
  complete: boolean;
  first_missing_date: string | null;
  missing_count: number;
  fx_min: string | null;
  fx_max: string | null;
  /** Rows that are not calendar month-ends (daily observations). */
  daily_count: number;
  row_count: number;
  /** True when daily history is thin or the largest gap exceeds 7 days. */
  is_sparse: boolean;
  max_gap_days: number;
};

export type FxCoverage = {
  /** The display unit the coverage was checked for. */
  unit: DisplayUnitCode;
  /** Every pair a conversion into `unit` walks (`rates.ts`), from each currency the portfolio holds. */
  pairs: FxCoveragePair[];
  /** Every pair complete and none sparse. */
  complete: boolean;
  /** The earliest missing date over the pairs. */
  first_missing_date: string | null;
  missing_count: number;
  is_sparse: boolean;
  /** Yahoo CLP=X bars rejected at ingest (only when USD/CLP is walked). */
  yahoo_rejected: { date: string; raw_clp_per_usd: number; reason: string }[];
  /** FX rate fallbacks / reference CLP conversions during this payload build. */
  conversion_warnings: FxConversionWarning[];
};

const selHeldCurrencies = db.prepare(
  `SELECT currency AS code FROM movements
   UNION SELECT counter_currency FROM movements WHERE counter_currency IS NOT NULL
   UNION SELECT currency FROM valuations`
);

/** The currencies the portfolio holds or moves (pesos and dollars always). */
function heldCurrencies(): string[] {
  const codes = new Set<string>(["clp", "usd"]);
  for (const r of selHeldCurrencies.all() as { code: string | null }[]) {
    if (r.code && isCurrencyCode(r.code)) codes.add(r.code);
  }
  return [...codes].sort();
}

/** The distinct pairs converting every held currency into `unit` walks, in a stable order. */
export function fxCoveragePairsForUnit(unit: DisplayUnitCode): RatePair[] {
  const byKey = new Map<string, RatePair>();
  for (const code of heldCurrencies()) {
    if (code === unit) continue;
    for (const p of conversionPairs(code, unit)) byKey.set(`${p.base}/${p.quote}`, p);
  }
  return [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, p]) => p);
}

function isMonthEnd(ymd: string): boolean {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.getUTCDate() === 1;
}

function pairCoverage(p: RatePair, start: string, datesToCheck: readonly string[]): FxCoveragePair {
  const dates = pairStoredDates(p);
  let maxGap = 0;
  let daily = 0;
  for (let i = 0; i < dates.length; i++) {
    if (!isMonthEnd(dates[i]!)) daily++;
    if (i === 0) continue;
    const prev = new Date(`${dates[i - 1]!}T12:00:00Z`).getTime();
    const cur = new Date(`${dates[i]!}T12:00:00Z`).getTime();
    const gap = Math.round((cur - prev) / 86_400_000);
    if (gap > maxGap) maxGap = gap;
  }
  const stats = {
    fx_min: dates[0] ?? null,
    fx_max: dates[dates.length - 1] ?? null,
    row_count: dates.length,
    daily_count: daily,
    max_gap_days: maxGap,
  };
  if (dates.length === 0) {
    return {
      base: p.base,
      quote: p.quote,
      complete: false,
      first_missing_date: start,
      missing_count: 1,
      ...stats,
      is_sparse: true,
    };
  }
  const is_sparse = daily < SPARSE_DAILY_MIN || maxGap > 7;
  let first_missing_date: string | null = null;
  let missing_count = 0;
  for (const d of datesToCheck) {
    if (!pairHasStoredQuote(p, d)) {
      missing_count++;
      if (first_missing_date == null) first_missing_date = d;
    }
  }
  return {
    base: p.base,
    quote: p.quote,
    complete: missing_count === 0 && !is_sparse,
    first_missing_date,
    missing_count,
    ...stats,
    is_sparse,
  };
}

/**
 * Whether the stored rates cover the portfolio's month-ends and today for every pair a
 * conversion into `unit` walks (each held currency → `unit`, through `rates.ts`).
 */
export function buildFxCoverage(unit: DisplayUnitCode): FxCoverage {
  const start = portfolioStartYmd();
  const today = chileCalendarTodayYmd();
  const datesToCheck = [...new Set([...monthEndsBetweenInclusive(start, today), today])].sort();
  const pairs = fxCoveragePairsForUnit(unit).map((p) => pairCoverage(p, start, datesToCheck));
  const firstMissing = pairs
    .map((p) => p.first_missing_date)
    .filter((d): d is string => d != null)
    .sort()[0];
  const walksUsdClp = pairs.some((p) => p.base === "usd" && p.quote === "clp");
  return {
    unit,
    pairs,
    complete: pairs.every((p) => p.complete),
    first_missing_date: firstMissing ?? null,
    missing_count: pairs.reduce((s, p) => s + p.missing_count, 0),
    is_sparse: pairs.some((p) => p.is_sparse),
    yahoo_rejected: walksUsdClp ? listYahooFxRejectedForCoverage() : [],
    conversion_warnings: [],
  };
}

/** `buildFxCoverage()` plus conversion warnings collected since last `clearFxConversionWarnings()`. */
export function buildFxCoverageWithConversionWarnings(unit: DisplayUnitCode): FxCoverage {
  return {
    ...buildFxCoverage(unit),
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
