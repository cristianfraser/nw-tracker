/**
 * The price of one unit of an instrument an account holds (`holdings.ts`), in the instrument's
 * quote currency (`docs/holdings-currency-plan.md`). Currencies have no price: they are
 * converted (`valueConvert.ts`).
 *
 * - A day before Chile today: the stored observation on or before it — the `equity_daily`
 *   close of a stock or a coin's price series, a fund's valor cuota in its display frame (the
 *   Risky Norris proxy on a day the per-date hold covers). Kept per (instrument, day) in the
 *   history tier: every price table is a mark input, so a write drops it.
 * - Today: the choice today's valuation has always made — the live quote in session, the
 *   session's held print after the close, the display session's bar, the newest bar; a fund's
 *   live proxy while it applies. Every gate reports the live input it would read
 *   (`cacheDependencies.ts`).
 */
import { historyTierMemo } from "./cacheRegistry.js";
import { chileCalendarTodayYmd, chileWallClockAt } from "./chileDate.js";
import { db } from "./db.js";
import {
  equityCloseEod,
  equityDisplaySessionYmd,
  equityHeldSessionQuote,
  equitySessionYmdForTicker,
  getLiveEquityQuoteFromDb,
  shouldUseLiveEquityQuote,
} from "./equityQuote.js";
import { equityAsTradedClose } from "./equitySplits.js";
import { assertFundSeriesClp, fundUnitRowOnOrBeforeForDisplay } from "./fundUnitDaily.js";
import type { Holding } from "./holdings.js";
import { optionIntrinsicPerShare } from "./optionContracts.js";
import type { CurrencyCode } from "./rates.js";
import {
  isRiskyNorrisProxyMtmSeries,
  riskyNorrisProxyAppliesOnYmd,
  riskyNorrisProxyCuotaForMtm,
  shouldUseRiskyNorrisProxyMtm,
} from "./riskyNorrisProxyMtm.js";

export type HoldingPrice = { price: number; currency: CurrencyCode; as_of: string };

export type InstrumentHolding = Exclude<Holding, { kind: "currency" } | { kind: "card" }>;

/**
 * The value of `qty` units of an instrument at `price` per unit, in the price's currency — the
 * ONE rule the mark and the daily quantity series share: a fund's value is rounded to the cent (as
 * its position card prints it), a contract is `multiplier` shares at the per-share price, signed
 * (a short position is negative; `+ 0` folds a −0 into 0).
 */
export function instrumentNativeValue(h: InstrumentHolding, qty: number, price: number): number {
  const raw = h.kind === "option" ? qty * price * h.multiplier : qty * price;
  return (h.kind === "fund" ? Math.round(raw * 100) / 100 : raw) + 0;
}

/** The key a quantity series stores its instrument under (one per price source). */
export function instrumentPriceKey(h: InstrumentHolding): string {
  if (h.kind === "stock") return `stock:${h.ticker}`;
  if (h.kind === "coin") return `coin:${h.priceTicker}`;
  if (h.kind === "option") return `option:${h.occSymbol}`;
  return `fund:${h.seriesKey}`;
}

const stmtMaxEqDate = db.prepare(`SELECT max(trade_date) AS md FROM equity_daily WHERE ticker = ?`);

function tickerOf(h: InstrumentHolding): string | null {
  if (h.kind === "stock") return h.ticker;
  if (h.kind === "coin") return h.priceTicker;
  return null;
}

function validPrice(p: number | null | undefined): p is number {
  return p != null && Number.isFinite(p) && p > 0;
}

/**
 * A fund's valor cuota on a day, in its series' currency (`fund_unit_daily.currency`): the proxy
 * on a held day (a Fintual peso fund only), else the display-frame row.
 */
function fundPriceAt(seriesKey: string, ymd: string, isToday: boolean, now: Date): HoldingPrice | null {
  const proxyApplies =
    isRiskyNorrisProxyMtmSeries(seriesKey) &&
    (isToday ? shouldUseRiskyNorrisProxyMtm(now) : riskyNorrisProxyAppliesOnYmd(ymd));
  if (proxyApplies) {
    // The basket proxy is built in pesos (the observado frame): only for a peso series.
    assertFundSeriesClp(seriesKey, "holdingPrices (Risky Norris proxy)");
    const px = riskyNorrisProxyCuotaForMtm(seriesKey, now, isToday ? undefined : ymd);
    return validPrice(px) ? { price: px, currency: "clp", as_of: ymd } : null;
  }
  const fu = fundUnitRowOnOrBeforeForDisplay(seriesKey, ymd);
  return fu && validPrice(fu.unit_value) ? { price: fu.unit_value, currency: fu.currency, as_of: fu.day } : null;
}

type OptionHolding = Extract<InstrumentHolding, { kind: "option" }>;

/**
 * One share of an option contract on `ymd`: its intrinsic value from the underlying's close — the
 * as-traded close of a past day, today's price today — while unexpired, 0 on and after the expiry
 * (`optionIntrinsicPerShare`). Time value is not priced (no history source exists for a contract).
 * A missing underlying close is an error, never a book mark: the contract is valued from the
 * underlying's series only.
 */
function optionPriceAt(h: OptionHolding, ymd: string, underlyingClose: () => number | null): HoldingPrice {
  if (ymd >= h.expiry) return { price: 0, currency: h.quote, as_of: ymd };
  const close = underlyingClose();
  if (!validPrice(close)) {
    throw new Error(
      `option ${h.occSymbol}: cannot mark ${ymd} (no ${h.underlying} close on or before ${ymd}); a contract is valued at intrinsic value from its underlying's series only`
    );
  }
  return { price: optionIntrinsicPerShare(h, close, ymd), currency: h.quote, as_of: ymd };
}

/** A stored day's price (no live input). */
function pastPriceUncached(h: InstrumentHolding, ymd: string): HoldingPrice | null {
  if (h.kind === "fund") return fundPriceAt(h.seriesKey, ymd, false, new Date());
  // The contracts held on `ymd` are worth the underlying's intrinsic value as traded that day.
  if (h.kind === "option") return optionPriceAt(h, ymd, () => equityAsTradedClose(h.underlying, ymd));
  const ticker = tickerOf(h)!;
  // A stock's shares on `ymd` are counted as held then: its price as traded then
  // (`equitySplits.ts`). Today's price needs none — no split is recorded before its ex-date.
  const close = h.kind === "stock" ? equityAsTradedClose(ticker, ymd) : equityCloseEod(ticker, ymd);
  return validPrice(close) ? { price: close, currency: h.quote, as_of: ymd } : null;
}

/** A stock's price today: live in session, the held print after the close, else the bars. */
function stockTodayPrice(ticker: string, quote: CurrencyCode, now: Date): HoldingPrice | null {
  const session = equitySessionYmdForTicker(ticker, now);
  if (shouldUseLiveEquityQuote(ticker, session, now)) {
    const live = getLiveEquityQuoteFromDb(ticker);
    if (live && validPrice(live.price)) return { price: live.price, currency: quote, as_of: session };
    const bar = equityCloseEod(ticker, session);
    if (validPrice(bar)) return { price: bar, currency: quote, as_of: session };
  }
  // Post-close, pre-sync: the session's last stored print (= the close), not the previous bar.
  const held = equityHeldSessionQuote(ticker, now);
  if (held && validPrice(held.price)) return { price: held.price, currency: quote, as_of: session };
  const displayYmd = equityDisplaySessionYmd(ticker, now);
  const fromDisplay = equityCloseEod(ticker, displayYmd);
  if (validPrice(fromDisplay)) return { price: fromDisplay, currency: quote, as_of: displayYmd };
  const md = (stmtMaxEqDate.get(ticker) as { md: string | null } | undefined)?.md ?? null;
  if (md) {
    const fromEod = equityCloseEod(ticker, md);
    if (validPrice(fromEod)) return { price: fromEod, currency: quote, as_of: md };
  }
  return null;
}

/**
 * A coin's price today: the live quote of its UTC session while fresh (crypto trades all day),
 * else the newest close on or before Chile today.
 */
function coinTodayPrice(priceTicker: string, now: Date): HoldingPrice | null {
  const session = equitySessionYmdForTicker(priceTicker, now);
  if (shouldUseLiveEquityQuote(priceTicker, session, now)) {
    const live = getLiveEquityQuoteFromDb(priceTicker);
    if (live && validPrice(live.price)) return { price: live.price, currency: "usd", as_of: session };
  }
  const today = chileWallClockAt(now).ymd;
  const close = equityCloseEod(priceTicker, today);
  return validPrice(close) ? { price: close, currency: "usd", as_of: today } : null;
}

/**
 * One unit of `h` on `ymd`, in its quote currency. A day before Chile today reads the stored
 * observation on or before it; today reads today's price; a later day (the current month's
 * month-end point) the newest stored observation, as a historical day would. Null when none is
 * on file.
 */
export function holdingPriceAt(
  h: InstrumentHolding,
  ymd: string,
  opts?: { now?: Date }
): HoldingPrice | null {
  const now = opts?.now ?? new Date();
  const today = opts?.now ? chileWallClockAt(opts.now).ymd : chileCalendarTodayYmd();
  if (ymd === today) {
    if (h.kind === "stock") return stockTodayPrice(h.ticker, h.quote, now);
    if (h.kind === "coin") return coinTodayPrice(h.priceTicker, now);
    // Today's intrinsic value reads the underlying's today price (live in session, the held print
    // after the close, else its newest bar) — the same choice the underlying's own account makes.
    if (h.kind === "option") return optionPriceAt(h, ymd, () => stockTodayPrice(h.underlying, h.quote, now)?.price ?? null);
    return fundPriceAt(h.seriesKey, ymd, true, now);
  }
  if (ymd > today || opts?.now !== undefined) return pastPriceUncached(h, ymd);
  const memo = historyTierMemo<string, HoldingPrice | null>(`holding_price|${instrumentPriceKey(h)}`);
  let p = memo.get(ymd);
  if (p === undefined) {
    p = pastPriceUncached(h, ymd);
    memo.set(ymd, p);
  }
  return p;
}

/**
 * {@link holdingPriceAt} for many days before Chile today (the daily quantity series): the same
 * history-tier memo, looked up once. Throws for today or later.
 */
export function pastHoldingPriceLookup(h: InstrumentHolding): (ymd: string) => HoldingPrice | null {
  const today = chileCalendarTodayYmd();
  const memo = historyTierMemo<string, HoldingPrice | null>(`holding_price|${instrumentPriceKey(h)}`);
  return (ymd) => {
    if (ymd >= today) throw new Error(`pastHoldingPriceLookup: ${ymd} is not before Chile today`);
    let p = memo.get(ymd);
    if (p === undefined) {
      p = pastPriceUncached(h, ymd);
      memo.set(ymd, p);
    }
    return p;
  };
}
