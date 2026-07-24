import { listWatchlistEquitySeriesKeys, syncWatchlistFromApp } from "./watchlist.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { equityMarketKind, equityQuoteCurrency } from "./equityQuote.js";
import { fetchYahooLiveQuote } from "./equityYahooEod.js";
import { fetchYahooLiveUsdClpPerUsd, shouldUseLiveFxQuote } from "./fxLive.js";
import { syncYahooFxUsdFromYahoo, yahooFxUsdSyncDue } from "./fxYahooEodSync.js";
import { priorNyseSessionYmd } from "./marketHolidays.js";
import { invalidateMarketDataAggregations } from "./aggregationCache.js";
import {
  getLatestLiveEquityQuoteRow,
  getLatestLiveFxQuoteRow,
  insertLiveMarketQuote,
  pruneLiveMarketQuotes,
  type LiveMarketQuoteRow,
} from "./liveMarketQuotesDb.js";
import { LIVE_FX_SYMBOL } from "./liveMarketQuotesConfig.js";
import { maxFxDateOnOrBefore } from "./sbifSyncDb.js";
import { fxRowOnOrBefore } from "./fxRates.js";

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

async function syncOneEquityLiveQuote(ticker: string, fetchedAt: string): Promise<LiveQuoteSyncTickerResult> {
  try {
    const live = await fetchYahooLiveQuote(ticker);
    const kind = equityMarketKind(ticker);
    const prior =
      kind === "nyse"
        ? priorCloseForLiveNyse(ticker, live.session_ymd, live.previous_close)
        : priorCloseForLiveNonSession(ticker, live.session_ymd, live.previous_close);
    const changed = quoteValueChanged(getLatestLiveEquityQuoteRow(ticker), live.price);
    const row: LiveMarketQuoteRow = {
      symbol: ticker.toUpperCase(),
      kind: "equity",
      value: live.price,
      currency: equityQuoteCurrency(ticker),
      session_ymd: live.session_ymd,
      previous_value: prior,
      fetched_at: fetchedAt,
    };
    insertLiveMarketQuote(row);
    return { ticker, ok: true, changed };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
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

/** Yahoo CLP=X EOD from `fx_daily` (after NYSE close / when live FX is off). */
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

async function catchUpFxDailyIfMissingDueSession(now: Date): Promise<{ rows: number; error?: string }> {
  const due = yahooFxUsdSyncDue(now);
  if (due == null) return { rows: 0 };
  const latest = maxFxDateOnOrBefore(due);
  if (latest != null && latest >= due) return { rows: 0 };

  try {
    const result = await syncYahooFxUsdFromYahoo({ now, force: true });
    return { rows: result.rows, error: result.skipped };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { rows: 0, error: msg.slice(0, 200) };
  }
}

async function mirrorFxDailyWithCatchUp(
  now: Date,
  fetchedAt: string
): Promise<{ rows: number; changed: boolean; error?: string }> {
  const catchUp = await catchUpFxDailyIfMissingDueSession(now);
  // New fx_daily rows shift EOD conversions even when the mirrored live value is unchanged.
  const catchUpChanged = catchUp.rows > 0;
  try {
    const mirror = mirrorFxDailyToLiveQuotes(fetchedAt);
    return { rows: mirror.rows, changed: mirror.changed || catchUpChanged, error: catchUp.error };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { rows: catchUp.rows, changed: catchUpChanged, error: msg.slice(0, 200) };
  }
}

async function syncLiveFxQuote(
  now: Date,
  fetchedAt: string
): Promise<{ rows: number; changed: boolean; error?: string }> {
  if (shouldUseLiveFxQuote(now)) {
    try {
      const live = await fetchYahooLiveUsdClpPerUsd(now);
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
      return { rows: 1, changed };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`live-quotes:sync — Yahoo CLP=X failed (${msg}); falling back to fx_daily EOD`);
      const fallback = await mirrorFxDailyWithCatchUp(now, fetchedAt);
      return { rows: fallback.rows, changed: fallback.changed, error: msg.slice(0, 200) };
    }
  }

  return mirrorFxDailyWithCatchUp(now, fetchedAt);
}

/**
 * Fetch Yahoo live quotes for all equity/crypto symbols, catch up Yahoo FX EOD if needed, mirror FX, prune old rows.
 * Only the scheduler and `npm run live-quotes:sync` should call this.
 */
export async function syncAllLiveMarketQuotes(now = new Date()): Promise<LiveMarketQuotesSyncResult> {
  const fetchedAt = now.toISOString();
  const tickers = equityTickersForLiveSync();
  const equities: LiveQuoteSyncTickerResult[] = [];
  for (const ticker of tickers) {
    equities.push(await syncOneEquityLiveQuote(ticker, fetchedAt));
  }

  const fxSync = await syncLiveFxQuote(now, fetchedAt);
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

  // Same-connection quote writes don't bump `data_version`, so cached aggregations that
  // baked today's live marks (bucket totals, overview live point, current-month perf rows)
  // would keep serving the old price. Invalidate only when a value actually changed —
  // closed-market no-op polls must not churn the cache.
  // `live_tail`: this poll only writes `live_market_quotes`, which no historical mark reads,
  // so the cached per-account daily mark series survive — a rebuilt daily view re-prices just
  // today (the one day never cached) instead of re-walking all of history every 5 minutes.
  const valuesChanged = equities.some((r) => r.changed === true) || fxSync.changed;
  if (valuesChanged) invalidateMarketDataAggregations("live_tail");

  console.log(
    `live-quotes:sync — equities ${okCount}/${equities.length}, fx ${fxRows} row(s)${shouldUseLiveFxQuote(now) ? " (Yahoo CLP=X)" : " (Yahoo EOD fx_daily)"}, pruned ${pruned}${valuesChanged ? ", aggregations invalidated" : ""}`
  );

  return {
    equities,
    fx: { ok: !fxError, rows: fxRows, changed: fxSync.changed, error: fxError },
    pruned,
    values_changed: valuesChanged,
  };
}
