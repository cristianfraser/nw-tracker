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

/** Upsert Yahoo daily history when DB series does not reach YoY/YTD anchors. */
export async function ensureEquityDailyHistoryForWatchlist(
  ticker: string,
  todayYmd: string = chileCalendarTodayYmd()
): Promise<void> {
  const sym = ticker.trim().toUpperCase();
  if (!sym) return;

  const needBy = watchlistEquityHistoryNeedByYmd(todayYmd);
  const earliest = equityEarliestEodYmd(sym);
  if (earliest != null && earliest <= needBy) return;

  try {
    const series = await fetchYahooRecentDailyCloses(sym, WATCHLIST_EQUITY_HISTORY_DAYS);
    upsertEquityDailySeries(sym, series);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("HTTP 404")) return;
    throw e;
  }
}

export async function ensureEquityDailyHistoryForWatchlistTickers(
  tickers: readonly string[],
  todayYmd: string = chileCalendarTodayYmd()
): Promise<void> {
  const uniq = [...new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean))];
  for (const ticker of uniq) {
    await ensureEquityDailyHistoryForWatchlist(ticker, todayYmd);
  }
}
