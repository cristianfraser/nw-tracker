import { db } from "./db.js";
import { priorNyseSessionYmd } from "./marketHolidays.js";
import {
  isNyseRegularSessionOpen,
  nyseDisplaySessionYmd,
  nyseSessionYmd,
  utcTodayYmd,
} from "./nyseSession.js";
import { getLatestLiveEquityQuoteRow } from "./liveMarketQuotesDb.js";
import { liveQuotesMaxAgeMs } from "./liveMarketQuotesConfig.js";

export type EquityMarketKind = "nyse" | "crypto24";

const TICKER_MARKET: Record<string, EquityMarketKind> = {
  SPY: "nyse",
  VEA: "nyse",
  OILK: "nyse",
  "BTC-USD": "crypto24",
  "ETH-USD": "crypto24",
};

export type EquityQuoteSource = "live" | "eod";

export type ResolvedEquityQuote = {
  price_usd: number;
  trade_date: string;
  source: EquityQuoteSource;
  previous_close_usd: number | null;
  delta_pct: number | null;
};

const stmtEodClose = db.prepare(
  `SELECT trade_date, close_usd FROM equity_daily WHERE ticker = ? AND trade_date <= ? ORDER BY trade_date DESC LIMIT 1`
);
const stmtEodCloseOnDate = db.prepare(
  `SELECT trade_date, close_usd FROM equity_daily WHERE ticker = ? AND trade_date = ?`
);
const stmtEodPrior = db.prepare(
  `SELECT close_usd FROM equity_daily WHERE ticker = ? AND trade_date < ? ORDER BY trade_date DESC LIMIT 1`
);

function percentChange(live: number, prior: number | null | undefined): number | null {
  if (prior == null || !Number.isFinite(prior) || prior === 0 || !Number.isFinite(live)) return null;
  return ((live - prior) / prior) * 100;
}

function utcCalendarPrevYmd(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! - 1)).toISOString().slice(0, 10);
}

function eodCloseUsdOnDate(ticker: string, tradeDate: string): number | null {
  const row = stmtEodCloseOnDate.get(ticker, tradeDate) as
    | { trade_date: string; close_usd: number }
    | undefined;
  if (row == null || !Number.isFinite(row.close_usd)) return null;
  return row.close_usd;
}

function eodQuote(ticker: string, asOfYmd: string): ResolvedEquityQuote | null {
  const row = stmtEodClose.get(ticker, asOfYmd) as
    | { trade_date: string; close_usd: number }
    | undefined;
  if (row == null || !Number.isFinite(row.close_usd)) return null;
  const prior = (stmtEodPrior.get(ticker, row.trade_date) as { close_usd: number } | undefined)
    ?.close_usd;
  return {
    price_usd: row.close_usd,
    trade_date: row.trade_date,
    source: "eod",
    previous_close_usd: prior ?? null,
    delta_pct: percentChange(row.close_usd, prior),
  };
}

function sessionPairEodQuote(
  ticker: string,
  displayYmd: string,
  priorYmd: string | null
): ResolvedEquityQuote | null {
  let price = eodCloseUsdOnDate(ticker, displayYmd);
  let tradeDate = displayYmd;
  if (price == null) {
    const fallback = eodQuote(ticker, displayYmd);
    if (fallback == null) return null;
    price = fallback.price_usd;
    tradeDate = fallback.trade_date;
  }
  const priorClose =
    priorYmd != null ? eodCloseUsdOnDate(ticker, priorYmd) : null;
  const priorFromStmt =
    priorClose ??
    (priorYmd == null
      ? (stmtEodPrior.get(ticker, tradeDate) as { close_usd: number } | undefined)?.close_usd
      : null);
  return {
    price_usd: price,
    trade_date: tradeDate,
    source: "eod",
    previous_close_usd: priorFromStmt ?? null,
    delta_pct: percentChange(price, priorFromStmt),
  };
}

function resolveNyseEodQuote(ticker: string, now: Date): ResolvedEquityQuote | null {
  const displayYmd = nyseDisplaySessionYmd(now);
  const priorYmd = priorNyseSessionYmd(displayYmd);
  return sessionPairEodQuote(ticker, displayYmd, priorYmd);
}

/** UTC display session for crypto when not using live (today if row exists, else latest ≤ today). */
export function cryptoDisplaySessionYmd(ticker: string, now = new Date()): string {
  const today = utcTodayYmd(now);
  if (eodCloseUsdOnDate(ticker, today) != null) return today;
  const row = stmtEodClose.get(ticker, today) as { trade_date: string } | undefined;
  return row?.trade_date ?? today;
}

function priorCryptoSessionYmd(ticker: string, displayYmd: string): string | null {
  let cur = utcCalendarPrevYmd(displayYmd);
  for (let i = 0; i < 14; i++) {
    if (eodCloseUsdOnDate(ticker, cur) != null) return cur;
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
  return TICKER_MARKET[ticker] ?? "nyse";
}

/** Latest scheduler-persisted live quote (no Yahoo on HTTP paths). */
export function getLiveEquityQuoteFromDb(
  ticker: string,
  maxAgeMs = liveQuotesMaxAgeMs()
): ResolvedEquityQuote | null {
  const row = getLatestLiveEquityQuoteRow(ticker, maxAgeMs);
  if (!row) return null;
  return {
    price_usd: row.value,
    trade_date: row.session_ymd,
    source: "live",
    previous_close_usd: row.previous_value,
    delta_pct: percentChange(row.value, row.previous_value),
  };
}

/** @deprecated Use {@link getLiveEquityQuoteFromDb}. */
export function getCachedLiveEquityQuote(
  ticker: string,
  maxAgeMs = liveQuotesMaxAgeMs()
): ResolvedEquityQuote | null {
  return getLiveEquityQuoteFromDb(ticker, maxAgeMs);
}

/** Whether `asOfYmd` is the active session and we should prefer stored live quotes over DB EOD. */
export function shouldUseLiveEquityQuote(ticker: string, asOfYmd: string, now = new Date()): boolean {
  const kind = equityMarketKind(ticker);
  if (kind === "crypto24") {
    const today = utcTodayYmd(now);
    return asOfYmd >= today;
  }
  const session = nyseSessionYmd(now);
  if (asOfYmd < session) return false;
  return isNyseRegularSessionOpen(now);
}

/**
 * Session date used for “today” pricing (NYSE session or UTC day for crypto).
 */
export function equitySessionYmdForTicker(ticker: string, now = new Date()): string {
  if (equityMarketKind(ticker) === "crypto24") return utcTodayYmd(now);
  return nyseSessionYmd(now);
}

/**
 * USD price for MTM / marquee: stored live quote during session when requested; otherwise last EOD.
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

  if (equityMarketKind(ticker) === "crypto24") {
    return resolveCryptoEodQuote(ticker, now);
  }
  return resolveNyseEodQuote(ticker, now);
}

/** Synchronous EOD-only close (historical month-ends). */
export function equityCloseUsdEod(ticker: string, asOfYmd: string): number | null {
  return eodQuote(ticker, asOfYmd)?.price_usd ?? null;
}

/** Prior session before display session (marquee / display). */
export function priorEquitySessionForMarquee(ticker: string, now = new Date()): string | null {
  if (equityMarketKind(ticker) === "crypto24") {
    const display = cryptoDisplaySessionYmd(ticker, now);
    return priorCryptoSessionYmd(ticker, display);
  }
  const display = nyseDisplaySessionYmd(now);
  return priorNyseSessionYmd(display);
}

/** No-op: live quotes are persisted in `live_market_quotes` (cleared on EOD sync is unnecessary). */
export function clearEquityLiveQuoteCache(): void {
  /* retained for callers after equity EOD sync */
}
