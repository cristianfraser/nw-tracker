/**
 * The unit-position page's «at a glance» block (`position_glance` on the account detail bundle):
 * the quote with its sparkline, the price track (average cost · today · highest price), the
 * composition of the value and the día / mes / año bars, for every account valued as units × a
 * unit price — stocks and ETFs (shares), coins (Bitcoin, Ether) and funds (AFP and AFC cuota
 * ledgers, Fintual goals, US fund accounts). Every figure, share and comparison is decided here;
 * the client only picks and formats.
 *
 * One code path for every kind (`buildPositionGlanceForAccount`): units and the stretches held,
 * the price series, the sparklines, the track, the price's side of the cost, the composition as
 * of the last day held and the periods. What differs per kind is only {@link KindParts}: where
 * the units come from, the price series, the lot walk and the instrument's facts.
 *
 * Sources, one definition each:
 * - value today: the bundle's position (`positionSnapshotInUnit`); the value, deposited capital,
 *   state bonus and dividends on the last day held: `accountValueAt`, the personal deposit
 *   timeline (`getMergedDisplayDepositInflowEventsForAccount`), the APV state bonus timeline
 *   (`getStateContributionInflowEventsForAccount`) and the dividend payouts
 *   (`totalDividendsInUnitForAccount`), so value = deposited + state bonus + price + dividends;
 * - día / mes / año P/L and %: the dashboard account row (`delta_*`, the chained `pct_*`);
 * - today's price: `holdingPriceAt` (the price the position is valued at — for a proxied fund in
 *   session the basket estimate, `price_source: proxy`); the sparklines and the highest price:
 *   the stored series (`unitPriceSeries`: `equity_daily` for stocks and coins, `fund_unit_daily`
 *   for funds);
 * - units: the ledger the value reads — shares (`BROKERAGE_SHARE_UNITS_FLOW_KINDS`,
 *   `unitsDeltaForAccountMovement`) for a stock, the coin / cuota ledger
 *   (`ledgerUnitsDeltaForAccountMovement`: single-leg units + transfer legs, a fund switch's
 *   counter units on its to-leg) for coins and funds;
 * - average cost: the FIFO open lots of the kind's lot walk — `loadEquityTaxLotEvents` (shares;
 *   a split scales units and keeps cost, so the cost is in today's share terms like the stored
 *   closes), `loadCryptoTaxLotEvents` (coins, pesos, commissions `included`: the ledger pesos
 *   paid, so the page never depends on the exchange's trade records),
 *   `loadFundTaxLotEvents` (cuotas, already in the fund's currency; the state bonus at 0 cost) —
 *   Σ open cost ÷ Σ open units, a lot in another currency than the quote converted on its
 *   purchase day at the stored mid;
 * - instrument facts: the registry (`market_symbols`) for stocks and coins, the fund series
 *   (Fintual goal table, AFP display series key, AFC) for funds.
 */
import type {
  PositionGlanceBasketDto,
  PositionGlanceDirection,
  PositionGlanceDto,
  PositionGlanceFundSeriesDto,
  PositionGlanceInstrumentDto,
  PositionGlancePeriodDto,
  PositionGlanceSegmentDto,
  PositionGlanceSparkPointDto,
  PositionGlanceSparkRange,
  PositionGlanceSparklineDto,
} from "nw-tracker-contracts/dto/accounts";
import { accountProfileOptional, type AccountProfile } from "./accountProfile.js";
import { getMergedDisplayDepositInflowEventsForAccount, getStateContributionInflowEventsForAccount } from "./accountDeposits.js";
import { accountValueAt } from "./accountValue.js";
import { parseAfpDisplaySeriesKey } from "./afpUnoSeries.js";
import { BROKERAGE_SHARE_UNITS_FLOW_KINDS } from "./brokerageFlowMovement.js";
import { chileWallClockAt } from "./chileDate.js";
import { loadCryptoTaxLotEvents } from "./cryptoTaxLotEvents.js";
import { db } from "./db.js";
import { roundToCurrency } from "./displayUnits.js";
import { equitySessionYmdForTicker, shouldUseLiveEquityQuote } from "./equityQuote.js";
import { totalDividendsInUnitForAccount } from "./equityReturns.js";
import { loadEquityTaxLotEvents } from "./equityTaxLotEvents.js";
import { fintualGoalBySeriesKey } from "./fintualGoals.js";
import { loadFundTaxLotEvents, loadFundUnitRows } from "./fundTaxLotEvents.js";
import { fundUnitRowOnOrBeforeForDisplay } from "./fundUnitDaily.js";
import { holdingPriceAt, unitPriceSeries, type HoldingPrice, type InstrumentHolding } from "./holdingPrices.js";
import { marketSymbol, requireMarketSymbol } from "./marketSymbols.js";
import {
  ledgerUnitsDeltaForAccountMovement,
  unitsDeltaForAccountMovement,
  type MovementTransferRow,
} from "./movementTransfer.js";
import { loadProxyBasketBreakdown } from "./proxyBasketBreakdown.js";
import { convertCurrency, flowEventInUnit, type CurrencyCode } from "./rates.js";
import { isRiskyNorrisProxyMtmSeries, proxyBucketSlugForSeriesKey } from "./riskyNorrisProxyMtm.js";
import { realizeTaxLots, TAX_LOT_UNITS_EPS, type TaxLotEvent, type TaxLotSlice } from "./taxLots.js";

/** A sparkline's point budget. */
export const POSITION_GLANCE_SPARK_MAX_POINTS = 150;

/**
 * The sparkline ranges and their days: N days ending today, today included (the client's
 * `timeRangeCutoffYmd` rule and day counts); 0 = from the first stored price.
 */
export const POSITION_GLANCE_SPARK_RANGES: readonly { range: PositionGlanceSparkRange; days: number }[] = [
  { range: "30d", days: 30 },
  { range: "60d", days: 60 },
  { range: "90d", days: 90 },
  { range: "1y", days: 366 },
  { range: "3y", days: 1096 },
  { range: "5y", days: 1827 },
  { range: "10y", days: 3653 },
  { range: "total", days: 0 },
];

/**
 * Cuotas are stored to 4 decimals and their ledgers read a residue below half of the last one as
 * an emptied account (`fintualGoalUnitsFromMovementsThroughDate`); shares and coins carry 8–9.
 */
const FUND_UNITS_EPS = 0.5e-4;

const DAY_MS = 86_400_000;
const dayNumber = (ymd: string): number => {
  const t = Date.parse(`${ymd}T00:00:00Z`);
  if (!Number.isFinite(t)) throw new Error(`positionGlance: invalid date ${JSON.stringify(ymd)}`);
  return Math.round(t / DAY_MS);
};
const ymdOfDayNumber = (n: number): string => new Date(n * DAY_MS).toISOString().slice(0, 10);

export type PositionGlancePrice = { date: string; price: number };

export type HeldSpan = { from: string; to: string | null };

export type PositionGlanceInputs = {
  accountId: number;
  title: string;
  instrument: PositionGlanceInstrumentDto;
  unit: string;
  quoteCurrency: string;
  /** Today's price and the day it belongs to. */
  price: number;
  priceAsOf: string;
  /** The Chile calendar day today (the sparklines' axes end here). */
  today: string;
  /** The first day the account held units (the highest price counts from here). */
  firstHeld: string;
  /** The days the account held units: closed stretches, the last one open (`to` null) while held today. */
  heldSpans: readonly HeldSpan[];
  /** Every stored price of a unit, ascending, strictly before `priceAsOf`. */
  closes: readonly PositionGlancePrice[];
  /** Average cost per unit of the units held on `position.asOf`, in the quote currency. */
  averageCost: number;
  /** Today's value (the header's), in the unit. */
  value: number;
  /**
   * The position on its last day holding units (today while it holds any), in the unit: its value
   * then, the personal capital deposited, the state bonus (null: the account never received one)
   * and the dividends received through that day.
   */
  position: {
    asOf: string;
    isToday: boolean;
    value: number;
    deposited: number | null;
    stateBonus: number | null;
    dividends: number;
  };
  /** The dashboard row's period P/L and chained %. */
  periods: Record<"day" | "month" | "year", { pl: number | null; pct: number | null }>;
  basket: PositionGlanceBasketDto | null;
};

function direction(x: number | null): PositionGlanceDirection {
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
export function positionTrackRange(levels: readonly number[]): { min: number; max: number } {
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
 * One range's sparkline: the prices on its axis (N days ending today; `total` from the first
 * price), placed by calendar day so a history shorter than the range starts part way along.
 */
function sparklineFor(
  range: PositionGlanceSparkRange,
  days: number,
  series: readonly PositionGlancePrice[],
  averageCost: number,
  today: string,
  heldSpans: readonly HeldSpan[]
): PositionGlanceSparklineDto {
  const toN = Math.max(dayNumber(today), dayNumber(series[series.length - 1]!.date));
  const fromN = days > 0 ? toN - (days - 1) : dayNumber(series[0]!.date);
  const from = ymdOfDayNumber(fromN);
  const inRange = series.filter((c) => c.date >= from);
  const sampled = sampleIndices(inRange.length, POSITION_GLANCE_SPARK_MAX_POINTS).map((i) => inRange[i]!);
  const lo = Math.min(averageCost, ...sampled.map((p) => p.price));
  const hi = Math.max(averageCost, ...sampled.map((p) => p.price));
  const ySpan = hi - lo;
  const yOf = (price: number) => (ySpan > 0 ? (price - lo) / ySpan : 0.5);
  const xSpan = toN - fromN;
  const points: PositionGlanceSparkPointDto[] = sampled.map((p) => ({
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
function priceSideOfCost(price: number, cost: number, quote: string): PositionGlanceDto["price_vs_cost"] {
  const priceR = roundToCurrency(price, quote);
  const costR = roundToCurrency(cost, quote);
  return priceR > costR ? "above" : priceR < costR ? "below" : "equal";
}

/** The price track: average cost, today's price and the highest price since first held. */
function trackFor(
  series: readonly PositionGlancePrice[],
  firstHeld: string,
  cost: number,
  price: number,
  side: PositionGlanceDto["price_vs_cost"],
  q: string
): PositionGlanceDto["track"] {
  // Highest price since first held (today's price counts); ties keep the earliest day.
  const held = series.filter((c) => c.date >= firstHeld);
  let high = held[0]!;
  for (const c of held) if (c.price > high.price) high = c;
  const range = positionTrackRange([cost, price, high.price]);
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

/**
 * The «value» bar: value = deposited + state bonus + price result + dividends (price result is the
 * rest). One rule for every sign: the bar's length is the sum of the positive parts, drawn left to
 * right in that order; every negative part overlays the bar's tail — a negative price result
 * (`loss`) at the far right, net withdrawn capital (`withdrawn`, deposited < 0) just left of it — so
 * `value_share` = value ÷ length marks where the value still held ends. With no negative part the
 * bar is the value and `value_share` is 1. Null only when deposited is unknown (a missing rate).
 * Shared by the position and the basket glance (`basketGlance.ts`).
 */
export function compositionFromParts(p: {
  accountLabel: string;
  asOf: string;
  isToday: boolean;
  unit: string;
  value: number;
  deposited: number | null;
  stateBonus: number | null;
  dividends: number;
}): PositionGlanceDto["composition"] {
  if (p.deposited == null || !Number.isFinite(p.deposited)) return null;
  const bonus = p.stateBonus ?? 0;
  if (!(p.dividends >= 0)) throw new Error(`${p.accountLabel}: dividends ${p.dividends} are negative`);
  if (!(bonus >= 0)) throw new Error(`${p.accountLabel}: state bonus ${bonus} is negative`);
  if (!(p.value >= 0)) throw new Error(`${p.accountLabel}: value ${p.value} on ${p.asOf} is negative`);
  const deposited = p.deposited;
  const price = p.value - deposited - bonus - p.dividends;
  const parts = [
    ["deposited", deposited],
    ["state_bonus", bonus],
    ["price", price],
    ["dividends", p.dividends],
  ] as const;
  const length = parts.reduce((sum, [, amount]) => sum + Math.max(0, amount), 0);
  const segments: PositionGlanceSegmentDto[] = [];
  let at = 0;
  for (const [kind, amount] of parts) {
    if (!(amount > 0)) continue;
    segments.push({ kind, amount, start: at, share: amount / length });
    at += amount / length;
  }
  // Negative parts over the tail, the loss at the far right and the withdrawn capital before it.
  let tail = 1;
  for (const [kind, amount] of [
    ["loss", price],
    ["withdrawn", deposited],
  ] as const) {
    if (!(amount < 0) || !(length > 0)) continue;
    const share = -amount / length;
    tail -= share;
    segments.push({ kind, amount: -amount, start: tail, share });
  }
  const money = (value: number) => ({ value, currency: p.unit });
  return {
    as_of: p.asOf,
    is_today: p.isToday,
    value: money(p.value),
    deposited: money(deposited),
    state_bonus: p.stateBonus == null ? null : money(p.stateBonus),
    price: money(price),
    price_direction: direction(price),
    dividends: money(p.dividends),
    segments,
    value_share: length > 0 ? p.value / length : 0,
  };
}

/** The block from its inputs (pure). */
export function positionGlanceFromInputs(inp: PositionGlanceInputs): PositionGlanceDto {
  const q = inp.quoteCurrency;
  const u = inp.unit;
  if (!(inp.price > 0) || !Number.isFinite(inp.price)) {
    throw new Error(`Account ${inp.accountId}: ${inp.title} has no price today (${inp.price})`);
  }
  if (!(inp.averageCost > 0) || !Number.isFinite(inp.averageCost)) {
    throw new Error(`Account ${inp.accountId}: ${inp.title} average cost ${inp.averageCost} is not a positive price`);
  }
  if (!Number.isFinite(inp.value)) throw new Error(`Account ${inp.accountId}: no value today`);
  const money = (value: number, currency: string) => ({ value, currency });

  // The full price series through today's price (today's point = the quote's price).
  const series: PositionGlancePrice[] = [
    ...inp.closes.filter((c) => c.date < inp.priceAsOf && Number.isFinite(c.price) && c.price > 0),
    { date: inp.priceAsOf, price: inp.price },
  ];
  const sparklines = POSITION_GLANCE_SPARK_RANGES.map(({ range, days }) =>
    sparklineFor(range, days, series, inp.averageCost, inp.today, inp.heldSpans)
  );

  // Track and the price's side of the cost.
  const priceVsCost = priceSideOfCost(inp.price, inp.averageCost, q);
  const track = trackFor(series, inp.firstHeld, inp.averageCost, inp.price, priceVsCost, q);

  // Composition.
  const pos = inp.position;
  const composition = compositionFromParts({
    accountLabel: `Account ${inp.accountId}`,
    asOf: pos.asOf,
    isToday: pos.isToday,
    unit: u,
    value: pos.value,
    deposited: pos.deposited,
    stateBonus: pos.stateBonus,
    dividends: pos.dividends,
  });

  // Periods.
  const largest = Math.max(
    ...(["day", "month", "year"] as const).map((k) => {
      const pl = inp.periods[k].pl;
      return pl != null && Number.isFinite(pl) ? Math.abs(pl) : 0;
    })
  );
  const period = (k: "day" | "month" | "year"): PositionGlancePeriodDto => {
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
    title: inp.title,
    instrument: inp.instrument,
    unit: u,
    value: money(inp.value, u),
    quote: { price: money(inp.price, q), price_as_of: inp.priceAsOf },
    sparklines,
    track,
    price_vs_cost: priceVsCost,
    composition,
    periods: { day: period("day"), month: period("month"), year: period("year") },
    basket: inp.basket,
  };
}

/**
 * Σ open cost ÷ Σ open units of the account's FIFO open lots, in `quoteCurrency`; checked against
 * the units the ledger holds (`expectedUnits`). Null when no units are held: zero units have no
 * cost per unit.
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
    throw new Error(`Account ${accountId}: the open tax lots hold ${units} units but the ledger holds ${expectedUnits}`);
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

/** One movement's units for the account, on its day. */
type UnitDelta = { day: string; delta: number };

/**
 * What differs per kind of unit position: what the units are and where they come from, the
 * instrument priced, the lot walk and the instrument's facts.
 */
type KindParts = {
  holding: Exclude<InstrumentHolding, { kind: "option" }>;
  /** The account's unit movements (the ledger the value reads). */
  unitDeltas: () => UnitDelta[];
  /** Units at or below this are an empty position. */
  unitsEps: number;
  /** The lot walk and the currency its amounts are in. */
  lots: () => { currency: string | null; events: TaxLotEvent[] };
  /** The title line's name and the instrument's facts, given today's price. */
  facts: (px: HoldingPrice, today: string, now: Date) => { title: string; instrument: PositionGlanceInstrumentDto };
};

const stmtShareUnitRows = db.prepare(
  `SELECT id, occurred_on, account_id, from_account_id, to_account_id, units_delta, counter_units_delta, flow_kind
   FROM movements
   WHERE (account_id = ? OR from_account_id = ? OR to_account_id = ?)
     AND flow_kind IN (${BROKERAGE_SHARE_UNITS_FLOW_KINDS.map(() => "?").join(", ")})`
);

function shareUnitDeltas(accountId: number): UnitDelta[] {
  const rows = stmtShareUnitRows.all(accountId, accountId, accountId, ...BROKERAGE_SHARE_UNITS_FLOW_KINDS) as MovementTransferRow[];
  return rows.map((r) => ({ day: r.occurred_on.slice(0, 10), delta: unitsDeltaForAccountMovement(r, accountId) }));
}

function ledgerUnitDeltas(accountId: number): UnitDelta[] {
  return loadFundUnitRows(accountId).map((r) => ({
    day: r.occurred_on.slice(0, 10),
    delta: ledgerUnitsDeltaForAccountMovement(r, accountId),
  }));
}

function marketFacts(ticker: string, now: Date): { title: string; instrument: PositionGlanceInstrumentDto } {
  const symbol = requireMarketSymbol(ticker);
  return {
    title: symbol.display_symbol,
    instrument: {
      kind: "market",
      ticker: symbol.display_symbol,
      name: symbol.name,
      market_kind: symbol.market_kind,
      session: shouldUseLiveEquityQuote(ticker, equitySessionYmdForTicker(ticker, now), now) ? "open" : "closed",
    },
  };
}

/** What the fund's series is, from the account's profile (never parsed beyond the AFP display key). */
function fundSeries(profile: AccountProfile, seriesKey: string): PositionGlanceFundSeriesDto {
  if (profile.quantity.kind === "fintual_goal") {
    const goal = fintualGoalBySeriesKey(seriesKey);
    return goal ? { kind: "fintual", series_key: seriesKey, name: goal.fundName } : { kind: "other", series_key: seriesKey };
  }
  if (profile.kind === "afp") {
    const parsed = parseAfpDisplaySeriesKey(seriesKey);
    if (!parsed) throw new Error(`Account ${profile.id}: AFP series key «${seriesKey}» is not afp_<afp>_cuota_<fund>`);
    return { kind: "afp", series_key: seriesKey, manager: parsed.afp, fund: parsed.fund };
  }
  if (profile.kind === "afc") return { kind: "afc", series_key: seriesKey };
  return { kind: "other", series_key: seriesKey };
}

/** The kind's parts, or null for an account that is not a unit position. */
function kindParts(profile: AccountProfile): KindParts | null {
  const accountId = profile.id;
  const q = profile.quantity;
  const h = profile.holding;
  switch (q.kind) {
    case "stock": {
      if (h.kind !== "stock") throw new Error(`Account ${accountId}: a share position that holds no stock`);
      return {
        holding: h,
        unitDeltas: () => shareUnitDeltas(accountId),
        unitsEps: TAX_LOT_UNITS_EPS,
        lots: () => loadEquityTaxLotEvents(accountId),
        facts: (_px, _today, now) => marketFacts(q.ticker, now),
      };
    }
    case "coin": {
      if (h.kind !== "coin") throw new Error(`Account ${accountId}: a coin position that holds no coin`);
      return {
        holding: h,
        unitDeltas: () => ledgerUnitDeltas(accountId),
        unitsEps: TAX_LOT_UNITS_EPS,
        // Buda's trades settle in pesos. The display cost is the pesos the ledger paid (`included`,
        // the money the deposits count), never the SII's commission-excluded basis: it must not
        // depend on the exchange's trade records being complete.
        lots: () => ({ currency: "clp", events: loadCryptoTaxLotEvents(accountId, "included") }), // convention-ok: the crypto lot walk is in pesos by construction (Buda)
        facts: (_px, _today, now) => marketFacts(q.priceTicker, now),
      };
    }
    case "cuota_ledger":
    case "fintual_goal": {
      if (h.kind !== "fund") throw new Error(`Account ${accountId}: a cuota position that holds no fund`);
      const quote = h.quote;
      const toQuote = (amount: number, currency: string, ymd: string): number => {
        if (currency === quote) return amount;
        const v = convertCurrency(amount, currency as CurrencyCode, quote, ymd, { side: "mid", storedOnly: true });
        if (v == null) throw new Error(`Account ${accountId}: no ${currency}/${quote} rate on ${ymd} for a cuota's cost`);
        return v;
      };
      return {
        holding: h,
        unitDeltas: () => ledgerUnitDeltas(accountId),
        unitsEps: FUND_UNITS_EPS,
        lots: () => ({ currency: quote, events: loadFundTaxLotEvents(accountId, toQuote) }),
        facts: (px, today) => {
          const published = fundUnitRowOnOrBeforeForDisplay(q.seriesKey, today);
          if (!published) throw new Error(`Account ${accountId}: no published ${q.seriesKey} valor cuota on or before ${today}`);
          return {
            title: profile.name,
            instrument: {
              kind: "fund",
              series: fundSeries(profile, q.seriesKey),
              price_source: px.source === "proxy" ? "proxy" : "official",
              published_on: published.day,
            },
          };
        },
      };
    }
    default:
      return null;
  }
}

/**
 * The stretches the account held units: its unit movements summed per day; a stretch starts the
 * day the total turns positive and ends the day it returns to zero (null while still held).
 */
function heldSpansFromDeltas(deltas: readonly UnitDelta[], eps: number): HeldSpan[] {
  const byDay = new Map<string, number>();
  for (const d of deltas) byDay.set(d.day, (byDay.get(d.day) ?? 0) + d.delta);
  const spans: HeldSpan[] = [];
  let units = 0;
  for (const day of [...byDay.keys()].sort()) {
    const before = units;
    units += byDay.get(day)!;
    if (before <= eps && units > eps) spans.push({ from: day, to: null });
    else if (before > eps && units <= eps) spans[spans.length - 1]!.to = day;
  }
  return spans;
}

/** The stretches a unit-position account held units (empty for any other account). */
export function positionHeldSpans(accountId: number): HeldSpan[] {
  const profile = accountProfileOptional(accountId);
  const parts = profile ? kindParts(profile) : null;
  return parts ? heldSpansFromDeltas(parts.unitDeltas(), parts.unitsEps) : [];
}

/** True when the account is a unit position (a stock, a coin or a fund). */
export function isUnitPositionAccount(accountId: number): boolean {
  const profile = accountProfileOptional(accountId);
  return profile != null && kindParts(profile) != null;
}

/** A proxied fund's basket: the latest stated ETFs with their share of today's value. */
function basketFor(seriesKey: string, value: number, unit: string, now: Date): PositionGlanceBasketDto | null {
  if (!isRiskyNorrisProxyMtmSeries(seriesKey)) return null;
  const bucket = proxyBucketSlugForSeriesKey(seriesKey);
  if (bucket == null) throw new Error(`positionGlance: proxied series ${seriesKey} has no basket`);
  const b = loadProxyBasketBreakdown(bucket, { now, unit: unit as CurrencyCode });
  if (b == null) return null;
  const money = (share: number) => ({ value: share * value, currency: unit });
  const rows: PositionGlanceBasketDto["rows"] = b.holdings.map((h) => ({
    kind: "holding" as const,
    ticker: h.ticker,
    name: marketSymbol(h.price_ticker)?.name ?? null,
    share: h.weight,
    value: money(h.weight),
  }));
  if (b.other_weight > 0) rows.push({ kind: "other", share: b.other_weight, value: money(b.other_weight) });
  return { positions_date: b.positions_date, rows };
}

/** What the bundle already computed for the account (its position and dashboard row), in `unit`. */
export type PositionGlanceBundleFigures = {
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
 * The block for an account as of now; null unless it is a unit position (a stock, a coin or a
 * fund) that has held units at some point.
 */
export function buildPositionGlanceForAccount(
  accountId: number,
  figures: PositionGlanceBundleFigures,
  now: Date = new Date()
): PositionGlanceDto | null {
  const profile = accountProfileOptional(accountId);
  const parts = profile ? kindParts(profile) : null;
  if (!profile || !parts) return null;

  // One rule for a position held or sold out: measured on its last day holding units — today
  // while it holds any, else the day before the movement that emptied it.
  const deltas = parts.unitDeltas();
  const heldSpans = heldSpansFromDeltas(deltas, parts.unitsEps);
  const lastSpan = heldSpans[heldSpans.length - 1];
  // Never held a unit (an account opened before its first purchase): no position to show.
  if (lastSpan == null) return null;
  const pos = figures.position;
  if (pos == null || pos.value == null) throw new Error(`Account ${accountId}: no value today`);
  if (figures.row == null) throw new Error(`Account ${accountId}: unit position without a dashboard row`);
  const today = chileWallClockAt(now).ymd;
  const asOf = lastSpan.to == null ? today : ymdOfDayNumber(dayNumber(lastSpan.to) - 1);
  let units = 0;
  for (const d of deltas) if (d.day <= asOf) units += d.delta;
  if (!(units > parts.unitsEps)) throw new Error(`Account ${accountId}: no units on its last day held ${asOf}`);

  const holding = parts.holding;
  const quote = holding.quote;
  const px = holdingPriceAt(holding, today, { now });
  if (!px) throw new Error(`Account ${accountId}: no unit price today`);
  if (px.currency !== quote) throw new Error(`Account ${accountId}: priced in ${px.currency}, quoted in ${quote}`);
  const closes = unitPriceSeries(holding, px.as_of);

  const { currency: lotCurrency, events } = parts.lots();
  const { openLots } = realizeTaxLots(
    events.filter((e) => e.date <= asOf),
    "fifo"
  );
  const averageCost = averageCostFromOpenLots(accountId, openLots, lotCurrency, quote, units);
  if (averageCost == null) throw new Error(`Account ${accountId}: no open lots for the ${units} units held on ${asOf}`);

  const unit = figures.unit as CurrencyCode;
  const valueThen = accountValueAt(accountId, asOf, unit, { now });
  if (valueThen == null) throw new Error(`Account ${accountId}: no value on ${asOf}`);
  let depositedThen = 0;
  for (const e of getMergedDisplayDepositInflowEventsForAccount(accountId)) {
    if (e.occurred_on <= asOf) depositedThen += flowEventInUnit(e, unit);
  }
  const bonusEvents = getStateContributionInflowEventsForAccount(accountId);
  let bonusThen: number | null = null;
  if (bonusEvents.length > 0) {
    bonusThen = 0;
    for (const e of bonusEvents) if (e.occurred_on <= asOf) bonusThen += flowEventInUnit(e, unit);
  }

  const { title, instrument } = parts.facts(px, today, now);
  const isToday = asOf === today;
  const r = figures.row;
  return positionGlanceFromInputs({
    accountId,
    title,
    instrument,
    unit: figures.unit,
    quoteCurrency: quote,
    price: px.price,
    priceAsOf: px.as_of,
    today,
    firstHeld: heldSpans[0]!.from,
    heldSpans,
    closes,
    averageCost,
    value: pos.value,
    position: {
      asOf,
      isToday,
      value: valueThen.value,
      deposited: depositedThen,
      stateBonus: bonusThen,
      dividends: totalDividendsInUnitForAccount(accountId, unit, asOf),
    },
    periods: {
      day: { pl: r.delta_day ?? null, pct: r.pct_day ?? null },
      month: { pl: r.delta_month ?? null, pct: r.pct_month ?? null },
      year: { pl: r.delta_year ?? null, pct: r.pct_year ?? null },
    },
    // The basket is today's: shown while the fund holds cuotas.
    basket: holding.kind === "fund" && isToday ? basketFor(holding.seriesKey, pos.value, figures.unit, now) : null,
  });
}
