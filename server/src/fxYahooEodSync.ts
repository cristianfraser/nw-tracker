/**
 * Yahoo Finance CLP=X → `fx_daily` (canonical USD/CLP for conversions), one row per weekday.
 *
 * A row is the rate at the fx day end (17:05 New York, `forexDay.ts`) and is written ONCE: the
 * sync runs right after the day ends and stores Yahoo's current quote — the value the live
 * readers froze on — so the evening view, the next morning's history point and the daily P/L
 * agree. Yahoo's own daily bars (whose close is the London-midnight open rather than the day's
 * last print, and which disagree with its intraday feed by up to ~0,3%) only fill days that were
 * never observed (machine asleep at the day end) and never overwrite an existing row.
 */
import {
  fetchYahooDailyCloses,
  fetchYahooRecentDailyClosesWithMeta,
  yahooBarYmdFromUnix,
  type EodCloseSeries,
} from "./equityYahooEod.js";
import { fxDayDueYmd } from "./forexDay.js";
import { LIVE_FX_YAHOO_SYMBOL } from "./fxLive.js";
import { acceptYahooClpPerUsdClose } from "./fxYahooSanity.js";
import { clearYahooFxRejected, recordYahooFxRejected } from "./fxYahooRejectedDb.js";
import { isWeekendYmd } from "./marketHolidays.js";
import { portfolioStartYmd } from "./portfolioStart.js";
import { insertFxRowsIfMissing, maxFxDateOnOrBefore } from "./sbifSyncDb.js";

export type FxYahooEodSyncResult = {
  rows: number;
  skipped?: string;
  /** The due day's row came from the chart's current quote — no daily bar carried that date yet. */
  used_meta_quote?: boolean;
};

/** True when `fx_daily` has a row on or after the due Chile day. */
export function yahooFxUsdCaughtUp(dueYmd: string): boolean {
  const latest = maxFxDateOnOrBefore(dueYmd);
  return latest != null && latest >= dueYmd;
}

/** Chile day whose fx close must be in `fx_daily` now (`fxDayDueYmd`, carry-over included). */
export function yahooFxUsdSyncDue(now: Date = new Date()): string {
  return fxDayDueYmd(now);
}

export function isYahooFxUsdStale(opts?: { force?: boolean; now?: Date }): boolean {
  if (opts?.force) return true;
  const now = opts?.now ?? new Date();
  return !yahooFxUsdCaughtUp(yahooFxUsdSyncDue(now));
}

export type YahooFxIngestResult = {
  accepted: { date: string; clpPerUsd: number }[];
  rejected: { date: string; rawClpPerUsd: number; reason: string }[];
};

/**
 * Filter a Yahoo CLP=X series: weekday dates only (Yahoo labels its Monday week-open bar by the
 * New York date of the bar start, i.e. Sunday), from portfolio start, sanity-checked against the
 * previous accepted print; rejections are persisted unless `dryRun`.
 */
export function ingestYahooFxSeries(
  series: { dates: string[]; closes: number[] },
  opts?: { dryRun?: boolean }
): YahooFxIngestResult {
  const anchor = portfolioStartYmd();
  const dryRun = opts?.dryRun ?? false;
  const accepted: { date: string; clpPerUsd: number }[] = [];
  const rejected: { date: string; rawClpPerUsd: number; reason: string }[] = [];
  let prevAccepted: number | null = null;

  for (let i = 0; i < series.dates.length; i++) {
    const date = series.dates[i]!;
    const clpPerUsd = series.closes[i]!;
    if (date < anchor) continue;
    if (isWeekendYmd(date)) continue;

    const sanity = acceptYahooClpPerUsdClose(clpPerUsd, prevAccepted);
    if (!sanity.ok) {
      rejected.push({ date, rawClpPerUsd: clpPerUsd, reason: sanity.reason });
      if (!dryRun) recordYahooFxRejected(date, clpPerUsd, sanity.reason);
      continue;
    }

    accepted.push({ date, clpPerUsd });
    if (!dryRun) clearYahooFxRejected(date);
    prevAccepted = clpPerUsd;
  }

  return { accepted, rejected };
}

/**
 * When the daily series has no bar for the due day, the chart `meta` quote stands in if it was
 * printed on that day — right after the fx day end the current bar can lag the quote, and
 * overnight it disappears while `regularMarketTime` still points at the day's last print.
 */
export function fxSeriesWithMetaForDue(
  series: EodCloseSeries,
  meta: { regularMarketPrice?: number; regularMarketTime?: number } | undefined,
  dueYmd: string
): { series: EodCloseSeries; usedMetaQuote: boolean } {
  if (series.dates.includes(dueYmd)) return { series, usedMetaQuote: false };
  const price = meta?.regularMarketPrice;
  const rt = meta?.regularMarketTime;
  if (price == null || !Number.isFinite(price) || price <= 0 || rt == null || !Number.isFinite(rt)) {
    return { series, usedMetaQuote: false };
  }
  if (yahooBarYmdFromUnix(LIVE_FX_YAHOO_SYMBOL, rt) !== dueYmd) return { series, usedMetaQuote: false };
  return {
    series: { dates: [...series.dates, dueYmd], closes: [...series.closes, price] },
    usedMetaQuote: true,
  };
}

/**
 * Insert the fx rows still missing from `fx_daily` for the recent window — the due day's close
 * first of all. Existing rows are never revised (see the module comment).
 */
export async function syncYahooFxUsdFromYahoo(opts?: {
  dryRun?: boolean;
  now?: Date;
}): Promise<FxYahooEodSyncResult> {
  const now = opts?.now ?? new Date();
  const dryRun = opts?.dryRun ?? false;
  const due = yahooFxUsdSyncDue(now);

  const fetched = await fetchYahooRecentDailyClosesWithMeta(LIVE_FX_YAHOO_SYMBOL, 21);
  const { series, usedMetaQuote } = fxSeriesWithMetaForDue(fetched.series, fetched.meta, due);
  const { accepted } = ingestYahooFxSeries(series, { dryRun });
  const n = dryRun ? accepted.length : insertFxRowsIfMissing(accepted);
  return { rows: n, used_meta_quote: usedMetaQuote };
}

/** Full-history backfill helper: fetch Yahoo CLP=X daily bars for [period1Sec, period2Sec]. */
export async function fetchYahooFxUsdDailyCloses(
  period1Sec: number,
  period2Sec: number
): Promise<{ date: string; clpPerUsd: number }[]> {
  const series = await fetchYahooDailyCloses(LIVE_FX_YAHOO_SYMBOL, period1Sec, period2Sec);
  return ingestYahooFxSeries(series).accepted;
}
