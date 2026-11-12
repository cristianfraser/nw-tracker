/**
 * One place that turns a quantity of one currency into another (`docs/holdings-currency-plan.md`).
 *
 * Currencies are codes (`clp`, `usd`, `uf`, `eur`). The rate data is a set of PAIRS, each
 * registered once below with where its rows live; nothing outside this module names a pair.
 * A conversion walks the pairs: directly when one links the two codes, else through a hub both
 * reach — USD first, then CLP (UF and the Banco Central EUR/CLP are quoted in pesos) — the
 * registry, not the caller, knows it. Pairs loaded through `currencies` live in `fx_rates`
 * (EUR/USD from Yahoo `EURUSD=X`).
 *
 * Side of the spread: a quantity is converted at what CLOSES the position.
 * - `asset`: you hold `from` and would sell it for `to` — base → quote at the bid (sell rate),
 *   quote → base at the ask (buy rate).
 * - `debt`: you owe `from` and would buy it with `to` — the other side.
 * - `mid`: the mid rate both ways (references, never a value someone holds).
 * A pair without bid/ask data reads its mid on both sides (UF, EUR).
 *
 * Dates: a day before Chile today reads the stored row on or before it. Today (or later — the
 * current month's month-end point) reads the live rate where the pair has one (USD/CLP while the
 * fx day is open, `fxLive.ts`), else the stored row.
 */
import { chileCalendarTodayYmd, chileWallClockAt } from "./chileDate.js";
import { db } from "./db.js";
import { FX_BID_ASK_SPREAD_CLP, fxBidAskRowOnOrBefore } from "./fxBidAsk.js";
import { fxForLiveMtm } from "./fxLive.js";
import { clpToUsdAtPayment, fxMonthEndForBalanceUsd, ufRowOnOrBefore } from "./fxRates.js";

export type CurrencyCode = "clp" | "usd" | "uf" | "eur";

/** The units a series (chart, table, P/L) is shown in. */
export type TsUnit = Exclude<CurrencyCode, "eur">;
export type ConvertSide = "asset" | "debt" | "mid";

export const CURRENCY_CODES: readonly CurrencyCode[] = ["clp", "usd", "uf", "eur"];

export function isCurrencyCode(code: string): code is CurrencyCode {
  return (CURRENCY_CODES as readonly string[]).includes(code);
}

export type RateOpts = { side: ConvertSide; now?: Date };

/** Quote units per one base unit on a day: the mid and, when the pair has them, bid and ask. */
type PairQuote = { mid: number; bid: number; ask: number };

type PairSource = {
  base: CurrencyCode;
  quote: CurrencyCode;
  /** A stored day (before Chile today). Null when no row is on or before it. */
  stored: (ymd: string) => PairQuote | null;
  /** Today's quote (the live rate where the pair has one). Null when none is on file. */
  today: (ymd: string, now: Date | undefined) => PairQuote | null;
};

const halfSpreadUsdClp = FX_BID_ASK_SPREAD_CLP / 2;

function usdClpFromMid(mid: number): PairQuote {
  return { mid, bid: mid - halfSpreadUsdClp, ask: mid + halfSpreadUsdClp };
}

/**
 * USD/CLP on a stored day: the `fx_daily` mid, and the bid/ask observed on that same day or
 * later than the mid row (a dollar purchase, a manual rate). An observed row older than the mid
 * is a past trade's rate, not the day's: the day's bid/ask is then the mid ± the half spread.
 */
function usdClpStored(ymd: string): PairQuote | null {
  const midRow = fxMonthEndForBalanceUsd(ymd);
  if (!midRow || !(midRow.clp_per_usd > 0)) return null;
  const ba = fxBidAskRowOnOrBefore(ymd);
  // An inferred row is a cached mid ± the half spread, not an observation: some were
  // materialized from a mid since restated (a dated month-end inferred from an older or
  // deleted weekend mid sat up to 6 % off its day's `fx_daily` row), so the day's own mid decides.
  if (
    ba &&
    ba.source !== "mid_spread_inferred" &&
    ba.date >= midRow.date &&
    ba.buy_clp_per_usd > 0 &&
    ba.sell_clp_per_usd > 0
  ) {
    return { mid: midRow.clp_per_usd, bid: ba.sell_clp_per_usd, ask: ba.buy_clp_per_usd };
  }
  return usdClpFromMid(midRow.clp_per_usd);
}

function usdClpToday(ymd: string, now: Date | undefined): PairQuote | null {
  const row = fxForLiveMtm(ymd, now);
  if (!row || !(row.clp_per_usd > 0)) return null;
  return usdClpFromMid(row.clp_per_usd);
}

const stmtEurOnOrBefore = db.prepare(
  `SELECT clp_per_eur FROM eur_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`
);

function eurClp(ymd: string): PairQuote | null {
  const r = stmtEurOnOrBefore.get(ymd) as { clp_per_eur: number } | undefined;
  const v = r?.clp_per_eur;
  return v != null && v > 0 ? { mid: v, bid: v, ask: v } : null;
}

const stmtFxRateOnOrBefore = db.prepare(
  `SELECT mid FROM fx_rates WHERE base = ? AND quote = ? AND date <= ? ORDER BY date DESC LIMIT 1`
);

/** A pair loaded through `currencies` (`fx_rates`): its mid on or before the day; no spread on file. */
function fxRatesPair(base: CurrencyCode, quote: CurrencyCode): (ymd: string) => PairQuote | null {
  return (ymd) => {
    const r = stmtFxRateOnOrBefore.get(base, quote, ymd) as { mid: number } | undefined;
    const v = r?.mid;
    return v != null && v > 0 ? { mid: v, bid: v, ask: v } : null;
  };
}

function ufClp(ymd: string): PairQuote | null {
  const r = ufRowOnOrBefore(ymd);
  const v = r?.clp_per_uf;
  return v != null && v > 0 ? { mid: v, bid: v, ask: v } : null;
}

const PAIRS: readonly PairSource[] = [
  { base: "usd", quote: "clp", stored: usdClpStored, today: usdClpToday },
  { base: "uf", quote: "clp", stored: ufClp, today: (ymd) => ufClp(ymd) },
  { base: "eur", quote: "clp", stored: eurClp, today: (ymd) => eurClp(ymd) },
  { base: "eur", quote: "usd", stored: fxRatesPair("eur", "usd"), today: (ymd) => fxRatesPair("eur", "usd")(ymd) },
];

/** The hubs a conversion without a direct pair walks through, in order. */
const HUBS: readonly CurrencyCode[] = ["usd", "clp"];

function pairFor(a: CurrencyCode, b: CurrencyCode): { pair: PairSource; inverted: boolean } | null {
  for (const p of PAIRS) {
    if (p.base === a && p.quote === b) return { pair: p, inverted: false };
    if (p.base === b && p.quote === a) return { pair: p, inverted: true };
  }
  return null;
}

/** The code two pairs share, so a conversion without a direct pair can walk through it. */
function commonCode(a: CurrencyCode, b: CurrencyCode): CurrencyCode | null {
  for (const c of HUBS) {
    if (c === a || c === b) continue;
    if (pairFor(a, c) && pairFor(c, b)) return c;
  }
  return null;
}

function todayYmd(now: Date | undefined): string {
  return now ? chileWallClockAt(now).ymd : chileCalendarTodayYmd();
}

function quoteAt(pair: PairSource, ymd: string, now: Date | undefined): PairQuote | null {
  return ymd >= todayYmd(now) ? pair.today(ymd, now) : pair.stored(ymd);
}

/**
 * One hop: `qty` of `from` in `to` through a direct pair. Holding the base and receiving the
 * quote (an asset) is the bid; paying the quote for the base is the ask; a debt flips it.
 */
function convertHop(
  qty: number,
  from: CurrencyCode,
  to: CurrencyCode,
  ymd: string,
  opts: RateOpts
): number | null {
  const link = pairFor(from, to);
  if (!link) return null;
  const q = quoteAt(link.pair, ymd, opts.now);
  if (!q) return null;
  const sellingBase = !link.inverted; // from = base: converting base into quote
  const rate =
    opts.side === "mid"
      ? q.mid
      : (opts.side === "asset") === sellingBase
        ? q.bid
        : q.ask;
  if (!(rate > 0)) return null;
  const out = sellingBase ? qty * rate : qty / rate;
  return Number.isFinite(out) ? out : null;
}

/**
 * `qty` of `from` expressed in `to` on `ymd`, at the side `opts.side` names. Null when a rate
 * the walk needs is not on file (callers decide: a chart point is null, a sum throws or skips).
 */
export function convertCurrency(
  qty: number,
  from: CurrencyCode,
  to: CurrencyCode,
  ymd: string,
  opts: RateOpts
): number | null {
  if (from === to || qty === 0) return qty;
  if (pairFor(from, to)) return convertHop(qty, from, to, ymd, opts);
  const via = commonCode(from, to);
  if (!via) throw new Error(`rates: no pair path from ${from} to ${to}`);
  const mid = convertHop(qty, from, via, ymd, opts);
  return mid == null ? null : convertHop(mid, via, to, ymd, opts);
}

/**
 * A FLOW of `amount` `from` expressed in `to` on its own day `ymd` — never a value: pesos to
 * dollars at the buy rate on or before the day (what buying those dollars cost; the mid with a
 * warning when no buy rate is stored), pesos to UF at the day's UF. Unrounded: callers sum the
 * converted events and round once. A missing rate throws — a flow is never dropped from a total
 * nor left in pesos inside another unit. A flow that carries its own leg in `to` (a dollar
 * transfer's dollars) is not converted at all: the caller uses that leg (`flowEventInUnit`).
 */
export function convertFlow(amount: number, from: CurrencyCode, to: CurrencyCode, ymd: string): number {
  if (!Number.isFinite(amount)) throw new Error(`convertFlow ${ymd}: non-finite amount ${amount}`);
  if (from === to || amount === 0) return amount;
  if (from === "clp" && to === "usd") {
    const usd = clpToUsdAtPayment(amount, ymd);
    if (usd == null) throw new Error(`flow ${ymd}: no USD rate on or before the date (${amount} CLP)`);
    return usd;
  }
  if (from === "clp" && to === "uf") {
    const uf = ufRowOnOrBefore(ymd);
    if (!uf || !(uf.clp_per_uf > 0)) throw new Error(`flow ${ymd}: no UF on or before the date (${amount} CLP)`);
    return amount / uf.clp_per_uf;
  }
  // Any other pair: the day's mid through the walk (no buy/sell rate on file for it).
  const out = convertCurrency(amount, from, to, ymd, { side: "mid" });
  if (out == null) throw new Error(`flow ${ymd}: no ${from}→${to} rate on or before the date (${amount} ${from})`);
  return out;
}
