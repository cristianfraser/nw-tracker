import { listDistinctEquityTickersForSync } from "./accountEquityTicker.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { equityMarketKind } from "./equityQuote.js";
import { fetchYahooLiveQuote } from "./equityYahooEod.js";
import { fetchYahooLiveUsdClpPerUsd, shouldUseLiveFxQuote } from "./fxLive.js";
import { syncYahooFxUsdFromYahoo, yahooFxUsdSyncDue } from "./fxYahooEodSync.js";
import { priorNyseSessionYmd } from "./marketHolidays.js";
import {
  insertLiveMarketQuote,
  pruneLiveMarketQuotes,
  type LiveMarketQuoteRow,
} from "./liveMarketQuotesDb.js";
import { LIVE_FX_SYMBOL } from "./liveMarketQuotesConfig.js";
import { maxFxDateOnOrBefore } from "./sbifSyncDb.js";
import { fxRowOnOrBefore } from "./fxRates.js";

const EQUITY_DAILY_IMPORT_TICKERS = ["BTC-USD", "ETH-USD"] as const;

const stmtEodPrior = db.prepare(
  `SELECT close_usd FROM equity_daily WHERE ticker = ? AND trade_date < ? ORDER BY trade_date DESC LIMIT 1`
);
const stmtEodOnDate = db.prepare(
  `SELECT close_usd FROM equity_daily WHERE ticker = ? AND trade_date = ?`
);

export type LiveQuoteSyncTickerResult = {
  ticker: string;
  ok: boolean;
  error?: string;
};

export type LiveMarketQuotesSyncResult = {
  equities: LiveQuoteSyncTickerResult[];
  fx: { ok: boolean; rows: number; error?: string };
  pruned: number;
};

function equityTickersForLiveSync(): string[] {
  const fromAccounts = listDistinctEquityTickersForSync();
  return [...new Set([...fromAccounts, ...EQUITY_DAILY_IMPORT_TICKERS])];
}

function priorCloseUsdForLiveNyse(
  ticker: string,
  sessionYmd: string,
  yahooPrior: number | null
): number | null {
  if (yahooPrior != null && Number.isFinite(yahooPrior) && yahooPrior > 0) {
    return yahooPrior;
  }
  const priorYmd = priorNyseSessionYmd(sessionYmd);
  if (priorYmd == null) return null;
  const row = stmtEodOnDate.get(ticker, priorYmd) as { close_usd: number } | undefined;
  if (row != null && Number.isFinite(row.close_usd)) return row.close_usd;
  return (stmtEodPrior.get(ticker, sessionYmd) as { close_usd: number } | undefined)?.close_usd ?? null;
}

function priorCloseUsdForLiveCrypto(
  ticker: string,
  sessionYmd: string,
  yahooPrior: number | null
): number | null {
  if (yahooPrior != null && Number.isFinite(yahooPrior) && yahooPrior > 0) {
    return yahooPrior;
  }
  return (stmtEodPrior.get(ticker, sessionYmd) as { close_usd: number } | undefined)?.close_usd ?? null;
}

async function syncOneEquityLiveQuote(ticker: string, fetchedAt: string): Promise<LiveQuoteSyncTickerResult> {
  try {
    const live = await fetchYahooLiveQuote(ticker);
    const kind = equityMarketKind(ticker);
    const prior =
      kind === "nyse"
        ? priorCloseUsdForLiveNyse(ticker, live.session_ymd, live.previous_close_usd)
        : priorCloseUsdForLiveCrypto(ticker, live.session_ymd, live.previous_close_usd);
    const row: LiveMarketQuoteRow = {
      symbol: ticker.toUpperCase(),
      kind: "equity_usd",
      value: live.price_usd,
      session_ymd: live.session_ymd,
      previous_value: prior,
      fetched_at: fetchedAt,
    };
    insertLiveMarketQuote(row);
    return { ticker, ok: true };
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
function mirrorFxDailyToLiveQuotes(fetchedAt: string): number {
  const today = chileCalendarTodayYmd();
  const fx = fxRowOnOrBefore(today);
  if (fx == null || !Number.isFinite(fx.clp_per_usd) || fx.clp_per_usd <= 0) return 0;
  const prior = priorFxDailyClpPerUsd(fx.date);
  insertLiveMarketQuote({
    symbol: LIVE_FX_SYMBOL,
    kind: "fx_clp_per_usd",
    value: fx.clp_per_usd,
    session_ymd: fx.date,
    previous_value: prior,
    fetched_at: fetchedAt,
  });
  return 1;
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

async function mirrorFxDailyWithCatchUp(now: Date, fetchedAt: string): Promise<{ rows: number; error?: string }> {
  const catchUp = await catchUpFxDailyIfMissingDueSession(now);
  try {
    const rows = mirrorFxDailyToLiveQuotes(fetchedAt);
    return { rows, error: catchUp.error };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { rows: catchUp.rows, error: msg.slice(0, 200) };
  }
}

async function syncLiveFxQuote(now: Date, fetchedAt: string): Promise<{ rows: number; error?: string }> {
  if (shouldUseLiveFxQuote(now)) {
    try {
      const live = await fetchYahooLiveUsdClpPerUsd(now);
      const prior =
        live.previous_clp_per_usd ??
        priorFxDailyClpPerUsd(live.session_ymd) ??
        fxRowOnOrBefore(live.session_ymd)?.clp_per_usd ??
        null;
      insertLiveMarketQuote({
        symbol: LIVE_FX_SYMBOL,
        kind: "fx_clp_per_usd",
        value: live.clp_per_usd,
        session_ymd: live.session_ymd,
        previous_value: prior,
        fetched_at: fetchedAt,
      });
      return { rows: 1 };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`live-quotes:sync — Yahoo CLP=X failed (${msg}); falling back to fx_daily EOD`);
      const fallback = await mirrorFxDailyWithCatchUp(now, fetchedAt);
      return { rows: fallback.rows, error: msg.slice(0, 200) };
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
  console.log(
    `live-quotes:sync — equities ${okCount}/${equities.length}, fx ${fxRows} row(s)${shouldUseLiveFxQuote(now) ? " (Yahoo CLP=X)" : " (Yahoo EOD fx_daily)"}, pruned ${pruned}`
  );

  return {
    equities,
    fx: { ok: !fxError, rows: fxRows, error: fxError },
    pruned,
  };
}
