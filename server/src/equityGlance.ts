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
 * - today's price: `holdingPriceAt` (the price the position is valued at); the sparklines and the
 *   highest close: the stored `equity_daily` closes (split-adjusted, today's share terms);
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
  EquityGlanceSparkRange,
  EquityGlanceSparklineDto,
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
import { accountValueAt } from "./accountValue.js";
import { getMergedDisplayDepositInflowEventsForAccount } from "./accountDeposits.js";
import { totalDividendsInUnitForAccount } from "./equityReturns.js";
import { flowEventInUnit, type CurrencyCode } from "./rates.js";
import { BROKERAGE_SHARE_UNITS_FLOW_KINDS } from "./brokerageFlowMovement.js";
import { unitsDeltaForAccountMovement, type MovementTransferRow } from "./movementTransfer.js";
import { requireMarketSymbol } from "./marketSymbols.js";
import { convertCurrency } from "./rates.js";
import { realizeTaxLots, TAX_LOT_UNITS_EPS, type TaxLotSlice } from "./taxLots.js";

/** A sparkline's point budget. */
export const EQUITY_GLANCE_SPARK_MAX_POINTS = 150;

/**
 * The sparkline ranges and their days: N days ending today, today included (the client's
 * `timeRangeCutoffYmd` rule and day counts); 0 = from the first stored close.
 */
export const EQUITY_GLANCE_SPARK_RANGES: readonly { range: EquityGlanceSparkRange; days: number }[] = [
  { range: "30d", days: 30 },
  { range: "60d", days: 60 },
  { range: "90d", days: 90 },
  { range: "1y", days: 366 },
  { range: "3y", days: 1096 },
  { range: "5y", days: 1827 },
  { range: "10y", days: 3653 },
  { range: "total", days: 0 },
];

const DAY_MS = 86_400_000;
const dayNumber = (ymd: string): number => {
  const t = Date.parse(`${ymd}T00:00:00Z`);
  if (!Number.isFinite(t)) throw new Error(`equityGlance: invalid date ${JSON.stringify(ymd)}`);
  return Math.round(t / DAY_MS);
};
const ymdOfDayNumber = (n: number): string => new Date(n * DAY_MS).toISOString().slice(0, 10);

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
  /** The Chile calendar day today (the sparklines' axes end here). */
  today: string;
  /** The first day the account held shares (the highest close counts from here). */
  firstHeld: string;
  /** The days the account held shares: closed stretches, the last one open (`to` null) while held today. */
  heldSpans: readonly { from: string; to: string | null }[];
  /** Every stored close of the instrument, ascending, strictly before `priceAsOf`. */
  closes: readonly EquityGlanceClose[];
  /** Average cost per share of the shares held on `position.asOf`, in the quote currency. */
  averageCost: number;
  /** Today's value (the header's), in the unit. */
  value: number;
  /**
   * The position on its last day holding shares (today while it holds any), in the unit: its value
   * then, the capital deposited and the dividends received through that day.
   */
  position: { asOf: string; isToday: boolean; value: number; deposited: number | null; dividends: number };
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

/**
 * One range's sparkline: the closes on its axis (N days ending today; `total` from the first
 * close), placed by calendar day so a history shorter than the range starts part way along.
 */
function sparklineFor(
  range: EquityGlanceSparkRange,
  days: number,
  series: readonly EquityGlanceClose[],
  averageCost: number,
  today: string,
  heldSpans: readonly { from: string; to: string | null }[]
): EquityGlanceSparklineDto {
  const toN = Math.max(dayNumber(today), dayNumber(series[series.length - 1]!.date));
  const fromN = days > 0 ? toN - (days - 1) : dayNumber(series[0]!.date);
  const from = ymdOfDayNumber(fromN);
  const inRange = series.filter((c) => c.date >= from);
  const sampled = sampleIndices(inRange.length, EQUITY_GLANCE_SPARK_MAX_POINTS).map((i) => inRange[i]!);
  const lo = Math.min(averageCost, ...sampled.map((p) => p.price));
  const hi = Math.max(averageCost, ...sampled.map((p) => p.price));
  const ySpan = hi - lo;
  const yOf = (price: number) => (ySpan > 0 ? (price - lo) / ySpan : 0.5);
  const xSpan = toN - fromN;
  const points: EquityGlanceSparkPointDto[] = sampled.map((p) => ({
    date: p.date,
    price: p.price,
    x: xSpan > 0 ? (dayNumber(p.date) - fromN) / xSpan : 1,
    y: yOf(p.price),
  }));
  const xOfDay = (n: number) => (xSpan > 0 ? Math.min(1, Math.max(0, (n - fromN) / xSpan)) : 1);
  const held = heldSpans
    .map((h) => ({ start: xOfDay(dayNumber(h.from)), end: xOfDay(h.to == null ? toN : dayNumber(h.to)) }))
    .filter((h) => h.end > h.start || (xSpan === 0 && h.end === 1));
  return { range, from, to: ymdOfDayNumber(toN), points, low: lo, high: hi, cost_y: yOf(averageCost), held };
}

/** Today's price vs the average cost, at the quote currency's minor digits. */
function priceSideOfCost(price: number, cost: number, quote: string): EquityGlanceDto["price_vs_cost"] {
  const priceR = roundToCurrency(price, quote);
  const costR = roundToCurrency(cost, quote);
  return priceR > costR ? "above" : priceR < costR ? "below" : "equal";
}

/** The price track: average cost, today's price and the highest close since first held. */
function trackFor(
  series: readonly EquityGlanceClose[],
  firstHeld: string,
  cost: number,
  price: number,
  side: EquityGlanceDto["price_vs_cost"],
  q: string
): EquityGlanceDto["track"] {
  // Highest close since first held (today's price counts); ties keep the earliest day.
  const held = series.filter((c) => c.date >= firstHeld);
  let high = held[0]!;
  for (const c of held) if (c.price > high.price) high = c;
  const range = equityTrackRange([cost, price, high.price]);
  const shareOf = (p: number) => (p - range.min) / (range.max - range.min);
  const costShare = shareOf(cost);
  const priceShare = shareOf(price);
  const fill =
    side === "equal"
      ? { start: costShare, end: costShare, side: "none" as const }
      : {
          start: Math.min(costShare, priceShare),
          end: Math.max(costShare, priceShare),
          side: side === "above" ? ("gain" as const) : ("loss" as const),
        };
  const money = (value: number) => ({ value, currency: q });
  return {
    min: money(range.min),
    max: money(range.max),
    cost: { price: money(cost), share: costShare },
    price: { price: money(price), share: priceShare },
    high: { price: money(high.price), share: shareOf(high.price), date: high.date, pct_from_high: price / high.price - 1 },
    fill,
  };
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

  // The full close series through today's price (today's point = the quote's price).
  const series: EquityGlanceClose[] = [
    ...inp.closes.filter((c) => c.date < inp.priceAsOf && Number.isFinite(c.price) && c.price > 0),
    { date: inp.priceAsOf, price: inp.price },
  ];
  const sparklines = EQUITY_GLANCE_SPARK_RANGES.map(({ range, days }) =>
    sparklineFor(range, days, series, inp.averageCost, inp.today, inp.heldSpans)
  );

  // Track and the price's side of the cost.
  const priceVsCost = priceSideOfCost(inp.price, inp.averageCost, q);
  const track = trackFor(series, inp.firstHeld, inp.averageCost, inp.price, priceVsCost, q);

  // Composition.
  let composition: EquityGlanceDto["composition"] = null;
  const pos = inp.position;
  if (pos.deposited != null && Number.isFinite(pos.deposited) && pos.deposited > 0) {
    const deposited = pos.deposited;
    const dividends = pos.dividends;
    if (!(dividends >= 0)) throw new Error(`Account ${inp.accountId}: dividends ${dividends} are negative`);
    const price = pos.value - deposited - dividends;
    const segments: EquityGlanceSegmentDto[] = [];
    let valueShare: number;
    if (price >= 0) {
      const length = pos.value;
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
      if (pos.value < 0) throw new Error(`Account ${inp.accountId}: value ${pos.value} on ${pos.asOf} is negative`);
      segments.push({ kind: "deposited", amount: deposited, start: 0, share: deposited / length });
      if (dividends !== 0) segments.push({ kind: "dividends", amount: dividends, start: deposited / length, share: dividends / length });
      valueShare = pos.value / length;
      segments.push({ kind: "loss", amount: -price, start: valueShare, share: 1 - valueShare });
    }
    composition = {
      as_of: pos.asOf,
      is_today: pos.isToday,
      value: money(pos.value, u),
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

  return {
    ticker: inp.ticker,
    name: inp.name,
    unit: u,
    value: money(inp.value, u),
    quote: {
      price: money(inp.price, q),
      price_as_of: inp.priceAsOf,
      session: inp.sessionOpen ? "open" : "closed",
      market_kind: inp.marketKind,
    },
    sparklines,
    track,
    price_vs_cost: priceVsCost,
    composition,
    periods: { day: period("day"), month: period("month"), year: period("year") },
  };
}

/**
 * Σ open cost ÷ Σ open units of the account's FIFO open lots, in `quoteCurrency`; checked against
 * the shares the ledger holds (`expectedUnits`). Null when no shares are held: zero shares have no
 * cost per share.
 */
export function averageCostFromOpenLots(
  accountId: number,
  openLots: readonly TaxLotSlice[],
  lotCurrency: string | null,
  quoteCurrency: string,
  expectedUnits: number
): number | null {
  const units = openLots.reduce((s, l) => s + l.units, 0);
  if (Math.abs(units - expectedUnits) > Math.max(TAX_LOT_UNITS_EPS * 100, 1e-6)) {
    throw new Error(`Account ${accountId}: the open tax lots hold ${units} shares but the ledger holds ${expectedUnits}`);
  }
  if (!(units > TAX_LOT_UNITS_EPS)) return null;
  if (lotCurrency == null) throw new Error(`Account ${accountId}: open lots with no currency`);
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

const stmtClosesBefore = db.prepare(
  `SELECT trade_date AS date, close AS price FROM equity_daily WHERE ticker = ? AND trade_date < ? ORDER BY trade_date`
);

const stmtShareUnitRows = db.prepare(
  `SELECT id, occurred_on, account_id, from_account_id, to_account_id, units_delta, counter_units_delta, flow_kind
   FROM movements
   WHERE (account_id = ? OR from_account_id = ? OR to_account_id = ?)
     AND flow_kind IN (${BROKERAGE_SHARE_UNITS_FLOW_KINDS.map(() => "?").join(", ")})`
);

/**
 * The stretches the account held shares: the share ledger's units (the kinds and per-account delta
 * of `brokerageShareUnitsThroughDate`) summed per day; a stretch starts the day the total turns
 * positive and ends the day it returns to zero (null while still held).
 */
export function equityHeldSpans(accountId: number): { from: string; to: string | null }[] {
  const byDay = new Map<string, number>();
  const rows = stmtShareUnitRows.all(accountId, accountId, accountId, ...BROKERAGE_SHARE_UNITS_FLOW_KINDS) as MovementTransferRow[];
  for (const r of rows) {
    const day = r.occurred_on.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + unitsDeltaForAccountMovement(r, accountId));
  }
  const spans: { from: string; to: string | null }[] = [];
  let units = 0;
  for (const day of [...byDay.keys()].sort()) {
    const before = units;
    units += byDay.get(day)!;
    if (before <= TAX_LOT_UNITS_EPS && units > TAX_LOT_UNITS_EPS) spans.push({ from: day, to: null });
    else if (before > TAX_LOT_UNITS_EPS && units <= TAX_LOT_UNITS_EPS) spans[spans.length - 1]!.to = day;
  }
  return spans;
}

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
  if (pos.value == null) throw new Error(`Account ${accountId}: no value today`);
  if (figures.row == null) throw new Error(`Account ${accountId}: equity account without a dashboard row`);

  // One rule for a position held or sold out: measured on its last day holding shares — today
  // while it holds any, else the day before the sale that emptied it.
  const heldSpans = equityHeldSpans(accountId);
  const lastSpan = heldSpans[heldSpans.length - 1];
  const firstHeld = firstEquityShareActivityYmd(accountId);
  // Never held a share (a stock account opened before its first buy): no position to show.
  if (lastSpan == null || firstHeld == null) return null;
  const asOf = lastSpan.to == null ? today : ymdOfDayNumber(dayNumber(lastSpan.to) - 1);
  const units = equityShareUnitsThroughYmd(accountId, asOf);
  if (!(units > TAX_LOT_UNITS_EPS)) throw new Error(`Account ${accountId}: no shares on its last day held ${asOf}`);

  const ticker = requireEquityTicker(accountId);
  const symbol = requireMarketSymbol(ticker);
  const quote = equityQuoteCurrency(ticker);
  const px = holdingPriceAt({ kind: "stock", ticker, quote }, today, { now });
  if (!px) throw new Error(`Account ${accountId}: no ${ticker} price today`);
  const closes = stmtClosesBefore.all(ticker, px.as_of) as EquityGlanceClose[];

  const { currency: lotCurrency, events } = loadEquityTaxLotEvents(accountId);
  const { openLots } = realizeTaxLots(
    events.filter((e) => e.date <= asOf),
    "fifo"
  );
  const averageCost = averageCostFromOpenLots(accountId, openLots, lotCurrency, quote, units);
  if (averageCost == null) throw new Error(`Account ${accountId}: no open lots for the ${units} shares held on ${asOf}`);

  const valueThen = accountValueAt(accountId, asOf, figures.unit as CurrencyCode, { now });
  if (valueThen == null) throw new Error(`Account ${accountId}: no value on ${asOf}`);
  let depositedThen = 0;
  for (const e of getMergedDisplayDepositInflowEventsForAccount(accountId)) {
    if (e.occurred_on <= asOf) depositedThen += flowEventInUnit(e, figures.unit as CurrencyCode);
  }

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
    today,
    firstHeld,
    heldSpans,
    closes,
    averageCost,
    value: pos.value,
    position: {
      asOf,
      isToday: asOf === today,
      value: valueThen.value,
      deposited: depositedThen,
      dividends: totalDividendsInUnitForAccount(accountId, figures.unit as CurrencyCode, asOf),
    },
    periods: {
      day: { pl: r.delta_day ?? null, pct: r.pct_day ?? null },
      month: { pl: r.delta_month ?? null, pct: r.pct_month ?? null },
      year: { pl: r.delta_year ?? null, pct: r.pct_year ?? null },
    },
  });
}
