import { priorPeriodEndYmd } from "./accountPeriodMarks.js";

/**
 * Anchor-date arithmetic shared by the watchlist stats and the composite proxy (a leaf
 * module, so neither has to import the other for it). Every change column of the watchlist
 * — and the marquee day chip, which is the same `day` leg — compares the current value with
 * the series' value on or before one of these dates.
 */
export const WATCHLIST_ANCHOR_KEYS = ["week", "mtd", "mom", "ytd", "yoy", "y3", "y5", "y10"] as const;
export type WatchlistAnchorKey = (typeof WATCHLIST_ANCHOR_KEYS)[number];
export type WatchlistAnchorYmds = Record<WatchlistAnchorKey, string | null>;

function yearsPriorYmd(todayYmd: string, years: number): string {
  const y = Number(todayYmd.slice(0, 4));
  return `${y - years}${todayYmd.slice(4)}`;
}

export function yoyAnchorYmd(todayYmd: string): string {
  return yearsPriorYmd(todayYmd, 1);
}

/** Same calendar day one month earlier (UTC date arithmetic; clamps e.g. Mar 31 → Feb 28/29). */
function calendarMonthsPriorYmd(ymd: string, months: number): string {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7));
  const d = Number(ymd.slice(8, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    throw new Error(`Invalid YMD: ${ymd}`);
  }
  const dt = new Date(Date.UTC(y, m - 1 - months, d));
  return dt.toISOString().slice(0, 10);
}

/**
 * The eight change anchors for a series whose latest observation is `asOf`: the week anchor
 * is the caller's (five NYSE sessions back for NYSE tickers, seven calendar days otherwise),
 * MTD/YTD are the prior period ends of Chile today, MoM is one calendar month before the
 * observation, and YoY/3y/5y/10y are the same calendar day N years before today.
 */
export function watchlistAnchorYmds(today: string, asOf: string, weekYmd: string | null): WatchlistAnchorYmds {
  return {
    week: weekYmd,
    mtd: priorPeriodEndYmd("mtd", today),
    mom: calendarMonthsPriorYmd(asOf, 1),
    ytd: priorPeriodEndYmd("ytd", today),
    yoy: yoyAnchorYmd(today),
    y3: yearsPriorYmd(today, 3),
    y5: yearsPriorYmd(today, 5),
    y10: yearsPriorYmd(today, 10),
  };
}
