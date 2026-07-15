import { upsertEquityDailySeries } from "./brokerageEquityMtm.js";
import { priorPeriodEndYmd } from "./accountPeriodMarks.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { fetchYahooRecentDailyCloses } from "./equityYahooEod.js";

/** Calendar lookback for watchlist YTD/YoY anchors (≈14 months). */
export const WATCHLIST_EQUITY_HISTORY_DAYS = 400;

const stmtEarliestEod = db.prepare(
  `SELECT MIN(trade_date) AS min_d FROM equity_daily WHERE ticker = ?`
);

function yoyAnchorYmd(todayYmd: string): string {
  const y = Number(todayYmd.slice(0, 4));
  return `${y - 1}${todayYmd.slice(4)}`;
}

/** Oldest anchor date watchlist stats need for one equity ticker. */
export function watchlistEquityHistoryNeedByYmd(todayYmd: string = chileCalendarTodayYmd()): string {
  const yoy = yoyAnchorYmd(todayYmd);
  const ytd = priorPeriodEndYmd("ytd", todayYmd);
  return yoy < ytd ? yoy : ytd;
}

export function equityEarliestEodYmd(ticker: string): string | null {
  const row = stmtEarliestEod.get(ticker.toUpperCase()) as { min_d: string | null } | undefined;
  const d = row?.min_d?.trim();
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

/**
 * One Yahoo history attempt per ticker per Chile day: a ticker whose Yahoo history simply
 * does not reach the anchor (recent IPO, thin `.SN` coverage) would otherwise re-fetch on
 * every scheduler tick — the DB can never satisfy `earliest <= needBy` for it.
 */
const historyAttemptYmdByTicker = new Map<string, string>();

/**
 * Upsert Yahoo daily history when DB series does not reach YoY/YTD anchors.
 * Returns true when a fetch+upsert happened. Scheduler/script context only — HTTP
 * handlers read `equity_daily` as-is and never trigger Yahoo fetches.
 */
export async function ensureEquityDailyHistoryForWatchlist(
  ticker: string,
  todayYmd: string = chileCalendarTodayYmd()
): Promise<boolean> {
  const sym = ticker.trim().toUpperCase();
  if (!sym) return false;

  const needBy = watchlistEquityHistoryNeedByYmd(todayYmd);
  const earliest = equityEarliestEodYmd(sym);
  if (earliest != null && earliest <= needBy) return false;
  if (historyAttemptYmdByTicker.get(sym) === todayYmd) return false;
  historyAttemptYmdByTicker.set(sym, todayYmd);

  try {
    const series = await fetchYahooRecentDailyCloses(sym, WATCHLIST_EQUITY_HISTORY_DAYS);
    upsertEquityDailySeries(sym, series);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("HTTP 404")) return false;
    throw e;
  }
}

/** Returns how many tickers got a Yahoo history backfill (0 = everything already deep enough). */
export async function ensureEquityDailyHistoryForWatchlistTickers(
  tickers: readonly string[],
  todayYmd: string = chileCalendarTodayYmd()
): Promise<number> {
  const uniq = [...new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean))];
  let backfilled = 0;
  for (const ticker of uniq) {
    if (await ensureEquityDailyHistoryForWatchlist(ticker, todayYmd)) backfilled++;
  }
  return backfilled;
}
