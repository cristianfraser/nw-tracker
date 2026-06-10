/**
 * Yahoo Finance CLP=X daily EOD → `fx_daily` (canonical USD/CLP for conversions).
 */
import { chileWallClockAt, type ChileWallClock } from "./chileDate.js";
import { fetchYahooDailyCloses, fetchYahooRecentDailyCloses } from "./equityYahooEod.js";
import { LIVE_FX_YAHOO_SYMBOL } from "./fxLive.js";
import { acceptYahooClpPerUsdClose } from "./fxYahooSanity.js";
import { clearYahooFxRejected, recordYahooFxRejected } from "./fxYahooRejectedDb.js";
import { nyseSessionYmd } from "./nyseSession.js";
import { portfolioStartYmd } from "./portfolioStart.js";
import { maxFxDateOnOrBefore, upsertFxRows } from "./sbifSyncDb.js";

/** Yahoo CLP=X EOD sync / stale window (America/Santiago). */
export const YAHOO_FX_EOD_SYNC_AFTER_HOUR_CHILE = 17;
export const YAHOO_FX_EOD_SYNC_AFTER_MINUTE_CHILE = 30;

export type FxYahooEodSyncResult = {
  rows: number;
  skipped?: string;
};

export function isYahooFxEodSyncWindow(cl: ChileWallClock): boolean {
  return (
    cl.hour > YAHOO_FX_EOD_SYNC_AFTER_HOUR_CHILE ||
    (cl.hour === YAHOO_FX_EOD_SYNC_AFTER_HOUR_CHILE && cl.minute >= YAHOO_FX_EOD_SYNC_AFTER_MINUTE_CHILE)
  );
}

/** True when `fx_daily` has Yahoo CLP=X EOD through the NYSE session currently due. */
export function yahooFxUsdCaughtUp(nyseSessionYmd: string): boolean {
  const latest = maxFxDateOnOrBefore(nyseSessionYmd);
  return latest != null && latest >= nyseSessionYmd;
}

/** NYSE session whose CLP=X EOD bar must be in `fx_daily` now (null before 17:30 Chile). */
export function yahooFxUsdSyncDue(now: Date = new Date()): string | null {
  const cl = chileWallClockAt(now);
  if (!isYahooFxEodSyncWindow(cl)) return null;
  return nyseSessionYmd(now);
}

export function isYahooFxUsdStale(opts?: { force?: boolean; now?: Date }): boolean {
  if (opts?.force) return true;
  const now = opts?.now ?? new Date();
  const due = yahooFxUsdSyncDue(now);
  if (due != null && !yahooFxUsdCaughtUp(due)) return true;
  return false;
}

export type YahooFxIngestResult = {
  accepted: { date: string; clpPerUsd: number }[];
  rejected: { date: string; rawClpPerUsd: number; reason: string }[];
};

/** Filter Yahoo CLP=X series; optionally persist rejections and remove bad fx_daily rows. */
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
 * Upsert recent Yahoo CLP=X daily closes into `fx_daily`.
 * Only from 17:30 Chile unless `force`.
 */
export async function syncYahooFxUsdFromYahoo(opts?: {
  dryRun?: boolean;
  now?: Date;
  force?: boolean;
}): Promise<FxYahooEodSyncResult> {
  const now = opts?.now ?? new Date();
  const dryRun = opts?.dryRun ?? false;
  const force = opts?.force ?? false;

  if (!force && !isYahooFxEodSyncWindow(chileWallClockAt(now))) {
    return { rows: 0, skipped: "before_yahoo_fx_sync_window" };
  }

  const series = await fetchYahooRecentDailyCloses(LIVE_FX_YAHOO_SYMBOL, 21);
  const { accepted } = ingestYahooFxSeries(series, { dryRun });
  const n = dryRun ? accepted.length : upsertFxRows(accepted, false);
  return { rows: n };
}

/** Full-history backfill helper: fetch Yahoo CLP=X EOD for [period1Sec, period2Sec]. */
export async function fetchYahooFxUsdDailyCloses(
  period1Sec: number,
  period2Sec: number
): Promise<{ date: string; clpPerUsd: number }[]> {
  const series = await fetchYahooDailyCloses(LIVE_FX_YAHOO_SYMBOL, period1Sec, period2Sec);
  return ingestYahooFxSeries(series).accepted;
}
