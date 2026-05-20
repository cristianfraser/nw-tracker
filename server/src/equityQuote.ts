import { db } from "./db.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { isNyseTradingDay, priorNyseSessionYmd } from "./marketHolidays.js";
import {
  isAfterNyseRegularClose,
  nyseSessionYmd,
  nyseWallClock,
  utcTodayYmd,
} from "./nyseSession.js";
import { fetchYahooLiveQuote } from "./equityYahooEod.js";

export type EquityMarketKind = "nyse" | "crypto24";

const TICKER_MARKET: Record<string, EquityMarketKind> = {
  SPY: "nyse",
  VEA: "nyse",
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
const stmtEodPrior = db.prepare(
  `SELECT close_usd FROM equity_daily WHERE ticker = ? AND trade_date < ? ORDER BY trade_date DESC LIMIT 1`
);

const LIVE_TTL_MS = 45_000;
const liveCache = new Map<string, { at: number; quote: ResolvedEquityQuote }>();

/** Fresh Yahoo live quote from the in-process cache (populated by `resolveEquityQuote` with `preferLive`). */
export function getCachedLiveEquityQuote(
  ticker: string,
  maxAgeMs = LIVE_TTL_MS
): ResolvedEquityQuote | null {
  const entry = liveCache.get(ticker);
  if (!entry || Date.now() - entry.at > maxAgeMs) return null;
  return entry.quote.source === "live" ? entry.quote : null;
}

export function equityMarketKind(ticker: string): EquityMarketKind {
  return TICKER_MARKET[ticker] ?? "nyse";
}

function percentChange(live: number, prior: number | null | undefined): number | null {
  if (prior == null || !Number.isFinite(prior) || prior === 0 || !Number.isFinite(live)) return null;
  return ((live - prior) / prior) * 100;
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

/** Whether `asOfYmd` is the active session and we should prefer Yahoo live over DB EOD. */
export function shouldUseLiveEquityQuote(ticker: string, asOfYmd: string, now = new Date()): boolean {
  const kind = equityMarketKind(ticker);
  if (kind === "crypto24") {
    const today = utcTodayYmd(now);
    return asOfYmd >= today;
  }
  const session = nyseSessionYmd(now);
  if (asOfYmd < session) return false;
  if (!isNyseTradingDay(nyseWallClock(now).ymd)) return false;
  return !isAfterNyseRegularClose(now);
}

/**
 * Session date used for “today” pricing (NYSE session or UTC day for crypto).
 */
export function equitySessionYmdForTicker(ticker: string, now = new Date()): string {
  if (equityMarketKind(ticker) === "crypto24") return utcTodayYmd(now);
  return nyseSessionYmd(now);
}

/**
 * USD price for MTM / marquee: live during session when requested; otherwise last EOD ≤ `asOfYmd`.
 */
export async function resolveEquityQuote(
  ticker: string,
  asOfYmd: string,
  opts?: { preferLive?: boolean; now?: Date }
): Promise<ResolvedEquityQuote | null> {
  const now = opts?.now ?? new Date();
  const preferLive = opts?.preferLive ?? false;
  const useLive = preferLive && shouldUseLiveEquityQuote(ticker, asOfYmd, now);

  if (useLive) {
    const cached = liveCache.get(ticker);
    if (cached && Date.now() - cached.at < LIVE_TTL_MS) {
      return cached.quote;
    }
    try {
      const live = await fetchYahooLiveQuote(ticker);
      const prior =
        live.previous_close_usd ??
        (stmtEodPrior.get(ticker, live.session_ymd) as { close_usd: number } | undefined)?.close_usd ??
        null;
      const quote: ResolvedEquityQuote = {
        price_usd: live.price_usd,
        trade_date: live.session_ymd,
        source: "live",
        previous_close_usd: prior,
        delta_pct: percentChange(live.price_usd, prior),
      };
      liveCache.set(ticker, { at: Date.now(), quote });
      return quote;
    } catch {
      /* fall through to EOD */
    }
  }

  const eod = eodQuote(ticker, asOfYmd);
  if (eod == null) return null;

  const kind = equityMarketKind(ticker);
  const chileToday = chileCalendarTodayYmd();
  const sessionToday = equitySessionYmdForTicker(ticker, now);

  if (kind === "nyse") {
    const nyToday = nyseWallClock(now).ymd;
    if (!isNyseTradingDay(nyToday)) {
      return { ...eod, delta_pct: 0 };
    }
    if (eod.trade_date < sessionToday) {
      return { ...eod, delta_pct: 0 };
    }
    if (eod.trade_date >= chileToday && !isAfterNyseRegularClose(now)) {
      /* EOD row for today before close — should have used live; keep EOD delta */
    }
  } else if (eod.trade_date < utcTodayYmd(now)) {
    return { ...eod, delta_pct: 0 };
  }

  return eod;
}

/** Synchronous EOD-only close (historical month-ends). */
export function equityCloseUsdEod(ticker: string, asOfYmd: string): number | null {
  return eodQuote(ticker, asOfYmd)?.price_usd ?? null;
}

/** Prior NYSE session date before Chile today (for marquee / display). */
export function priorEquitySessionForMarquee(ticker: string, now = new Date()): string | null {
  if (equityMarketKind(ticker) === "crypto24") {
    const today = utcTodayYmd(now);
    const [y, m, d] = today.split("-").map(Number);
    const prev = new Date(Date.UTC(y!, m! - 1, d! - 1)).toISOString().slice(0, 10);
    return prev;
  }
  return priorNyseSessionYmd(nyseWallClock(now).ymd);
}

export function clearEquityLiveQuoteCache(): void {
  liveCache.clear();
}
