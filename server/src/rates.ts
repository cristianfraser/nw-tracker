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
 * Bid/ask is per pair: a pair that keeps buy and sell rates on file (USD/CLP, `fxBidAsk.ts`) has a
 * spread; one without reads its mid on both sides (UF, EUR). `pairKeepsBidAsk` answers which.
 *
 * What this module answers, each by currency codes:
 * - a VALUE converted (`convertCurrency`; memoized per day in `valueConvert.ts`);
 * - a FLOW converted at its own day's stored rate (`convertFlow`, `convertFlowOrNull`,
 *   `flowEventInUnit`), and a reference size at the mid (`referenceAmountAtMid`);
 * - a pair's RATE as a rate: stored (`storedPairRate`, `storedPairRatesInRange`,
 *   `storedPairRatesOnOrBefore`), live today (`pairRateOnOrBefore`), its buy and sell rates
 *   (`pairBidAskOnOrBefore`).
 *
 * Dates: a day before Chile today reads the stored row on or before it. Today (or later — the
 * current month's month-end point) reads the live rate where the pair has one (USD/CLP and every
 * pair `currencies` loads from Yahoo — EUR/USD — while the fx day is open, `fxLive.ts`), else the
 * stored row. EUR/CLP today: Banco Central's direct rate (`eur_daily`) is published a day late, so
 * while EUR/USD has a quote of today (live, or the close written at the fx day end) today's EUR/CLP
 * is EUR/USD × USD/CLP of today; with none it reads the direct stored rate, as every past day does.
 */
import { historyTierMemo } from "./cacheRegistry.js";
import { chileCalendarTodayYmd, chileWallClockAt } from "./chileDate.js";
import { db } from "./db.js";
import { FX_BID_ASK_SPREAD_CLP, fxBidAskRowOnOrBefore } from "./fxBidAsk.js";
import { recordFxConversionWarning } from "./fxConversionWarnings.js";
import { livePairKey, livePairRateForDay } from "./fxLive.js";

/**
 * A currency code: lowercase ISO 4217 (`clp`, `usd`, `eur`, …) as loaded in `currencies`, or `uf`
 * (the Unidad de Fomento, a series unit with its own pair). Data, not a closed union: validate
 * with `isCurrencyCode` (or `parseDisplayUnit` for a request's display unit).
 */
export type CurrencyCode = string;

/** The unit a series (chart, table, P/L) is shown in: a core currency or `uf`. */
export type TsUnit = CurrencyCode;
/** Same as `TsUnit`; the name the display-unit plumbing reads. */
export type DisplayUnitCode = TsUnit;
export type ConvertSide = "asset" | "debt" | "mid";

const selCurrencyCodes = db.prepare(`SELECT code FROM currencies ORDER BY code`);

let knownCodes: readonly string[] | null = null;

/** Every code a conversion may name: the `currencies` table plus `uf`. */
export function currencyCodes(): readonly string[] {
  knownCodes = [...(selCurrencyCodes.all() as { code: string }[]).map((r) => r.code), "uf"];
  return knownCodes;
}

/** A code `currencies` loads (or `uf`). A miss re-reads the table, so a newly loaded code is seen. */
export function isCurrencyCode(code: string): code is CurrencyCode {
  if (knownCodes?.includes(code)) return true;
  return currencyCodes().includes(code);
}

/**
 * `storedOnly`: read the stored row on or before the day even for today — a flow converts at its
 * own day's stored rate, never at a live one (as pesos to dollars at the stored buy rate do).
 */
export type RateOpts = { side: ConvertSide; now?: Date; storedOnly?: boolean };

/** Quote units per one base unit on a day: the mid and, when the pair has them, bid and ask. */
type PairQuote = { mid: number; bid: number; ask: number; date: string };

/** A pair's rate as a rate: quote units per one base unit at the mid, and the day it was observed. */
export type PairRate = { date: string; mid: number };

/** The stored mids of one pair: one table (or one pair's rows of `fx_rates`), read by date. */
type MidSeries = {
  /** The last row on or before the day with a positive mid. */
  onOrBefore: (ymd: string | null) => PairRate | null;
  /** Rows dated inside `[from, to]`, ascending. */
  range: (from: string, to: string) => PairRate[];
  /** Every row, ascending. */
  all: () => PairRate[];
  /** Every date with a row, ascending (coverage reports read it). */
  dates: () => string[];
};

function midSeries(table: string, midColumn: string, where = "", ...params: unknown[]): MidSeries {
  const and = where ? `${where} AND ` : "";
  const onOrBefore = db.prepare(
    `SELECT date, ${midColumn} AS mid FROM ${table} WHERE ${and}date <= ? ORDER BY date DESC LIMIT 1`
  );
  const range = db.prepare(
    `SELECT date, ${midColumn} AS mid FROM ${table} WHERE ${and}date >= ? AND date <= ? ORDER BY date ASC`
  );
  const all = db.prepare(`SELECT date, ${midColumn} AS mid FROM ${table} ${where ? `WHERE ${where} ` : ""}ORDER BY date ASC`);
  const usable = (r: PairRate): boolean => Number.isFinite(r.mid) && r.mid > 0;
  return {
    onOrBefore: (ymd) => {
      if (!ymd) return null;
      const r = onOrBefore.get(...params, ymd) as PairRate | undefined;
      return r != null && usable(r) ? r : null;
    },
    range: (from, to) => (range.all(...params, from, to) as PairRate[]).filter(usable),
    all: () => (all.all(...params) as PairRate[]).filter(usable),
    dates: () => (all.all(...params) as PairRate[]).map((r) => r.date),
  };
}

/** A pair's stored buy and sell rates on a day (quote units per one base unit). */
export type PairBidAsk = {
  date: string;
  /** What selling one base unit gets (the sell rate). */
  bid: number;
  /** What buying one base unit costs (the buy rate). */
  ask: number;
  /** False for a row that is only the mid ± the pair's half spread, never an observation. */
  observed: boolean;
};

/** The buy / sell rates a pair keeps on file. A pair without one has no spread: every side reads the mid. */
type BidAskSource = {
  /** The latest row on or before the day (an inferred one re-read from the day's mid). */
  onOrBefore: (ymd: string) => PairBidAsk | null;
  /** The whole spread, in quote units, between buy and sell when only the mid is known. */
  inferredSpread: number;
};

type PairSource = {
  base: CurrencyCode;
  quote: CurrencyCode;
  series: MidSeries;
  bidAsk?: BidAskSource;
  /** The key of the pair's live rate (`fxLive.ts`), when it has one. */
  liveKey?: string;
  /** Today's mid for a pair whose rate of today is built from other pairs (EUR/CLP). */
  todayMid?: (ymd: string | null, now: Date | undefined) => PairRate | null;
};

const USD_CLP: PairSource = {
  base: "usd",
  quote: "clp",
  series: midSeries("fx_daily", "clp_per_usd"),
  bidAsk: {
    onOrBefore: (ymd) => {
      const r = fxBidAskRowOnOrBefore(ymd);
      return r == null
        ? null
        : { date: r.date, bid: r.sell_clp_per_usd, ask: r.buy_clp_per_usd, observed: r.source !== "mid_spread_inferred" };
    },
    inferredSpread: FX_BID_ASK_SPREAD_CLP,
  },
  liveKey: livePairKey("usd", "clp"),
};

/** A pair loaded through `currencies` (`fx_rates`): no spread on file, a live rate while the fx day is open. */
function fxRatesPair(base: CurrencyCode, quote: CurrencyCode): PairSource {
  return { base, quote, series: midSeries("fx_rates", "mid", "base = ? AND quote = ?", base, quote), liveKey: livePairKey(base, quote) };
}

const EUR_USD = fxRatesPair("eur", "usd");

const EUR_CLP_SERIES = midSeries("eur_daily", "clp_per_eur");

const PAIRS: readonly PairSource[] = [
  USD_CLP,
  { base: "uf", quote: "clp", series: midSeries("uf_daily", "clp_per_uf") },
  {
    base: "eur",
    quote: "clp",
    series: EUR_CLP_SERIES,
    /**
     * EUR/CLP today: EUR/USD × USD/CLP while EUR/USD has a quote dated today (its live rate, or the
     * close written at the fx day end), so a euro figure moves with both rates during the day; else
     * Banco Central's direct rate, which carries no quote of today until it is published. The cross
     * is a mid (the direct pair has no spread on file).
     */
    todayMid: (ymd, now) => {
      const eurUsd = liveOrStoredMid(EUR_USD, ymd, now);
      if (eurUsd != null && eurUsd.date >= todayYmd(now)) {
        const usdClp = liveOrStoredMid(USD_CLP, ymd, now);
        if (usdClp != null) {
          return { mid: eurUsd.mid * usdClp.mid, date: eurUsd.date < usdClp.date ? eurUsd.date : usdClp.date };
        }
      }
      return EUR_CLP_SERIES.onOrBefore(ymd);
    },
  },
  EUR_USD,
];

/**
 * A pair's mid for today: its live rate while the fx day is open, when the row is fresh and its
 * session is on or before the day (`fxLive.ts`); else the stored close on or before the day.
 */
function liveOrStoredMid(pair: PairSource, ymd: string | null, now: Date | undefined): PairRate | null {
  if (pair.todayMid) return pair.todayMid(ymd, now);
  const live = pair.liveKey != null ? livePairRateForDay(pair.liveKey, ymd, now) : null;
  return live != null && live.mid > 0 ? live : pair.series.onOrBefore(ymd);
}

/** A mid with the pair's inferred spread around it (none for a pair that keeps no bid/ask). */
function quoteFromMid(pair: PairSource, r: PairRate): PairQuote {
  const half = (pair.bidAsk?.inferredSpread ?? 0) / 2;
  return { mid: r.mid, bid: r.mid - half, ask: r.mid + half, date: r.date };
}

/**
 * A pair on a stored day: its mid and, where the pair keeps bid/ask (USD/CLP), the rates observed
 * on that same day or later than the mid row (a dollar purchase, a manual rate). An observed row
 * older than the mid is a past trade's rate, not the day's: the day's bid/ask is then the mid ±
 * the half spread.
 */
function storedQuote(pair: PairSource, ymd: string): PairQuote | null {
  const midRow = pair.series.onOrBefore(ymd);
  if (!midRow) return null;
  const ba = pair.bidAsk?.onOrBefore(ymd);
  // An inferred row is a cached mid ± the half spread, not an observation: some were
  // materialized from a mid since restated (a dated month-end inferred from an older or
  // deleted weekend mid sat up to 6 % off its day's mid row), so the day's own mid decides.
  if (ba && ba.observed && ba.date >= midRow.date && ba.ask > 0 && ba.bid > 0) {
    return { mid: midRow.mid, bid: ba.bid, ask: ba.ask, date: midRow.date };
  }
  return quoteFromMid(pair, midRow);
}

function todayQuote(pair: PairSource, ymd: string, now: Date | undefined): PairQuote | null {
  const r = liveOrStoredMid(pair, ymd, now);
  return r == null ? null : quoteFromMid(pair, r);
}

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

/** A stored rate pair, named by its two codes (`base` priced in `quote`). */
export type RatePair = { base: CurrencyCode; quote: CurrencyCode };

/**
 * The pairs {@link convertCurrency} walks from `from` to `to`, in order: none when the codes are
 * the same, one for a direct pair, two through a hub. Throws when no path exists (as a
 * conversion would).
 */
export function conversionPairs(from: CurrencyCode, to: CurrencyCode): RatePair[] {
  if (from === to) return [];
  const direct = pairFor(from, to);
  if (direct) return [{ base: direct.pair.base, quote: direct.pair.quote }];
  const via = commonCode(from, to);
  if (!via) throw new Error(`rates: no pair path from ${from} to ${to}`);
  return [...conversionPairs(from, via), ...conversionPairs(via, to)];
}

function registeredPair(p: RatePair): PairSource {
  const link = pairFor(p.base, p.quote);
  if (!link || link.inverted) throw new Error(`rates: ${p.base}/${p.quote} is not a registered pair`);
  return link.pair;
}

/** Whether the pair has a stored quote on or before `ymd` (the row a conversion of that day reads). */
export function pairHasStoredQuote(p: RatePair, ymd: string): boolean {
  return registeredPair(p).series.onOrBefore(ymd) != null;
}

/** Every date the pair has a stored row, ascending. */
export function pairStoredDates(p: RatePair): string[] {
  return registeredPair(p).series.dates();
}

function todayYmd(now: Date | undefined): string {
  return now ? chileWallClockAt(now).ymd : chileCalendarTodayYmd();
}

function quoteAt(pair: PairSource, ymd: string, now: Date | undefined, storedOnly = false): PairQuote | null {
  return !storedOnly && ymd >= todayYmd(now) ? todayQuote(pair, ymd, now) : storedQuote(pair, ymd);
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
  const q = quoteAt(link.pair, ymd, opts.now, opts.storedOnly === true);
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
 * The rate of a DIRECT pair on `ymd` (quote units per one base unit, at the mid) and the day it
 * was observed: the rate a page shows as a rate (the watchlist's EUR/USD row), never a
 * conversion. Today reads the live rate where the pair has one. A pair registered the other way
 * round reads as the reciprocal. Null when no row is on or before the day; throws when the two
 * codes have no direct pair.
 */
export function pairRateOnOrBefore(
  base: CurrencyCode,
  quote: CurrencyCode,
  ymd: string,
  now?: Date
): { date: string; mid: number } | null {
  const link = pairFor(base, quote);
  if (!link) throw new Error(`rates: no direct pair ${base}/${quote}`);
  const q = quoteAt(link.pair, ymd, now);
  if (!q || !(q.mid > 0)) return null;
  return { date: q.date, mid: link.inverted ? 1 / q.mid : q.mid };
}

function directPair(base: CurrencyCode, quote: CurrencyCode): { pair: PairSource; inverted: boolean } {
  const link = pairFor(base, quote);
  if (!link) throw new Error(`rates: no direct pair ${base}/${quote}`);
  return link;
}

function orient(r: PairRate, inverted: boolean): PairRate {
  return inverted ? { date: r.date, mid: 1 / r.mid } : r;
}

/**
 * The STORED rate of a direct pair on or before `ymd` (quote units per one base unit, at the mid)
 * and the day it was observed — the close on file, never a live rate, also for today: what a
 * document of that day is priced at, what a past flow is restated with. Null when no row is on or
 * before the day (or the day is null); throws when the two codes have no direct pair.
 */
export function storedPairRate(base: CurrencyCode, quote: CurrencyCode, ymd: string | null): PairRate | null {
  const link = directPair(base, quote);
  const r = link.pair.series.onOrBefore(ymd);
  return r == null ? null : orient(r, link.inverted);
}

/**
 * The stored rows of a direct pair dated inside `[fromYmd, toYmd]`, by date. Exact dates only — no
 * on-or-before read: a caller comparing a known day with a future one (the mortgage UF reminder)
 * must see a day not yet published as absent, not as an older row.
 */
export function storedPairRatesInRange(
  base: CurrencyCode,
  quote: CurrencyCode,
  fromYmd: string,
  toYmd: string
): Map<string, number> {
  const out = new Map<string, number>();
  if (!fromYmd || !toYmd || fromYmd > toYmd) return out;
  const link = directPair(base, quote);
  for (const r of link.pair.series.range(fromYmd, toYmd)) out.set(r.date, orient(r, link.inverted).mid);
  return out;
}

const ON_OR_BEFORE_INDEXED_LOOKUP_MAX = 16;

/**
 * The stored rate of a direct pair at each of `datesAsc` (ascending): the last row on or before
 * each date. A date before the series starts is absent from the map.
 */
export function storedPairRatesOnOrBefore(
  base: CurrencyCode,
  quote: CurrencyCode,
  datesAsc: readonly string[]
): Map<string, number> {
  const out = new Map<string, number>();
  if (datesAsc.length === 0) return out;
  const link = directPair(base, quote);
  if (datesAsc.length <= ON_OR_BEFORE_INDEXED_LOOKUP_MAX) {
    // A few dates (a single mark): one indexed on-or-before lookup each beats reading the table.
    for (const d of datesAsc) {
      const r = link.pair.series.onOrBefore(d);
      if (r != null) out.set(d, orient(r, link.inverted).mid);
    }
    return out;
  }
  // The rows dated before Chile today are evidence a live tick never moves: read once per history
  // tier (`stored_pair_rows_before_today`, no trim rule); today's and later rows are read fresh.
  const today = chileCalendarTodayYmd();
  const memo = historyTierMemo<string, readonly PairRate[]>("stored_pair_rows_before_today");
  const key = `${link.pair.base}|${link.pair.quote}`;
  let before = memo.get(key);
  if (!before) {
    before = link.pair.series.all().filter((r) => r.date < today);
    memo.set(key, before);
  }
  const lastD = datesAsc[datesAsc.length - 1]!;
  const rows = lastD >= today ? [...before, ...link.pair.series.range(today, lastD)] : before;
  let j = 0;
  let last: PairRate | null = null;
  for (const d of datesAsc) {
    while (j < rows.length && rows[j]!.date <= d) {
      last = rows[j]!;
      j += 1;
    }
    if (last != null) out.set(d, orient(last, link.inverted).mid);
  }
  return out;
}

/** Whether the pair `base`/`quote` keeps buy and sell rates on file (USD/CLP). One without has no spread. */
export function pairKeepsBidAsk(base: CurrencyCode, quote: CurrencyCode): boolean {
  const link = pairFor(base, quote);
  return link != null && !link.inverted && link.pair.bidAsk != null;
}

/**
 * The buy and sell rates on file for `base`/`quote` on or before `ymd`: the latest stored row,
 * whatever its age when it is an observation (a purchase's rate stands until a newer row), the
 * day's mid ± the half spread otherwise. Null when the pair keeps none (`pairKeepsBidAsk`) or no
 * row and no mid is on or before the day.
 */
export function pairBidAskOnOrBefore(base: CurrencyCode, quote: CurrencyCode, ymd: string): PairBidAsk | null {
  if (!pairKeepsBidAsk(base, quote)) return null;
  const row = directPair(base, quote).pair.bidAsk!.onOrBefore(ymd);
  return row != null && row.bid > 0 && row.ask > 0 && Number.isFinite(row.bid) && Number.isFinite(row.ask) ? row : null;
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
 * The buy rate a flow of `ymd` paid for one base unit of a pair that keeps bid/ask. A rate found
 * is memoized in the history tier — every daily build converts each deposit event, a few thousand
 * lookups — and the stored rates are mark inputs, so any write to them drops the memo.
 */
function flowBuyRate(pair: PairSource, ymd: string): number | null {
  const memo = historyTierMemo<string, number>(`flow_buy_rate|${pair.base}|${pair.quote}`);
  const known = memo.get(ymd);
  if (known !== undefined) return known;
  const buy = pairBidAskOnOrBefore(pair.base, pair.quote, ymd)?.ask ?? null;
  if (buy != null) memo.set(ymd, buy);
  return buy;
}

/**
 * A FLOW of `amount` `from` expressed in `to` on its own day `ymd` — never a value. Paying the
 * quote of a pair that keeps bid/ask for its base (pesos into dollars) converts at the buy rate on
 * or before the day: what buying it cost (the stored one, or the mid plus the half spread). Any
 * other conversion reads the day's stored mid through the walk (pesos to UF at the day's UF); a
 * flow of today converts at the stored rate, never a live one. Unrounded: callers sum the
 * converted events and round once. Null when no rate is on or before the day. A flow that carries
 * its own leg in `to` (a dollar transfer's dollars) is not converted at all: the caller uses that
 * leg (`flowEventInUnit`).
 */
export function convertFlowOrNull(amount: number, from: CurrencyCode, to: CurrencyCode, ymd: string): number | null {
  if (!Number.isFinite(amount)) throw new Error(`convertFlow ${ymd}: non-finite amount ${amount}`);
  if (from === to || amount === 0) return amount;
  const link = pairFor(from, to);
  if (link != null && link.inverted && link.pair.bidAsk != null) {
    const buy = flowBuyRate(link.pair, ymd);
    return buy == null ? null : amount / buy;
  }
  return convertCurrency(amount, from, to, ymd, { side: "mid", storedOnly: true });
}

/**
 * {@link convertFlowOrNull} where a missing rate throws — a flow is never dropped from a total nor
 * left in one currency inside another unit.
 */
export function convertFlow(amount: number, from: CurrencyCode, to: CurrencyCode, ymd: string): number {
  const out = convertFlowOrNull(amount, from, to, ymd);
  if (out == null) throw new Error(`flow ${ymd}: no ${from}→${to} rate on or before the date (${amount} ${from})`);
  return out;
}

const REFERENCE_RATE_DECIMALS = 5;

/** `value` rounded to the precision reference and cross-rate amounts are kept at (5 decimals), sign kept. */
export function roundReferenceAmount(value: number): number {
  const f = 10 ** REFERENCE_RATE_DECIMALS;
  return Math.sign(value) * (Math.round(Math.abs(value) * f) / f);
}

/**
 * The size of `amount` `from` in `to` at the stored mid on or before `ymd`: a REFERENCE figure for
 * money that never crossed the pair (a dividend reinvested, a rotation inside one foreign
 * currency), so no buy or sell rate applies. Always positive (the caller signs it), rounded to 5
 * decimals; records a reference-rate warning. Null when no rate is on or before the day.
 */
export function referenceAmountAtMid(amount: number, from: CurrencyCode, to: CurrencyCode, ymd: string): number | null {
  if (!Number.isFinite(amount) || amount === 0) return 0;
  const out = convertCurrency(Math.abs(amount), from, to, ymd, { side: "mid", storedOnly: true });
  if (out == null) return null;
  recordFxConversionWarning({ code: "reference_rate", date: ymd, context: "referenceAmountAtMid" });
  return roundReferenceAmount(out);
}

/**
 * A deposit/flow event: every one carries its CLP leg (`amt`); dollar cash and equity capital
 * events also carry the dollars that actually moved (`amt_usd`), and a cash event in another
 * foreign currency its own amount (`amt_native` in `native_currency`).
 */
export type FlowEvent = {
  occurred_on: string;
  amt: number;
  amt_usd?: number | null;
  amt_native?: number | null;
  native_currency?: string | null;
};

/** The event fields for an amount that moved in `currency`: the dollar leg, or a native leg in any other currency. */
export function nativeFlowLeg(
  signed: number,
  currency: CurrencyCode
): { amt_usd: number } | { amt_native: number; native_currency: CurrencyCode } {
  return currency === "usd" ? { amt_usd: signed } : { amt_native: signed, native_currency: currency };
}

/**
 * One deposit/flow event in `unit`, at its own date's rate — the single conversion every
 * deposit and flow reader shares (dashboard totals, window flows, aportes lines, the daily
 * grid, mortgage and property payments). The event's own dollar leg is used as is when the unit
 * is USD, its native leg when the unit is that leg's currency (the sign following the CLP leg); any other unit converts the CLP leg with
 * {@link convertFlow} (pesos to dollars at the buy rate, to UF at the day's UF, any other pair at
 * the day's mid through the walk). Unrounded — callers sum first and round once for display. A
 * missing rate throws: a flow is never dropped from a total.
 */
export function flowEventInUnit(e: FlowEvent, unit: TsUnit): number {
  if (!Number.isFinite(e.amt)) {
    throw new Error(`flow event ${e.occurred_on}: non-finite CLP amount ${e.amt}`);
  }
  if (e.amt === 0) return 0;
  if (unit === "usd" && e.amt_usd != null && Number.isFinite(e.amt_usd)) {
    return Math.sign(e.amt) * Math.abs(e.amt_usd);
  }
  if (e.native_currency != null && unit === e.native_currency && e.amt_native != null && Number.isFinite(e.amt_native)) {
    return Math.sign(e.amt) * Math.abs(e.amt_native);
  }
  return convertFlow(e.amt, "clp", unit, e.occurred_on);
}
