/**
 * Live exchange rates (2026-11-12: every core pair, docs/any-currency-plan.md C6).
 *
 * A live pair is USD/CLP (Yahoo `CLP=X`, the live dollar) plus every core currency `currencies`
 * loads from a Yahoo pair (`yahoo_pair_symbol`: EUR/USD from `EURUSD=X`). Each is named by its
 * pair key `<BASE>_<QUOTE>` (upper case), which is its `live_market_quotes` symbol (kind `fx`,
 * migration 323), its dependency token (`noteLiveFxRead`) and its `X-Live-Inputs` token.
 *
 * Every pair shares one session: the forex day (`forexDay.ts`) — a weekday (Chile calendar) before
 * its 17:05 New York end, US and Chilean holidays included. EUR/USD trades round the clock on
 * weekdays, but the day the app values is the one the dollar's fx day frames, so a euro figure and
 * a dollar figure built at the same instant read rates of the same day. Outside it readers use the
 * pair's stored close: `fx_daily` for USD/CLP, `fx_rates` for the others, each written once at the
 * day end from the quote readers froze on (`liveMarketQuotesSync.ts`).
 */
import { noteLiveFxRead } from "./cacheDependencies.js";
import { chileWallClockAt } from "./chileDate.js";
import { fetchYahooLiveQuote, YAHOO_USD_CLP_SYMBOL } from "./equityYahooEod.js";
import { getLatestLivePairQuoteRow } from "./liveMarketQuotesDb.js";
import { LIVE_FX_SYMBOL, liveQuotesMaxAgeMs } from "./liveMarketQuotesConfig.js";
import { isFxDayOpen } from "./forexDay.js";
import { fxMonthEndForBalanceUsd, type FxRow } from "./fxRates.js";
import { loadedFxPairs } from "./fxPairsSync.js";

/** Yahoo chart symbol: CLP per 1 USD (tipo de cambio observado intraday). */
export const LIVE_FX_YAHOO_SYMBOL = YAHOO_USD_CLP_SYMBOL;

/** A pair with a live rate: `quote` units per one `base` unit. */
export type LiveFxPair = { key: string; base: string; quote: string; yahooSymbol: string };

/** The key a pair's live rows are stored and reported under: `EUR_USD`. */
export function livePairKey(base: string, quote: string): string {
  return `${base}_${quote}`.toUpperCase();
}

export const USD_CLP_LIVE_PAIR: LiveFxPair = {
  key: LIVE_FX_SYMBOL,
  base: "usd",
  quote: "clp",
  yahooSymbol: LIVE_FX_YAHOO_SYMBOL,
};

/** Every pair with a live rate: USD/CLP first, then the core pairs `currencies` loads. */
export function liveFxPairs(): LiveFxPair[] {
  return [
    USD_CLP_LIVE_PAIR,
    ...loadedFxPairs().map((p) => ({
      key: livePairKey(p.base, p.quote),
      base: p.base,
      quote: p.quote,
      yahooSymbol: p.yahoo_symbol.toUpperCase(),
    })),
  ];
}

/** The live pair a Yahoo symbol quotes (`CLP=X`, `EURUSD=X`), or null for an instrument. */
export function liveFxPairForYahooSymbol(symbol: string): LiveFxPair | null {
  const s = symbol.toUpperCase();
  return liveFxPairs().find((p) => p.yahooSymbol === s) ?? null;
}

/**
 * Whether a pair's live rate is today's rate: while the fx day is open (`forexDay.ts`). Reported
 * whatever the answer: a figure built on the stored close must go when the fx day opens and the
 * first tick moves the rate (`cacheDependencies.ts`).
 */
export function shouldUseLivePairQuote(pairKey: string, now = new Date()): boolean {
  noteLiveFxRead(pairKey);
  return isFxDayOpen(now);
}

/** {@link shouldUseLivePairQuote} for the live dollar. */
export function shouldUseLiveFxQuote(now = new Date()): boolean {
  return shouldUseLivePairQuote(LIVE_FX_SYMBOL, now);
}

/** Fetch a pair's live rate from Yahoo (scheduler only), dated by the Chile day it was read on. */
export async function fetchYahooLivePairRate(
  pair: LiveFxPair,
  now = new Date()
): Promise<{ rate: number; session_ymd: string; previous_rate: number | null }> {
  const live = await fetchYahooLiveQuote(pair.yahooSymbol);
  if (!Number.isFinite(live.price) || live.price <= 0) {
    throw new Error(`Yahoo live ${pair.yahooSymbol} invalid: ${live.price}`);
  }
  return { rate: live.price, session_ymd: chileWallClockAt(now).ymd, previous_rate: live.previous_close };
}

/** Fetch live CLP/USD from Yahoo (scheduler only). */
export async function fetchYahooLiveUsdClpPerUsd(now = new Date()): Promise<{
  clp_per_usd: number;
  session_ymd: string;
  previous_clp_per_usd: number | null;
}> {
  const live = await fetchYahooLivePairRate(USD_CLP_LIVE_PAIR, now);
  return { clp_per_usd: live.rate, session_ymd: live.session_ymd, previous_clp_per_usd: live.previous_rate };
}

/**
 * A pair's live rate for `asOfYmd`: the stored live row while the fx day is open, when it is fresh
 * and its session is on or before the date. Null otherwise — the caller reads the stored close.
 */
export function livePairRateForDay(
  pairKey: string,
  asOfYmd: string | null,
  now = new Date(),
  maxAgeMs = liveQuotesMaxAgeMs()
): { date: string; mid: number } | null {
  // A live row applies only to a date on or after its session (the Chile day it was fetched),
  // and only while fresh: fetched after `Date.now() - maxAgeMs`. A date before that instant's
  // Chile day can match no fresh row, now or after any later tick, so it reads the stored close
  // without reporting a live read — a tick that moves the rate keeps what it built.
  if (asOfYmd != null && asOfYmd < chileWallClockAt(new Date(Date.now() - maxAgeMs)).ymd) return null;
  if (!shouldUseLivePairQuote(pairKey, now)) return null;
  const live = getLatestLivePairQuoteRow(pairKey, maxAgeMs);
  if (live && asOfYmd != null && live.session_ymd <= asOfYmd) return { date: live.session_ymd, mid: live.value };
  return null;
}

/**
 * FX for live MTM / marquee: the stored live `CLP=X` row while the fx day is open; else the
 * `fx_daily` close on or before the date.
 */
export function fxForLiveMtm(asOfYmd: string | null, now = new Date(), maxAgeMs = liveQuotesMaxAgeMs()): FxRow | null {
  const live = livePairRateForDay(LIVE_FX_SYMBOL, asOfYmd, now, maxAgeMs);
  if (live) return { date: live.date, clp_per_usd: live.mid };
  return fxMonthEndForBalanceUsd(asOfYmd);
}
