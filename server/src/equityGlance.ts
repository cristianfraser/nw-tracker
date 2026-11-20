/**
 * The stock page's «at a glance» block (`equity_glance` on the account detail bundle): the quote
 * with its sparkline, the price track (average cost · today · highest close), the composition of
 * today's value and the día / mes / año bars. Every figure, share and comparison is decided here;
 * the client only picks and formats.
 *
 * Sources, one definition each:
 * - value today, deposited, dividends: the bundle's position (`positionSnapshotInUnit` +
 *   `equityReturnSnapshot`), so value = deposited + price result + dividends (deposited is net
 *   of payouts, `equityReturns.ts`);
 * - día / mes / año P/L and %: the dashboard account row (`delta_*`, the chained `pct_*`), the
 *   numbers the card and Rentabilidad show;
 * - today's price: `holdingPriceAt` (the price the position is valued at); the previous close and
 *   the sparkline: the stored `equity_daily` closes (split-adjusted, today's share terms);
 * - average cost: the FIFO open lots of the account's tax-lot walk (`loadEquityTaxLotEvents` →
 *   `realizeTaxLots(…, "fifo")`, the lots both returns walk), Σ open cost ÷ Σ open units — the
 *   cost of the shares held now, as the ledger's buys paid it (no option-assignment adjustment).
 *   A split scales units and keeps cost, so the cost per share is in today's share terms like the
 *   stored closes. A lot paid in another currency than the quote converts on its purchase day at
 *   the stored mid.
 * - instrument facts: the registry (`market_symbols`: display symbol, name, market kind).
 */
import type {
  EquityGlanceDirection,
  EquityGlanceDto,
  EquityGlancePeriodDto,
  EquityGlanceSegmentDto,
  EquityGlanceSparkPointDto,
} from "nw-tracker-contracts/dto/accounts";
import { chileWallClockAt } from "./chileDate.js";
import { db } from "./db.js";
import { roundToCurrency } from "./displayUnits.js";
import { requireEquityTicker } from "./accountEquityTicker.js";
import { equityShareUnitsThroughYmd, firstEquityShareActivityYmd } from "./brokerageEquityMtm.js";
import {
  equityQuoteCurrency,
  equitySessionYmdForTicker,
  shouldUseLiveEquityQuote,
} from "./equityQuote.js";
import { loadEquityTaxLotEvents } from "./equityTaxLotEvents.js";
import { holdingPriceAt } from "./holdingPrices.js";
import { requireMarketSymbol } from "./marketSymbols.js";
import { convertCurrency } from "./rates.js";
import { realizeTaxLots, TAX_LOT_UNITS_EPS, type TaxLotSlice } from "./taxLots.js";

/** The sparkline's point budget. */
export const EQUITY_GLANCE_SPARK_MAX_POINTS = 120;

export type EquityGlanceClose = { date: string; price: number };

export type EquityGlanceInputs = {
  accountId: number;
  ticker: string;
  name: string | null;
  marketKind: EquityGlanceDto["quote"]["market_kind"];
  unit: string;
  quoteCurrency: string;
  /** Today's price and the session it belongs to. */
  price: number;
  priceAsOf: string;
  /** Whether the market's regular session is open now. */
  sessionOpen: boolean;
  /** The stored close of the session before `priceAsOf`. */
  previousClose: number | null;
  /** Stored closes from the first day held, ascending, strictly before `priceAsOf`. */
  closes: readonly EquityGlanceClose[];
  /** Average cost per share of the shares held now, in the quote currency. */
  averageCost: number;
  /** The position, in the unit. */
  value: number;
  deposited: number | null;
  dividends: number;
  /** The dashboard row's period P/L and chained %. */
  periods: Record<"day" | "month" | "year", { pl: number | null; pct: number | null }>;
};

function direction(x: number | null): EquityGlanceDirection {
  if (x == null || !Number.isFinite(x) || x === 0) return "flat";
  return x > 0 ? "up" : "down";
}

/** A 1/2/5 × 10^k step at least half the span (a track of ~2–5 steps). */
function niceStep(span: number): number {
  const target = span / 2;
  const mag = 10 ** Math.floor(Math.log10(target));
  for (const m of [1, 2, 5, 10]) if (m * mag >= target) return m * mag;
  return 10 * mag;
}

/** The track's ends: the lowest and highest of the levels, rounded outwards to a nice step. */
export function equityTrackRange(levels: readonly number[]): { min: number; max: number } {
  const lo = Math.min(...levels);
  const hi = Math.max(...levels);
  // All levels equal: a span of a tenth of the level, so the track still has a scale.
  const span = hi > lo ? hi - lo : Math.abs(hi) * 0.1 || 1;
  const step = niceStep(span);
  let min = Math.floor(lo / step) * step;
  let max = Math.ceil(hi / step) * step;
  if (max === min) max = min + step;
  // Floating steps (0,2 × 3): keep the ends on the step's own decimals.
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  min = Number(min.toFixed(decimals));
  max = Number(max.toFixed(decimals));
  return { min, max };
}

/** Evenly sampled indices of `n` points, at most `max`, first and last kept. */
function sampleIndices(n: number, max: number): number[] {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const out = new Set<number>();
  for (let i = 0; i < max; i++) out.add(Math.round((i * (n - 1)) / (max - 1)));
  return [...out].sort((a, b) => a - b);
}

/** The block from its inputs (pure). */
export function equityGlanceFromInputs(inp: EquityGlanceInputs): EquityGlanceDto {
  const q = inp.quoteCurrency;
  const u = inp.unit;
  if (!(inp.price > 0) || !Number.isFinite(inp.price)) {
    throw new Error(`Account ${inp.accountId}: ${inp.ticker} has no price today (${inp.price})`);
  }
  if (!(inp.averageCost > 0) || !Number.isFinite(inp.averageCost)) {
    throw new Error(`Account ${inp.accountId}: ${inp.ticker} average cost ${inp.averageCost} is not a positive price`);
  }
  if (!Number.isFinite(inp.value)) throw new Error(`Account ${inp.accountId}: no value today`);
  const money = (value: number, currency: string) => ({ value, currency });

  // Quote.
  const change = inp.previousClose != null ? inp.price - inp.previousClose : null;
  const changePct = inp.previousClose != null && inp.previousClose !== 0 ? change! / inp.previousClose : null;

  // The full close series through today (today's point = the quote's price).
  const series: EquityGlanceClose[] = [
    ...inp.closes.filter((c) => c.date < inp.priceAsOf && Number.isFinite(c.price) && c.price > 0),
    { date: inp.priceAsOf, price: inp.price },
  ];
  // Highest close since first held; ties keep the earliest day.
  let high = series[0]!;
  for (const c of series) if (c.price > high.price) high = c;

  // Sparkline.
  const sampled = sampleIndices(series.length, EQUITY_GLANCE_SPARK_MAX_POINTS).map((i) => series[i]!);
  const sparkLo = Math.min(inp.averageCost, ...sampled.map((p) => p.price));
  const sparkHi = Math.max(inp.averageCost, ...sampled.map((p) => p.price));
  const ySpan = sparkHi - sparkLo;
  const yOf = (price: number) => (ySpan > 0 ? (price - sparkLo) / ySpan : 0.5);
  const points: EquityGlanceSparkPointDto[] = sampled.map((p) => ({ date: p.date, price: p.price, y: yOf(p.price) }));

  // Track.
  const range = equityTrackRange([inp.averageCost, inp.price, high.price]);
  const shareOf = (price: number) => (price - range.min) / (range.max - range.min);
  const priceR = roundToCurrency(inp.price, q);
  const costR = roundToCurrency(inp.averageCost, q);
  const price_vs_cost: EquityGlanceDto["price_vs_cost"] = priceR > costR ? "above" : priceR < costR ? "below" : "equal";
  const costShare = shareOf(inp.averageCost);
  const priceShare = shareOf(inp.price);
  const fill =
    price_vs_cost === "equal"
      ? { start: costShare, end: costShare, side: "none" as const }
      : {
          start: Math.min(costShare, priceShare),
          end: Math.max(costShare, priceShare),
          side: price_vs_cost === "above" ? ("gain" as const) : ("loss" as const),
        };

  // Composition.
  let composition: EquityGlanceDto["composition"] = null;
  if (inp.deposited != null && Number.isFinite(inp.deposited) && inp.deposited > 0) {
    const deposited = inp.deposited;
    const dividends = inp.dividends;
    if (!(dividends >= 0)) throw new Error(`Account ${inp.accountId}: dividends ${dividends} are negative`);
    const price = inp.value - deposited - dividends;
    const segments: EquityGlanceSegmentDto[] = [];
    let valueShare: number;
    if (price >= 0) {
      const length = inp.value;
      let at = 0;
      for (const [kind, amount] of [
        ["deposited", deposited],
        ["price", price],
        ["dividends", dividends],
      ] as const) {
        if (amount === 0) continue;
        segments.push({ kind, amount, start: at, share: amount / length });
        at += amount / length;
      }
      valueShare = 1;
    } else {
      const length = deposited + dividends;
      if (inp.value < 0) throw new Error(`Account ${inp.accountId}: value ${inp.value} is negative`);
      segments.push({ kind: "deposited", amount: deposited, start: 0, share: deposited / length });
      if (dividends !== 0) segments.push({ kind: "dividends", amount: dividends, start: deposited / length, share: dividends / length });
      valueShare = inp.value / length;
      segments.push({ kind: "loss", amount: -price, start: valueShare, share: 1 - valueShare });
    }
    composition = {
      value: money(inp.value, u),
      deposited: money(deposited, u),
      price: money(price, u),
      price_direction: direction(price),
      dividends: money(dividends, u),
      segments,
      value_share: valueShare,
    };
  }

  // Periods.
  const largest = Math.max(
    ...(["day", "month", "year"] as const).map((k) => {
      const pl = inp.periods[k].pl;
      return pl != null && Number.isFinite(pl) ? Math.abs(pl) : 0;
    })
  );
  const period = (k: "day" | "month" | "year"): EquityGlancePeriodDto => {
    const { pl, pct } = inp.periods[k];
    const known = pl != null && Number.isFinite(pl);
    return {
      pl: known ? money(pl, u) : null,
      pct: pct != null && Number.isFinite(pct) ? pct : null,
      share: known && largest > 0 ? Math.abs(pl) / largest : 0,
      direction: direction(known ? pl : null),
    };
  };

  const first = series[0]!;
  return {
    ticker: inp.ticker,
    name: inp.name,
    unit: u,
    value: money(inp.value, u),
    quote: {
      price: money(inp.price, q),
      price_as_of: inp.priceAsOf,
      previous_close: inp.previousClose != null ? money(inp.previousClose, q) : null,
      change: change != null ? money(change, q) : null,
      change_pct: changePct,
      direction: direction(change),
      session: inp.sessionOpen ? "open" : "closed",
      market_kind: inp.marketKind,
    },
    sparkline: {
      points,
      first_date: first.date,
      last_date: inp.priceAsOf,
      low: sparkLo,
      high: sparkHi,
      cost_y: yOf(inp.averageCost),
    },
    track: {
      min: money(range.min, q),
      max: money(range.max, q),
      cost: { price: money(inp.averageCost, q), share: costShare },
      price: { price: money(inp.price, q), share: priceShare },
      high: {
        price: money(high.price, q),
        share: shareOf(high.price),
        date: high.date,
        pct_from_high: inp.price / high.price - 1,
      },
      fill,
    },
    price_vs_cost,
    composition,
    periods: { day: period("day"), month: period("month"), year: period("year") },
  };
}

/**
 * Σ open cost ÷ Σ open units of the account's FIFO open lots, in `quoteCurrency`; checked against
 * the shares the ledger holds (`expectedUnits`).
 */
export function averageCostFromOpenLots(
  accountId: number,
  openLots: readonly TaxLotSlice[],
  lotCurrency: string | null,
  quoteCurrency: string,
  expectedUnits: number
): number {
  const units = openLots.reduce((s, l) => s + l.units, 0);
  if (Math.abs(units - expectedUnits) > Math.max(TAX_LOT_UNITS_EPS * 100, 1e-6)) {
    throw new Error(`Account ${accountId}: the open tax lots hold ${units} shares but the ledger holds ${expectedUnits}`);
  }
  if (!(units > 0) || lotCurrency == null) throw new Error(`Account ${accountId}: no open lots for the shares held`);
  let cost = 0;
  for (const l of openLots) {
    if (lotCurrency === quoteCurrency) {
      cost += l.cost;
      continue;
    }
    const c = convertCurrency(l.cost, lotCurrency, quoteCurrency, l.acquiredOn, { side: "mid", storedOnly: true });
    if (c == null) {
      throw new Error(`Account ${accountId}: no ${lotCurrency}/${quoteCurrency} rate on ${l.acquiredOn} for a lot's cost`);
    }
    cost += c;
  }
  return cost / units;
}

const stmtClosesFrom = db.prepare(
  `SELECT trade_date AS date, close AS price FROM equity_daily WHERE ticker = ? AND trade_date >= ? AND trade_date < ? ORDER BY trade_date`
);
const stmtCloseBefore = db.prepare(
  `SELECT close FROM equity_daily WHERE ticker = ? AND trade_date < ? ORDER BY trade_date DESC LIMIT 1`
);

/** What the bundle already computed for the account (its position and dashboard row), in `unit`. */
export type EquityGlanceBundleFigures = {
  unit: string;
  position: {
    units_kind: string;
    units: number | null;
    value: number | null;
    deposited: number | null;
    dividends?: number;
  } | null;
  row: {
    delta_day?: number | null;
    delta_month?: number | null;
    delta_year?: number | null;
    pct_day?: number | null;
    pct_month?: number | null;
    pct_year?: number | null;
  } | null;
};

/**
 * The block for an account as of now; null unless it is an equity MTM account holding shares today
 * (`usesEquityMtm` is the caller's `accountUsesEquityMtm`).
 */
export function buildEquityGlanceForAccount(
  accountId: number,
  usesEquityMtm: boolean,
  figures: EquityGlanceBundleFigures,
  now: Date = new Date()
): EquityGlanceDto | null {
  const pos = figures.position;
  if (!usesEquityMtm || pos == null || pos.units_kind !== "shares") return null;
  const today = chileWallClockAt(now).ymd;
  const units = equityShareUnitsThroughYmd(accountId, today);
  if (!(units > 0)) return null;
  if (pos.value == null) throw new Error(`Account ${accountId}: holds ${units} shares but has no value today`);
  if (figures.row == null) throw new Error(`Account ${accountId}: equity account without a dashboard row`);

  const ticker = requireEquityTicker(accountId);
  const symbol = requireMarketSymbol(ticker);
  const quote = equityQuoteCurrency(ticker);
  const px = holdingPriceAt({ kind: "stock", ticker, quote }, today, { now });
  if (!px) throw new Error(`Account ${accountId}: no ${ticker} price today`);
  const firstHeld = firstEquityShareActivityYmd(accountId);
  if (firstHeld == null) throw new Error(`Account ${accountId}: holds shares but has no first share movement`);
  const closes = stmtClosesFrom.all(ticker, firstHeld, px.as_of) as EquityGlanceClose[];
  const prev = stmtCloseBefore.get(ticker, px.as_of) as { close: number } | undefined;

  const { currency: lotCurrency, events } = loadEquityTaxLotEvents(accountId);
  const { openLots } = realizeTaxLots(events, "fifo");
  const averageCost = averageCostFromOpenLots(accountId, openLots, lotCurrency, quote, units);

  const r = figures.row;
  return equityGlanceFromInputs({
    accountId,
    ticker: symbol.display_symbol,
    name: symbol.name,
    marketKind: symbol.market_kind,
    unit: figures.unit,
    quoteCurrency: quote,
    price: px.price,
    priceAsOf: px.as_of,
    sessionOpen: shouldUseLiveEquityQuote(ticker, equitySessionYmdForTicker(ticker, now), now),
    previousClose: prev?.close ?? null,
    closes,
    averageCost,
    value: pos.value,
    deposited: pos.deposited,
    dividends: pos.dividends ?? 0,
    periods: {
      day: { pl: r.delta_day ?? null, pct: r.pct_day ?? null },
      month: { pl: r.delta_month ?? null, pct: r.pct_month ?? null },
      year: { pl: r.delta_year ?? null, pct: r.pct_year ?? null },
    },
  });
}
