import { listWatchlistEquitySeriesKeys, syncWatchlistFromApp } from "./watchlist.js";
import { chileCalendarTodayYmd, chileWallClockAt } from "./chileDate.js";
import { db } from "./db.js";
import { equityMarketKind, marketQuoteCurrency } from "./equityQuote.js";
import { fetchYahooLiveQuote, yahooBarYmdFromUnix } from "./equityYahooEod.js";
import { fetchYahooLiveUsdClpPerUsd, LIVE_FX_YAHOO_SYMBOL, shouldUseLiveFxQuote } from "./fxLive.js";
import { syncYahooFxUsdFromYahoo, yahooFxUsdSyncDue } from "./fxYahooEodSync.js";
import { priorNyseSessionYmd } from "./marketHolidays.js";
import { publishLiveInputChange } from "./cacheRegistry.js";
import { recordYahooSplits } from "./equitySplitsSync.js";
import { listEquitySplits, splitLikeMoveError } from "./equitySplits.js";
import {
  getLatestLiveEquityQuoteRow,
  getLatestLiveFxQuoteRow,
  insertLiveMarketQuote,
  pruneLiveMarketQuotes,
} from "./liveMarketQuotesDb.js";
import { LIVE_FX_SYMBOL } from "./liveMarketQuotesConfig.js";
import { maxFxDateOnOrBefore } from "./sbifSyncDb.js";
import { fxRowOnOrBefore } from "./fxRates.js";
import {
  clearMarketSymbolFetchError,
  recordMarketSymbolFetchError,
  reloadMarketSymbols,
} from "./marketSymbols.js";

const stmtEodPrior = db.prepare(
  `SELECT close FROM equity_daily WHERE ticker = ? AND trade_date < ? ORDER BY trade_date DESC LIMIT 1`
);
const stmtEodOnDate = db.prepare(
  `SELECT close FROM equity_daily WHERE ticker = ? AND trade_date = ?`
);

export type LiveQuoteSyncTickerResult = {
  ticker: string;
  ok: boolean;
  /** True when this poll changed the effective quote (new value, or no fresh row existed). */
  changed?: boolean;
  error?: string;
};

export type LiveMarketQuotesSyncResult = {
  equities: LiveQuoteSyncTickerResult[];
  fx: { ok: boolean; rows: number; changed: boolean; error?: string };
  pruned: number;
  /** True when any quote/fx value changed — dashboard aggregation caches were invalidated. */
  values_changed: boolean;
};

/** Effective-quote change: no fresh prior row (readers were on EOD fallback) or a new value. */
function quoteValueChanged(prev: { value: number } | null, nextValue: number): boolean {
  return prev == null || prev.value !== nextValue;
}

function equityTickersForLiveSync(): string[] {
  syncWatchlistFromApp();
  return listWatchlistEquitySeriesKeys();
}

function priorCloseForLiveNyse(
  ticker: string,
  sessionYmd: string,
  yahooPrior: number | null
): number | null {
  if (yahooPrior != null && Number.isFinite(yahooPrior) && yahooPrior > 0) {
    return yahooPrior;
  }
  const priorYmd = priorNyseSessionYmd(sessionYmd);
  if (priorYmd == null) return null;
  const row = stmtEodOnDate.get(ticker, priorYmd) as { close: number } | undefined;
  if (row != null && Number.isFinite(row.close)) return row.close;
  return (stmtEodPrior.get(ticker, sessionYmd) as { close: number } | undefined)?.close ?? null;
}

function priorCloseForLiveNonSession(
  ticker: string,
  sessionYmd: string,
  yahooPrior: number | null
): number | null {
  if (yahooPrior != null && Number.isFinite(yahooPrior) && yahooPrior > 0) {
    return yahooPrior;
  }
  return (stmtEodPrior.get(ticker, sessionYmd) as { close: number } | undefined)?.close ?? null;
}

type LiveEquityObservation = {
  price: number;
  /** The source's previous close, or null to read it from the stored closes. */
  previous_close: number | null;
  session_ymd: string;
};

const stmtEodPriorRow = db.prepare(
  `SELECT trade_date, close FROM equity_daily WHERE ticker = ? AND trade_date < ? ORDER BY trade_date DESC LIMIT 1`
);

/**
 * Stores one equity observation; true when it changed the effective quote. A price that moves
 * like a split nobody recorded (×1.6 or more from the previous stored close, which is
 * split-adjusted) throws instead: valued against the old share count it would read as a crash
 * (SOXX 2026-11-05, a 3-for-1 Yahoo did not list). The readers keep the previous close.
 */
function writeEquityLiveQuote(ticker: string, live: LiveEquityObservation, fetchedAt: string): boolean {
  const kind = equityMarketKind(ticker);
  const ref = stmtEodPriorRow.get(ticker, live.session_ymd) as { trade_date: string; close: number } | undefined;
  if (ref) {
    const err = splitLikeMoveError(ticker, live.session_ymd, live.price, { ymd: ref.trade_date, close: ref.close });
    if (err) throw new Error(err);
  }
  // On a split's ex-date the source's previous close may still be pre-split: read the stored one.
  const yahooPrior = listEquitySplits(ticker).some((s) => s.ex_date === live.session_ymd) ? null : live.previous_close;
  const prior =
    kind === "nyse"
      ? priorCloseForLiveNyse(ticker, live.session_ymd, yahooPrior)
      : priorCloseForLiveNonSession(ticker, live.session_ymd, yahooPrior);
  const changed = quoteValueChanged(getLatestLiveEquityQuoteRow(ticker), live.price);
  insertLiveMarketQuote({
    symbol: ticker.toUpperCase(),
    kind: "equity",
    value: live.price,
    currency: marketQuoteCurrency(ticker),
    session_ymd: live.session_ymd,
    previous_value: prior,
    fetched_at: fetchedAt,
  });
  clearMarketSymbolFetchError(ticker, "live");
  return changed;
}

async function syncOneEquityLiveQuote(ticker: string, fetchedAt: string): Promise<LiveQuoteSyncTickerResult> {
  try {
    const live = await fetchYahooLiveQuote(ticker);
    recordYahooSplits(ticker, live.splits);
    const changed = writeEquityLiveQuote(ticker, live, fetchedAt);
    return { ticker, ok: true, changed };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    recordMarketSymbolFetchError(ticker, "live", msg);
    return { ticker, ok: false, error: msg.slice(0, 200) };
  }
}

function priorFxDailyClpPerUsd(beforeDate: string): number | null {
  return (
    db
      .prepare(`SELECT clp_per_usd FROM fx_daily WHERE date < ? ORDER BY date DESC LIMIT 1`)
      .get(beforeDate) as { clp_per_usd: number } | undefined
  )?.clp_per_usd ?? null;
}

/** The stored `fx_daily` close (fx day ended, or weekend) mirrored into the live table. */
function mirrorFxDailyToLiveQuotes(fetchedAt: string): { rows: number; changed: boolean } {
  const today = chileCalendarTodayYmd();
  const fx = fxRowOnOrBefore(today);
  if (fx == null || !Number.isFinite(fx.clp_per_usd) || fx.clp_per_usd <= 0) {
    return { rows: 0, changed: false };
  }
  const prior = priorFxDailyClpPerUsd(fx.date);
  const changed = quoteValueChanged(getLatestLiveFxQuoteRow(), fx.clp_per_usd);
  insertLiveMarketQuote({
    symbol: LIVE_FX_SYMBOL,
    kind: "fx_clp_per_usd",
    value: fx.clp_per_usd,
    currency: null,
    session_ymd: fx.date,
    previous_value: prior,
    fetched_at: fetchedAt,
  });
  return { rows: 1, changed };
}

/**
 * First closed tick after the fx day end writes the day's close (`fx_daily`, write-once) from the
 * same quote the open ticks were storing — so the value readers froze on is the value history keeps.
 */
async function catchUpFxDailyIfMissingDueSession(now: Date): Promise<{ rows: number; error?: string }> {
  const due = yahooFxUsdSyncDue(now);
  const latest = maxFxDateOnOrBefore(due);
  if (latest != null && latest >= due) return { rows: 0 };

  try {
    const result = await syncYahooFxUsdFromYahoo({ now });
    return { rows: result.rows, error: result.skipped };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { rows: 0, error: msg.slice(0, 200) };
  }
}

type FxSyncOutcome = {
  rows: number;
  changed: boolean;
  /** `fx_daily` rows were written (the day's close): not a live-only change. */
  wroteFxDaily?: boolean;
  error?: string;
};

async function mirrorFxDailyWithCatchUp(now: Date, fetchedAt: string): Promise<FxSyncOutcome> {
  const catchUp = await catchUpFxDailyIfMissingDueSession(now);
  // New fx_daily rows shift EOD conversions even when the mirrored live value is unchanged.
  const catchUpChanged = catchUp.rows > 0;
  try {
    const mirror = mirrorFxDailyToLiveQuotes(fetchedAt);
    return {
      rows: mirror.rows,
      changed: mirror.changed || catchUpChanged,
      wroteFxDaily: catchUpChanged,
      error: catchUp.error,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { rows: catchUp.rows, changed: catchUpChanged, wroteFxDaily: catchUpChanged, error: msg.slice(0, 200) };
  }
}

/** Stores one live USD/CLP observation; true when it changed the effective rate. */
function writeLiveFxQuote(
  live: { clp_per_usd: number; session_ymd: string; previous_clp_per_usd: number | null },
  fetchedAt: string
): boolean {
  const prior =
    live.previous_clp_per_usd ??
    priorFxDailyClpPerUsd(live.session_ymd) ??
    fxRowOnOrBefore(live.session_ymd)?.clp_per_usd ??
    null;
  const changed = quoteValueChanged(getLatestLiveFxQuoteRow(), live.clp_per_usd);
  insertLiveMarketQuote({
    symbol: LIVE_FX_SYMBOL,
    kind: "fx_clp_per_usd",
    value: live.clp_per_usd,
    currency: null,
    session_ymd: live.session_ymd,
    previous_value: prior,
    fetched_at: fetchedAt,
  });
  return changed;
}

async function syncLiveFxQuote(now: Date, fetchedAt: string, skipLiveFetch: boolean): Promise<FxSyncOutcome> {
  if (shouldUseLiveFxQuote(now)) {
    // The price stream carries the live rate: nothing to fetch (the stream keeps its row fresh).
    if (skipLiveFetch) return { rows: 0, changed: false };
    try {
      const live = await fetchYahooLiveUsdClpPerUsd(now);
      const changed = writeLiveFxQuote(live, fetchedAt);
      return { rows: 1, changed };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`live-quotes:sync — Yahoo CLP=X failed (${msg}); falling back to fx_daily EOD`);
      const fallback = await mirrorFxDailyWithCatchUp(now, fetchedAt);
      return { ...fallback, error: msg.slice(0, 200) };
    }
  }

  return mirrorFxDailyWithCatchUp(now, fetchedAt);
}

/**
 * A write moved a price: publish the change for the client's stamp and drop the aggregates that
 * read it (`publishLiveInputChange`): `live_market_quotes` is not in the change log, so cached
 * aggregations that baked today's live marks (bucket totals, overview live point, current-month
 * perf rows) would keep serving the old price.
 * `live_tail`: only `live_market_quotes` was written, which no historical mark reads, so the
 * cached per-account daily mark series survive — a rebuilt daily view re-prices just today.
 * Only the aggregates that read a moved price go (`cacheDependencies.ts`): a crypto move at
 * night leaves the card ledger, the mortgage and the liabilities' consolidation cached. A write
 * of the day's `fx_daily` close drops everything a tick can reach.
 */
function publishLiveQuoteChanges(
  fetchedAt: string,
  changedTickers: readonly string[],
  fxChanged: boolean,
  wroteFxDaily: boolean
): void {
  publishLiveInputChange(fetchedAt, wroteFxDaily ? { all: true } : { tickers: changedTickers, fx: fxChanged });
}

/** One price from the stream (`yahooPriceStream.ts`), already in its session. */
export type StreamQuote = {
  symbol: string;
  price: number;
  timeMs: number;
  previousClose: number | null;
};

/**
 * Writes prices the stream delivered — the same rows, change test and invalidation as a poll.
 * A quote equal to the stored one only refreshes its row (it stays live for readers) and
 * invalidates nothing. `CLP=X` is the live dollar.
 */
export function writeStreamQuotes(
  quotes: readonly StreamQuote[],
  now = new Date()
): { changedTickers: string[]; fxChanged: boolean } {
  const fetchedAt = now.toISOString();
  const changedTickers: string[] = [];
  let fxChanged = false;
  for (const q of quotes) {
    if (q.symbol === LIVE_FX_YAHOO_SYMBOL) {
      // A poll dates the live dollar by the Chile day it was read on (`fetchYahooLiveUsdClpPerUsd`).
      fxChanged =
        writeLiveFxQuote(
          { clp_per_usd: q.price, session_ymd: chileWallClockAt(now).ymd, previous_clp_per_usd: q.previousClose },
          fetchedAt
        ) || fxChanged;
      continue;
    }
    let changed: boolean;
    try {
      changed = writeEquityLiveQuote(
        q.symbol,
        {
          price: q.price,
          previous_close: q.previousClose,
          session_ymd: yahooBarYmdFromUnix(q.symbol, Math.floor(q.timeMs / 1000)),
        },
        fetchedAt
      );
    } catch (e) {
      recordMarketSymbolFetchError(q.symbol, "live", e instanceof Error ? e.message : String(e));
      continue;
    }
    if (changed) changedTickers.push(q.symbol);
  }
  if (changedTickers.length > 0 || fxChanged) {
    publishLiveQuoteChanges(fetchedAt, changedTickers, fxChanged, false);
  }
  return { changedTickers, fxChanged };
}

export type LiveMarketQuotesSyncOptions = {
  /** Tickers the price stream covers right now: not fetched (`yahooPriceStream.ts`). */
  skipTickers?: ReadonlySet<string>;
  /** The stream covers the live dollar: no CLP=X fetch while the fx day is open. */
  skipLiveFx?: boolean;
};

/**
 * Fetch Yahoo live quotes for all equity/crypto symbols, catch up Yahoo FX EOD if needed, mirror FX, prune old rows.
 * Only the scheduler and `npm run live-quotes:sync` should call this.
 */
export async function syncAllLiveMarketQuotes(
  now = new Date(),
  options: LiveMarketQuotesSyncOptions = {}
): Promise<LiveMarketQuotesSyncResult> {
  const fetchedAt = now.toISOString();
  // A symbol added through another process (the primary server vs a script) must quote in its registered currency.
  reloadMarketSymbols();
  const allTickers = equityTickersForLiveSync();
  const tickers = allTickers.filter((t) => !options.skipTickers?.has(t.toUpperCase()));
  const streamed = allTickers.length - tickers.length;
  const equities: LiveQuoteSyncTickerResult[] = [];
  for (const ticker of tickers) {
    equities.push(await syncOneEquityLiveQuote(ticker, fetchedAt));
  }

  const fxSync = await syncLiveFxQuote(now, fetchedAt, options.skipLiveFx === true);
  const fxRows = fxSync.rows;
  const fxError = fxSync.error;

  const pruned = pruneLiveMarketQuotes();
  const failed = equities.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.warn(
      `live-quotes:sync — ${failed.length}/${equities.length} ticker(s) failed: ${failed.map((f) => `${f.ticker} (${f.error})`).join("; ")}`
    );
  }
  const okCount = equities.filter((r) => r.ok).length;

  const valuesChanged = equities.some((r) => r.changed === true) || fxSync.changed;
  if (valuesChanged) {
    publishLiveQuoteChanges(
      fetchedAt,
      equities.filter((r) => r.changed === true).map((r) => r.ticker),
      fxSync.changed,
      fxSync.wroteFxDaily === true
    );
  }

  console.log(
    `live-quotes:sync — equities ${okCount}/${equities.length}${streamed > 0 ? ` (${streamed} on the stream)` : ""}, fx ${fxRows} row(s)${shouldUseLiveFxQuote(now) ? (options.skipLiveFx ? " (on the stream)" : " (Yahoo CLP=X)") : " (Yahoo EOD fx_daily)"}, pruned ${pruned}${valuesChanged ? ", aggregations invalidated" : ""}`
  );

  return {
    equities,
    fx: { ok: !fxError, rows: fxRows, changed: fxSync.changed, error: fxError },
    pruned,
    values_changed: valuesChanged,
  };
}
