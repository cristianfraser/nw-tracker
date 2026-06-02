import { upsertEquityDailySeries, EQUITY_DAILY_IMPORT_TICKERS } from "./brokerageEquityMtm.js";
import { listNyseEquityTickersForEodSync } from "./accountEquityTicker.js";
import { chileCalendarAddDays, dateAtTimeZoneWallClock, type ChileWallClock } from "./chileDate.js";
import { db } from "./db.js";
import { equityMarketKind } from "./equityQuote.js";
import { fetchYahooRecentDailyCloses } from "./equityYahooEod.js";
import { isNyseTradingDay } from "./marketHolidays.js";
import { isAfterNyseRegularClose, nyseSessionYmd, nyseWallClock, utcTodayYmd } from "./nyseSession.js";
import { clearEquityLiveQuoteCache } from "./equityQuote.js";

/** Evening crypto EOD sync window (America/Santiago). */
export const CRYPTO_EOD_SYNC_AFTER_HOUR_CHILE = 23;
export const CRYPTO_EOD_SYNC_AFTER_MINUTE_CHILE = 55;

/** Stock EOD buckets by exchange calendar (extend when adding exchanges). */
export const STOCK_EOD_EXCHANGES = ["nyse"] as const;
export type StockEodExchange = (typeof STOCK_EOD_EXCHANGES)[number];

const stmtLatestEodTradeDate = db.prepare(
  `SELECT trade_date FROM equity_daily WHERE ticker = ? ORDER BY trade_date DESC LIMIT 1`
);

export const EQUITY_NYSE_TICKERS = EQUITY_DAILY_IMPORT_TICKERS.filter(
  (t) => equityMarketKind(t) === "nyse"
);
export const EQUITY_CRYPTO_TICKERS = EQUITY_DAILY_IMPORT_TICKERS.filter(
  (t) => equityMarketKind(t) === "crypto24"
);

export function latestEquityEodTradeDate(ticker: string): string | null {
  const row = stmtLatestEodTradeDate.get(ticker) as { trade_date: string } | undefined;
  const d = row?.trade_date?.trim();
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

/** All NYSE import tickers have `equity_daily` through `sessionYmd`. */
export function equityNyseEodCaughtUp(sessionYmd: string): boolean {
  return EQUITY_NYSE_TICKERS.every((ticker) => {
    const latest = latestEquityEodTradeDate(ticker);
    return latest != null && latest >= sessionYmd;
  });
}

/** All crypto import tickers have `equity_daily` through `utcYmd`. */
export function equityCryptoEodCaughtUp(utcYmd: string): boolean {
  return EQUITY_CRYPTO_TICKERS.every((ticker) => {
    const latest = latestEquityEodTradeDate(ticker);
    return latest != null && latest >= utcYmd;
  });
}

/**
 * NYSE session whose EOD bar must be in DB now (null before 16:05 ET or on NYSE holidays/weekends).
 */
export function equityEodNyseSyncDue(now: Date = new Date()): string | null {
  const ny = nyseWallClock(now);
  if (!isNyseTradingDay(ny.ymd)) return null;
  if (!isAfterNyseRegularClose(now)) return null;
  return nyseSessionYmd(now);
}

export function isCryptoEodSyncWindow(cl: ChileWallClock): boolean {
  return (
    cl.hour > CRYPTO_EOD_SYNC_AFTER_HOUR_CHILE ||
    (cl.hour === CRYPTO_EOD_SYNC_AFTER_HOUR_CHILE && cl.minute >= CRYPTO_EOD_SYNC_AFTER_MINUTE_CHILE)
  );
}

/** UTC calendar day whose EOD was due at 23:55 Chile on `chileYmd`. */
export function utcYmdAtChileWallClock(chileYmd: string, hour: number, minute: number): string {
  const at = dateAtTimeZoneWallClock(chileYmd, hour, minute, "America/Santiago");
  return utcTodayYmd(at);
}

/**
 * UTC day whose crypto EOD must be in `equity_daily` now, or null if not due.
 * After 23:55 Chile, due is today's UTC day; before 23:55, may carry over yesterday's window.
 */
/**
 * Sync-log dates for crypto EOD.
 * - Evening window (23:55 Chile): due is today's UTC day; log the prior UTC bar and its predecessor.
 * - Carryover before 23:55: due is the missing UTC day; log that bar and its predecessor.
 */
export function cryptoEodChangeLogDates(
  dueUtcYmd: string,
  opts?: { inSyncWindow?: boolean }
): { oldDate: string; newDate: string } {
  const newDate =
    opts?.inSyncWindow === false ? dueUtcYmd : chileCalendarAddDays(dueUtcYmd, -1);
  const oldDate = chileCalendarAddDays(newDate, -1);
  return { oldDate, newDate };
}

export function cryptoEodDueUtcYmd(cl: ChileWallClock, now: Date = new Date()): string | null {
  if (isCryptoEodSyncWindow(cl)) return utcTodayYmd(now);
  const nowMins = cl.hour * 60 + cl.minute;
  const dueMins = CRYPTO_EOD_SYNC_AFTER_HOUR_CHILE * 60 + CRYPTO_EOD_SYNC_AFTER_MINUTE_CHILE;
  if (nowMins >= dueMins) return null;
  const prevChile = chileCalendarAddDays(cl.ymd, -1);
  const dueUtc = utcYmdAtChileWallClock(
    prevChile,
    CRYPTO_EOD_SYNC_AFTER_HOUR_CHILE,
    CRYPTO_EOD_SYNC_AFTER_MINUTE_CHILE
  );
  return equityCryptoEodCaughtUp(dueUtc) ? null : dueUtc;
}

export type EquityEodSyncResult = {
  ticker: string;
  rows: number;
  skipped?: string;
};

/**
 * Upsert recent Yahoo daily closes into `equity_daily` for the given tickers.
 * NYSE tickers: only after 16:05 ET on NYSE trading days (unless `force`).
 */
export async function syncEquityEodFromYahoo(
  tickers: readonly string[],
  opts?: { dryRun?: boolean; now?: Date; force?: boolean }
): Promise<EquityEodSyncResult[]> {
  const now = opts?.now ?? new Date();
  const dryRun = opts?.dryRun ?? false;
  const force = opts?.force ?? false;
  const out: EquityEodSyncResult[] = [];

  for (const ticker of tickers) {
    const kind = equityMarketKind(ticker);
    if (kind === "nyse") {
      const ny = nyseWallClock(now);
      if (!isNyseTradingDay(ny.ymd)) {
        out.push({ ticker, rows: 0, skipped: "nyse_holiday_or_weekend" });
        continue;
      }
      if (!force && !isAfterNyseRegularClose(now)) {
        out.push({ ticker, rows: 0, skipped: "before_nyse_close" });
        continue;
      }
    }

    try {
      const series = await fetchYahooRecentDailyCloses(ticker, 21);
      const rows = dryRun ? series.dates.length : upsertEquityDailySeries(ticker, series);
      out.push({ ticker, rows });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      out.push({ ticker, rows: 0, skipped: msg.slice(0, 120) });
    }
  }

  if (!dryRun) clearEquityLiveQuoteCache();
  return out;
}

export function syncStocksNyseFromYahoo(
  opts?: { dryRun?: boolean; now?: Date; force?: boolean }
): Promise<EquityEodSyncResult[]> {
  return syncEquityEodFromYahoo(listNyseEquityTickersForEodSync(), opts);
}

export function syncCryptoEodFromYahoo(
  opts?: { dryRun?: boolean; now?: Date; force?: boolean }
): Promise<EquityEodSyncResult[]> {
  return syncEquityEodFromYahoo(EQUITY_CRYPTO_TICKERS, opts);
}

/** NYSE session date to record in sync state after a successful NYSE EOD pull. */
export function equityEodSyncSessionLabel(now = new Date()): {
  nyseSession: string | null;
  cryptoUtcDay: string;
} {
  const ny = nyseWallClock(now);
  return {
    nyseSession: isNyseTradingDay(ny.ymd) ? nyseSessionYmd(now) : null,
    cryptoUtcDay: utcTodayYmd(now),
  };
}

/** Persisted NYSE session marker: only when SPY/VEA data are caught up through that session. */
export function equityEodNyseStateYmd(now = new Date()): string | null {
  const due = equityEodNyseSyncDue(now);
  if (due != null) return equityNyseEodCaughtUp(due) ? due : null;
  const last = nyseSessionYmd(now);
  return equityNyseEodCaughtUp(last) ? last : null;
}

/** Persisted crypto UTC-day marker: only when BTC/ETH data are caught up through today (UTC). */
export function equityEodCryptoStateYmd(now = new Date()): string | null {
  const utc = utcTodayYmd(now);
  return equityCryptoEodCaughtUp(utc) ? utc : null;
}
