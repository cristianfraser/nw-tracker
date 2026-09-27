import { db } from "./db.js";
import { chileWallClockAt } from "./chileDate.js";
import { isChileBusinessDay, priorNyseSessionYmd } from "./marketHolidays.js";
import {
  isAfterNyseRegularClose,
  isNyseRegularSessionOpen,
  nyseDisplaySessionYmd,
  nyseSessionYmd,
  utcTodayYmd,
} from "./nyseSession.js";
import { getLatestLiveEquityQuoteRow, type LiveMarketQuoteRow } from "./liveMarketQuotesDb.js";
import { liveQuotesMaxAgeMs } from "./liveMarketQuotesConfig.js";

export type EquityMarketKind = "nyse" | "santiago" | "crypto24";

const TICKER_MARKET: Record<string, EquityMarketKind> = {
  SPY: "nyse",
  VEA: "nyse",
  OILK: "nyse",
  "BTC-USD": "crypto24",
  "ETH-USD": "crypto24",
};

export type EquityQuoteCurrency = "usd" | "clp";

/**
 * Quote currency for a Yahoo symbol — the currency the exchange prints the price in.
 * `.SN` (Bolsa de Santiago) quotes in CLP; everything else we track quotes in USD.
 * Single source of truth: sync writers stamp this into `equity_daily.currency` /
 * `live_market_quotes.currency`, and readers fail fast on a stored mismatch.
 */
export function equityQuoteCurrency(ticker: string): EquityQuoteCurrency {
  return ticker.toUpperCase().endsWith(".SN") ? "clp" : "usd";
}

export type EquityQuoteSource = "live" | "eod";

export type ResolvedEquityQuote = {
  price: number;
  currency: EquityQuoteCurrency;
  trade_date: string;
  source: EquityQuoteSource;
  previous_close: number | null;
  delta_pct: number | null;
};

const stmtEodClose = db.prepare(
  `SELECT trade_date, close, currency FROM equity_daily WHERE ticker = ? AND trade_date <= ? ORDER BY trade_date DESC LIMIT 1`
);
const stmtEodCloseOnDate = db.prepare(
  `SELECT trade_date, close, currency FROM equity_daily WHERE ticker = ? AND trade_date = ?`
);
const stmtEodPrior = db.prepare(
  `SELECT close FROM equity_daily WHERE ticker = ? AND trade_date < ? ORDER BY trade_date DESC LIMIT 1`
);

function percentChange(live: number, prior: number | null | undefined): number | null {
  if (prior == null || !Number.isFinite(prior) || prior === 0 || !Number.isFinite(live)) return null;
  return ((live - prior) / prior) * 100;
}

function utcCalendarPrevYmd(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! - 1)).toISOString().slice(0, 10);
}

function requireStoredQuoteCurrency(ticker: string, stored: string): EquityQuoteCurrency {
  const expected = equityQuoteCurrency(ticker);
  if (stored !== expected) {
    throw new Error(
      `equity quote currency mismatch for ${ticker}: stored '${stored}', expected '${expected}' (fix equity_daily/live_market_quotes rows)`
    );
  }
  return expected;
}

function eodCloseOnDate(ticker: string, tradeDate: string): number | null {
  const row = stmtEodCloseOnDate.get(ticker, tradeDate) as
    | { trade_date: string; close: number; currency: string }
    | undefined;
  if (row == null || !Number.isFinite(row.close)) return null;
  requireStoredQuoteCurrency(ticker, row.currency);
  return row.close;
}

function eodQuote(ticker: string, asOfYmd: string): ResolvedEquityQuote | null {
  const row = stmtEodClose.get(ticker, asOfYmd) as
    | { trade_date: string; close: number; currency: string }
    | undefined;
  if (row == null || !Number.isFinite(row.close)) return null;
  const currency = requireStoredQuoteCurrency(ticker, row.currency);
  const prior = (stmtEodPrior.get(ticker, row.trade_date) as { close: number } | undefined)
    ?.close;
  return {
    price: row.close,
    currency,
    trade_date: row.trade_date,
    source: "eod",
    previous_close: prior ?? null,
    delta_pct: percentChange(row.close, prior),
  };
}

function sessionPairEodQuote(
  ticker: string,
  displayYmd: string,
  priorYmd: string | null
): ResolvedEquityQuote | null {
  let price = eodCloseOnDate(ticker, displayYmd);
  let tradeDate = displayYmd;
  if (price == null) {
    const fallback = eodQuote(ticker, displayYmd);
    if (fallback == null) return null;
    price = fallback.price;
    tradeDate = fallback.trade_date;
  }
  const priorClose = priorYmd != null ? eodCloseOnDate(ticker, priorYmd) : null;
  // Fall back to the last bar strictly before the resolved trade_date when the exact prior session
  // has no stored bar (holiday-adjacent gap, thin history, or the demo's weekly cadence) — so the
  // day change is always the change vs the previous available session, never null when a prior exists.
  const priorFromStmt =
    priorClose ??
    (stmtEodPrior.get(ticker, tradeDate) as { close: number } | undefined)?.close ??
    null;
  return {
    price,
    currency: equityQuoteCurrency(ticker),
    trade_date: tradeDate,
    source: "eod",
    previous_close: priorFromStmt ?? null,
    delta_pct: percentChange(price, priorFromStmt),
  };
}

function resolveNyseEodQuote(ticker: string, now: Date): ResolvedEquityQuote | null {
  const displayYmd = nyseDisplaySessionYmd(now);
  const priorYmd = priorNyseSessionYmd(displayYmd);
  return sessionPairEodQuote(ticker, displayYmd, priorYmd);
}

/** UTC display session for crypto when not using live (latest completed UTC day in DB). */
export function cryptoDisplaySessionYmd(ticker: string, now = new Date()): string {
  const completedUtc = utcCalendarPrevYmd(utcTodayYmd(now));
  const row = stmtEodClose.get(ticker, completedUtc) as { trade_date: string } | undefined;
  return row?.trade_date ?? completedUtc;
}

function priorCryptoSessionYmd(ticker: string, displayYmd: string): string | null {
  let cur = utcCalendarPrevYmd(displayYmd);
  for (let i = 0; i < 14; i++) {
    if (eodCloseOnDate(ticker, cur) != null) return cur;
    cur = utcCalendarPrevYmd(cur);
  }
  return null;
}

function resolveCryptoEodQuote(ticker: string, now: Date): ResolvedEquityQuote | null {
  const displayYmd = cryptoDisplaySessionYmd(ticker, now);
  const priorYmd = priorCryptoSessionYmd(ticker, displayYmd);
  return sessionPairEodQuote(ticker, displayYmd, priorYmd);
}

export function equityMarketKind(ticker: string): EquityMarketKind {
  if (ticker.toUpperCase().endsWith(".SN")) return "santiago";
  return TICKER_MARKET[ticker] ?? "nyse";
}

/**
 * Bolsa de Santiago regular session ≈ 09:30–17:05 Chile wall clock on Chile business days
 * (weekdays minus `CHILE_CLOSED_YMD`; the NYSE calendar plays no part).
 * Approximate on purpose: live rows are additionally freshness-gated by `liveQuotesMaxAgeMs`.
 */
function isSantiagoRegularSessionOpen(now: Date): boolean {
  const cl = chileWallClockAt(now);
  if (!isChileBusinessDay(cl.ymd)) return false;
  const mins = cl.hour * 60 + cl.minute;
  return mins >= 9 * 60 + 30 && mins <= 17 * 60 + 5;
}

/** Bolsa de Santiago session of Chile today has ended (after 17:05 Chile on a Chile business day). */
function isAfterSantiagoRegularClose(now: Date): boolean {
  const cl = chileWallClockAt(now);
  if (!isChileBusinessDay(cl.ymd)) return false;
  return cl.hour * 60 + cl.minute > 17 * 60 + 5;
}

/**
 * The ticker's session for today has already closed (NYSE after 16:05 New York, Santiago after
 * 17:05 Chile, both on their own trading days). Never true before the open, on the exchange's
 * closed days, or for crypto (24/7 — its live window never ends).
 */
export function equitySessionClosedForDay(ticker: string, now = new Date()): boolean {
  const kind = equityMarketKind(ticker);
  if (kind === "crypto24") return false;
  if (kind === "santiago") return isAfterSantiagoRegularClose(now);
  return isAfterNyseRegularClose(now);
}

/**
 * Santiago EOD display: latest `equity_daily` bar ≤ Chile today (on-or-before absorbs
 * Chilean holidays), prior = previous stored bar.
 */
function resolveSantiagoEodQuote(ticker: string, now: Date): ResolvedEquityQuote | null {
  return eodQuote(ticker, chileWallClockAt(now).ymd);
}

function liveRowToQuote(ticker: string, row: LiveMarketQuoteRow): ResolvedEquityQuote {
  if (row.currency == null) {
    throw new Error(`live_market_quotes: equity row for ${ticker} has no currency`);
  }
  const currency = requireStoredQuoteCurrency(ticker, row.currency);
  return {
    price: row.value,
    currency,
    trade_date: row.session_ymd,
    source: "live",
    previous_close: row.previous_value,
    delta_pct: percentChange(row.value, row.previous_value),
  };
}

/** Latest scheduler-persisted live quote (no Yahoo on HTTP paths). */
export function getLiveEquityQuoteFromDb(
  ticker: string,
  maxAgeMs = liveQuotesMaxAgeMs()
): ResolvedEquityQuote | null {
  const row = getLatestLiveEquityQuoteRow(ticker, maxAgeMs);
  if (!row) return null;
  return liveRowToQuote(ticker, row);
}

/**
 * Post-close hold (2026-09-21): between a session's close and the EOD sync landing its bar,
 * today's quote is the session's last stored live print — Yahoo's `regularMarketPrice`
 * re-serves the official close once the session ends, so that print IS the close until the
 * bar exists. Without it the live gate turned off at the close and every reader fell back to
 * the PREVIOUS bar (IPSA read a 0 day P/L from 17:05 until the 17:10 Santiago sync landed;
 * NYSE tickers had the same gap for the minutes between 16:05 and the `stocks_nyse` run).
 * Null before the open, on closed days, for crypto, once the session's bar is stored, or
 * when the last stored print belongs to another session. Freshness is not required: after
 * the close the scheduler keeps re-writing the same close, and a stale print of TODAY's
 * session is still the best evidence there is.
 */
export function equityHeldSessionQuote(ticker: string, now = new Date()): ResolvedEquityQuote | null {
  if (!equitySessionClosedForDay(ticker, now)) return null;
  const session = equitySessionYmdForTicker(ticker, now);
  if (eodCloseOnDate(ticker, session) != null) return null;
  const row = getLatestLiveEquityQuoteRow(ticker, Number.POSITIVE_INFINITY);
  if (!row || row.session_ymd !== session) return null;
  return liveRowToQuote(ticker, row);
}

/** Whether `asOfYmd` is the active session and we should prefer stored live quotes over DB EOD. */
export function shouldUseLiveEquityQuote(ticker: string, asOfYmd: string, now = new Date()): boolean {
  const kind = equityMarketKind(ticker);
  if (kind === "crypto24") {
    const today = utcTodayYmd(now);
    return asOfYmd >= today;
  }
  if (kind === "santiago") {
    const session = chileWallClockAt(now).ymd;
    if (asOfYmd < session) return false;
    return isSantiagoRegularSessionOpen(now);
  }
  const session = nyseSessionYmd(now);
  if (asOfYmd < session) return false;
  return isNyseRegularSessionOpen(now);
}

/**
 * Session date used for “today” pricing (NYSE session, Chile calendar day for Santiago, UTC day for crypto).
 */
export function equitySessionYmdForTicker(ticker: string, now = new Date()): string {
  const kind = equityMarketKind(ticker);
  if (kind === "crypto24") return utcTodayYmd(now);
  if (kind === "santiago") return chileWallClockAt(now).ymd;
  return nyseSessionYmd(now);
}

/**
 * EOD display day per market kind. NYSE uses its display session (prior close before open,
 * same-day close after close) — but that is New York's calendar: a Santiago ticker must use
 * the Chile calendar day, otherwise just after midnight Chile (NY still on yesterday) the
 * display day lags and same-day units/marks are missed.
 */
export function equityDisplaySessionYmd(ticker: string, now = new Date()): string {
  const kind = equityMarketKind(ticker);
  if (kind === "crypto24") return cryptoDisplaySessionYmd(ticker, now);
  if (kind === "santiago") return chileWallClockAt(now).ymd;
  return nyseDisplaySessionYmd(now);
}

/**
 * Quote-currency price for MTM / marquee: stored live quote during session when requested
 * (after the close, the session's held print until its bar lands — `equityHeldSessionQuote`);
 * otherwise last EOD.
 */
export function resolveEquityQuote(
  ticker: string,
  asOfYmd: string,
  opts?: { preferLive?: boolean; now?: Date }
): ResolvedEquityQuote | null {
  const now = opts?.now ?? new Date();
  const preferLive = opts?.preferLive ?? false;
  const useLive = preferLive && shouldUseLiveEquityQuote(ticker, asOfYmd, now);

  if (useLive) {
    const live = getLiveEquityQuoteFromDb(ticker);
    if (live) return live;
  }
  if (preferLive && asOfYmd >= equitySessionYmdForTicker(ticker, now)) {
    const held = equityHeldSessionQuote(ticker, now);
    if (held) return held;
  }

  const kind = equityMarketKind(ticker);
  if (kind === "crypto24") {
    return resolveCryptoEodQuote(ticker, now);
  }
  if (kind === "santiago") {
    return resolveSantiagoEodQuote(ticker, now);
  }
  return resolveNyseEodQuote(ticker, now);
}

/** Synchronous EOD-only close in the ticker's quote currency (historical month-ends). */
export function equityCloseEod(ticker: string, asOfYmd: string): number | null {
  return eodQuote(ticker, asOfYmd)?.price ?? null;
}

/** No-op: live quotes are persisted in `live_market_quotes` (cleared on EOD sync is unnecessary). */
export function clearEquityLiveQuoteCache(): void {
  /* retained for callers after equity EOD sync */
}
