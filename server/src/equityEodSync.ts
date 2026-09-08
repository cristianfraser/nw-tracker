import { upsertEquityDailySeries, EQUITY_DAILY_IMPORT_TICKERS } from "./brokerageEquityMtm.js";
import {
  listWatchlistCryptoTickersForEodSync,
  listWatchlistNyseTickersForEodSync,
  listWatchlistSantiagoTickersForEodSync,
} from "./watchlist.js";
import {
  chileCalendarAddDays,
  chileWallClockAt,
  dateAtTimeZoneWallClock,
  type ChileWallClock,
} from "./chileDate.js";
import { db } from "./db.js";
import { equityMarketKind } from "./equityQuote.js";
import { fetchCoinGeckoRecentDailyCloses } from "./equityCoinGeckoEod.js";
import { fetchYahooNyseEodForSync, fetchYahooRecentDailyCloses, type EodCloseSeries } from "./equityYahooEod.js";
import { isChileBusinessDay, isNyseTradingDay, priorChileBusinessDayYmd } from "./marketHolidays.js";
import { isAfterNyseRegularClose, nyseSessionYmd, nyseWallClock, utcTodayYmd } from "./nyseSession.js";
import { clearEquityLiveQuoteCache } from "./equityQuote.js";

/** Evening crypto EOD sync window (America/Santiago). */
export const CRYPTO_EOD_SYNC_AFTER_HOUR_CHILE = 23;
export const CRYPTO_EOD_SYNC_AFTER_MINUTE_CHILE = 55;

const stmtLatestEodTradeDate = db.prepare(
  `SELECT trade_date FROM equity_daily WHERE ticker = ? ORDER BY trade_date DESC LIMIT 1`
);

export const EQUITY_CRYPTO_TICKERS = EQUITY_DAILY_IMPORT_TICKERS.filter(
  (t) => equityMarketKind(t) === "crypto24"
);

export function latestEquityEodTradeDate(ticker: string): string | null {
  const row = stmtLatestEodTradeDate.get(ticker) as { trade_date: string } | undefined;
  const d = row?.trade_date?.trim();
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

/** All NYSE account tickers have `equity_daily` through `sessionYmd`. */
export function equityNyseEodCaughtUp(sessionYmd: string): boolean {
  const tickers = listWatchlistNyseTickersForEodSync();
  if (tickers.length === 0) return true;
  return tickers.every((ticker) => {
    const latest = latestEquityEodTradeDate(ticker);
    return latest != null && latest >= sessionYmd;
  });
}

/** All Bolsa de Santiago account tickers have `equity_daily` through `chileYmd`. */
export function equitySantiagoEodCaughtUp(chileYmd: string): boolean {
  const tickers = listWatchlistSantiagoTickersForEodSync();
  if (tickers.length === 0) return true;
  return tickers.every((ticker) => {
    const latest = latestEquityEodTradeDate(ticker);
    return latest != null && latest >= chileYmd;
  });
}

/** All crypto import tickers have `equity_daily` through `utcYmd`. */
export function equityCryptoEodCaughtUp(utcYmd: string): boolean {
  return listWatchlistCryptoTickersForEodSync().every((ticker) => {
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

/**
 * Bolsa de Santiago EOD sync window (America/Santiago). The `.SN` live window in
 * `equityQuote.ts` ends at 17:05 and the resolver then reads the stored bar, so the day's bar
 * is due right after it.
 */
export const SANTIAGO_EOD_SYNC_AFTER_HOUR_CHILE = 17;
export const SANTIAGO_EOD_SYNC_AFTER_MINUTE_CHILE = 10;

export function isSantiagoEodSyncWindow(cl: ChileWallClock): boolean {
  return (
    cl.hour > SANTIAGO_EOD_SYNC_AFTER_HOUR_CHILE ||
    (cl.hour === SANTIAGO_EOD_SYNC_AFTER_HOUR_CHILE && cl.minute >= SANTIAGO_EOD_SYNC_AFTER_MINUTE_CHILE)
  );
}

/**
 * Chile business day whose Bolsa de Santiago EOD bar must be in `equity_daily` now: today from
 * 17:10 Chile, otherwise the last closed Chile session (carry-over — a missed evening stays due
 * through the night and across weekends / Chilean holidays until the bar lands). The NYSE
 * calendar plays no part: while `.SN` rode the `stocks_nyse` source, a US holiday that is a
 * Chilean business day (2026-09-07, Labor Day) left the day's close unsynced until the next
 * NYSE session, so the position sat on Friday's bar with a zero day change.
 */
export function equityEodSantiagoSyncDue(now: Date = new Date()): string | null {
  const cl = chileWallClockAt(now);
  if (isChileBusinessDay(cl.ymd) && isSantiagoEodSyncWindow(cl)) return cl.ymd;
  return priorChileBusinessDayYmd(cl.ymd);
}

export function isCryptoEodSyncWindow(cl: ChileWallClock): boolean {
  return (
    cl.hour > CRYPTO_EOD_SYNC_AFTER_HOUR_CHILE ||
    (cl.hour === CRYPTO_EOD_SYNC_AFTER_HOUR_CHILE && cl.minute >= CRYPTO_EOD_SYNC_AFTER_MINUTE_CHILE)
  );
}

/** UTC calendar day at a Chile wall-clock instant (not the due EOD close for that evening). */
export function utcYmdAtChileWallClock(chileYmd: string, hour: number, minute: number): string {
  const at = dateAtTimeZoneWallClock(chileYmd, hour, minute, "America/Santiago");
  return utcTodayYmd(at);
}

/** Last completed UTC calendar day relative to `now` (in-progress UTC day excluded). */
export function cryptoCompletedUtcYmd(now: Date = new Date()): string {
  return chileCalendarAddDays(utcTodayYmd(now), -1);
}

/**
 * UTC day whose crypto EOD must be in `equity_daily` now, or null if not due.
 * Due is always the last **completed** UTC day; never the in-progress UTC calendar day.
 */
export function cryptoEodDueUtcYmd(cl: ChileWallClock, now: Date = new Date()): string | null {
  if (isCryptoEodSyncWindow(cl)) return cryptoCompletedUtcYmd(now);
  const nowMins = cl.hour * 60 + cl.minute;
  const dueMins = CRYPTO_EOD_SYNC_AFTER_HOUR_CHILE * 60 + CRYPTO_EOD_SYNC_AFTER_MINUTE_CHILE;
  if (nowMins >= dueMins) return null;
  const prevChile = chileCalendarAddDays(cl.ymd, -1);
  const dueUtc = chileCalendarAddDays(
    utcYmdAtChileWallClock(prevChile, CRYPTO_EOD_SYNC_AFTER_HOUR_CHILE, CRYPTO_EOD_SYNC_AFTER_MINUTE_CHILE),
    -1
  );
  return equityCryptoEodCaughtUp(dueUtc) ? null : dueUtc;
}

/** Sync-log dates for crypto EOD: due bar and its UTC predecessor. */
export function cryptoEodChangeLogDates(dueUtcYmd: string): { oldDate: string; newDate: string } {
  return { oldDate: chileCalendarAddDays(dueUtcYmd, -1), newDate: dueUtcYmd };
}

/** Drop bars dated after `maxTradeDate` — an in-progress session must never be stored as a close. */
export function capEodSeriesToMaxTradeDate(series: EodCloseSeries, maxTradeDate: string): EodCloseSeries {
  const dates: string[] = [];
  const closes: number[] = [];
  for (let i = 0; i < series.dates.length; i++) {
    const d = series.dates[i]!;
    if (d > maxTradeDate) continue;
    dates.push(d);
    closes.push(series.closes[i]!);
  }
  return { dates, closes };
}

export type EquityEodSyncResult = {
  ticker: string;
  rows: number;
  skipped?: string;
  /** NYSE: last trade date returned by Yahoo (after meta enrichment). */
  yahooLatestDate?: string | null;
  /** NYSE: session whose EOD bar must be in DB. */
  dueSessionYmd?: string | null;
  /** NYSE: latest trade date in DB after upsert. */
  dbLatestDate?: string | null;
  /** NYSE: today's close came from chart meta, not a finalized daily bar. */
  usedMetaClose?: boolean;
  /** NYSE: due session still missing from DB after upsert. */
  stillMissingDueSession?: boolean;
};

/** Sync-log note when NYSE EOD fetch did not fully catch up. */
export function describeEquityNyseEodSyncNote(r: EquityEodSyncResult): string | null {
  if (r.skipped) return `${r.ticker}: skip (${r.skipped})`;
  if (r.usedMetaClose && r.dueSessionYmd) {
    return `${r.ticker}: chart meta close for ${r.dueSessionYmd}`;
  }
  if (r.stillMissingDueSession && r.dueSessionYmd) {
    const yahoo = r.yahooLatestDate ?? "—";
    const db = r.dbLatestDate ?? "—";
    return `${r.ticker}: still missing ${r.dueSessionYmd} (Yahoo ${yahoo}, DB ${db})`;
  }
  return null;
}

/** Drop in-progress UTC day bars from a daily series before crypto EOD upsert. */
export function capCryptoEodSeriesToCompletedUtcDay(series: EodCloseSeries, now: Date = new Date()): EodCloseSeries {
  return capEodSeriesToMaxTradeDate(series, cryptoCompletedUtcYmd(now));
}

/**
 * Upsert recent Yahoo daily closes into `equity_daily` for the given tickers.
 * NYSE tickers: only after 16:05 ET on NYSE trading days (unless `force`).
 * Santiago tickers: bars through the due Chile session (`equityEodSantiagoSyncDue`) — Yahoo's
 * daily series carries the in-progress bar during the session, so a forced run before the close
 * must not store it as that day's close.
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
      const dueSessionYmd = equityEodNyseSyncDue(now);
      if (dueSessionYmd == null) {
        out.push({ ticker, rows: 0, skipped: "nyse_session_not_due" });
        continue;
      }
      try {
        const fetch = await fetchYahooNyseEodForSync(ticker, { dueSessionYmd, now, days: 21 });
        const rows = dryRun ? fetch.series.dates.length : upsertEquityDailySeries(ticker, fetch.series);
        const dbLatestDate = latestEquityEodTradeDate(ticker);
        out.push({
          ticker,
          rows,
          yahooLatestDate: fetch.yahooLatestDate,
          dueSessionYmd: fetch.dueSessionYmd,
          usedMetaClose: fetch.usedMetaClose,
          dbLatestDate,
          stillMissingDueSession: dbLatestDate == null || dbLatestDate < dueSessionYmd,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        out.push({
          ticker,
          rows: 0,
          skipped: msg.slice(0, 120),
          dueSessionYmd,
          dbLatestDate: latestEquityEodTradeDate(ticker),
        });
      }
      continue;
    }

    if (kind === "santiago") {
      const dueSessionYmd = equityEodSantiagoSyncDue(now);
      if (dueSessionYmd == null) {
        out.push({ ticker, rows: 0, skipped: "santiago_session_not_due" });
        continue;
      }
      try {
        const series = capEodSeriesToMaxTradeDate(
          await fetchYahooRecentDailyCloses(ticker, 21),
          dueSessionYmd
        );
        const rows = dryRun ? series.dates.length : upsertEquityDailySeries(ticker, series);
        const dbLatestDate = latestEquityEodTradeDate(ticker);
        out.push({
          ticker,
          rows,
          yahooLatestDate: series.dates[series.dates.length - 1] ?? null,
          dueSessionYmd,
          dbLatestDate,
          stillMissingDueSession: dbLatestDate == null || dbLatestDate < dueSessionYmd,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        out.push({
          ticker,
          rows: 0,
          skipped: msg.slice(0, 120),
          dueSessionYmd,
          dbLatestDate: latestEquityEodTradeDate(ticker),
        });
      }
      continue;
    }

    try {
      let series = await fetchYahooRecentDailyCloses(ticker, 21);
      if (kind === "crypto24") series = capCryptoEodSeriesToCompletedUtcDay(series, now);
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

/** `stocks_nyse` source: NYSE-listed account tickers only (`.SN` has its own source below). */
export function syncStocksNyseFromYahoo(
  opts?: { dryRun?: boolean; now?: Date; force?: boolean }
): Promise<EquityEodSyncResult[]> {
  return syncEquityEodFromYahoo(listWatchlistNyseTickersForEodSync(), opts);
}

/** `stocks_santiago` source: Bolsa de Santiago tickers on the Chile calendar (`equityEodSantiagoSyncDue`). */
export function syncStocksSantiagoFromYahoo(
  opts?: { dryRun?: boolean; now?: Date; force?: boolean }
): Promise<EquityEodSyncResult[]> {
  return syncEquityEodFromYahoo(listWatchlistSantiagoTickersForEodSync(), opts);
}

/** Upsert recent CoinGecko daily USD closes into `equity_daily` for BTC-USD / ETH-USD. */
export async function syncCryptoEodFromCoinGecko(
  opts?: { dryRun?: boolean; now?: Date }
): Promise<EquityEodSyncResult[]> {
  const now = opts?.now ?? new Date();
  const dryRun = opts?.dryRun ?? false;
  const out: EquityEodSyncResult[] = [];

  for (const ticker of listWatchlistCryptoTickersForEodSync()) {
    try {
      let series = await fetchCoinGeckoRecentDailyCloses(ticker, 30);
      series = capCryptoEodSeriesToCompletedUtcDay(series, now);
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

/** Persisted NYSE session marker: only when all NYSE account tickers are caught up through that session. */
export function equityEodNyseStateYmd(now = new Date()): string | null {
  const due = equityEodNyseSyncDue(now);
  if (due != null) return equityNyseEodCaughtUp(due) ? due : null;
  const last = nyseSessionYmd(now);
  return equityNyseEodCaughtUp(last) ? last : null;
}

/** Persisted crypto UTC-day marker: only when BTC/ETH data are caught up through last completed UTC day. */
export function equityEodCryptoStateYmd(now = new Date()): string | null {
  const completed = cryptoCompletedUtcYmd(now);
  return equityCryptoEodCaughtUp(completed) ? completed : null;
}
