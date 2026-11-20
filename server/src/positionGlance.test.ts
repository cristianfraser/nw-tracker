import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "./db.js";
import { accountUsesEquityMtm } from "./brokerageEquityMtm.js";
import { leafAssetGroupIdForKindSlug } from "./assetGroupTree.js";
import {
  buildPositionGlanceForAccount,
  isUnitPositionAccount,
  positionGlanceFromInputs,
  positionHeldSpans,
  positionTrackRange,
  POSITION_GLANCE_SPARK_MAX_POINTS,
  type PositionGlanceBundleFigures,
  type PositionGlanceInputs,
} from "./positionGlance.js";
import { fundTaxLotEventsFromRows, type FundLotRow } from "./fundTaxLotEvents.js";
import { realizeTaxLots } from "./taxLots.js";
import { convertCurrency } from "./rates.js";
import { marketSymbol, reloadMarketSymbols } from "./marketSymbols.js";
import { accountProfile } from "./accountProfile.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { holdingPriceAt } from "./holdingPrices.js";
import { declareTestInstrument } from "./test/instrumentFixtures.js";
import * as riskyNorrisProxyMtm from "./riskyNorrisProxyMtm.js";
import * as proxyBasketBreakdown from "./proxyBasketBreakdown.js";

function inputs(over: Partial<PositionGlanceInputs> = {}): PositionGlanceInputs {
  return {
    accountId: 1,
    title: "VGL",
    instrument: { kind: "market", ticker: "VGL", name: "Vitest Glance ETF", market_kind: "nyse", session: "closed" },
    unit: "clp",
    quoteCurrency: "usd",
    price: 72,
    priceAsOf: "2026-11-13",
    today: "2026-11-13",
    firstHeld: "2026-03-02",
    heldSpans: [{ from: "2026-03-02", to: null }],
    closes: [
      { date: "2026-03-02", price: 60 },
      { date: "2026-09-01", price: 90 },
      { date: "2026-11-12", price: 70 },
    ],
    averageCost: 69,
    value: 1_000_000,
    position: { asOf: "2026-11-13", isToday: true, value: 1_000_000, deposited: 900_000, stateBonus: null, dividends: 20_000 },
    periods: {
      day: { pl: -10_000, pct: -0.01 },
      month: { pl: -40_000, pct: -0.04 },
      year: { pl: 20_000, pct: 0.02 },
    },
    basket: null,
    ...over,
  };
}

const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);

describe("positionGlanceFromInputs — composition", () => {
  it("splits a gain as deposited + price + dividends, segments filling the bar", () => {
    const g = positionGlanceFromInputs(inputs());
    const c = g.composition!;
    expect(c.price.value).toBe(80_000);
    expect(c.state_bonus).toBeNull();
    expect(c.deposited.value + c.price.value + c.dividends.value).toBe(g.value.value);
    expect(c.segments.map((s) => s.kind)).toEqual(["deposited", "price", "dividends"]);
    expect(sum(c.segments.map((s) => s.share))).toBeCloseTo(1, 12);
    expect(sum(c.segments.map((s) => s.amount))).toBe(1_000_000);
    expect(c.segments[1]!.start).toBeCloseTo(0.9, 12);
    expect(c.segments[2]!.start).toBeCloseTo(0.98, 12);
    expect(c.value_share).toBe(1);
    expect(c.price_direction).toBe("up");
    expect(c.value).toEqual({ value: 1_000_000, currency: "clp" });
  });

  it("draws a price loss over the end of a bar of deposited + dividends", () => {
    const g = positionGlanceFromInputs(inputs({ position: { ...inputs().position, value: 850_000 } }));
    const c = g.composition!;
    expect(c.price.value).toBe(-70_000);
    expect(c.price_direction).toBe("down");
    expect(c.deposited.value + c.price.value + c.dividends.value).toBe(850_000);
    const [dep, div, loss] = c.segments;
    expect([dep!.kind, div!.kind, loss!.kind]).toEqual(["deposited", "dividends", "loss"]);
    // The bar is deposited + dividends; those two fill it, the loss overlays its last |price|.
    expect(dep!.share + div!.share).toBeCloseTo(1, 12);
    expect(loss!.amount).toBe(70_000);
    expect(c.value_share).toBeCloseTo(850_000 / 920_000, 12);
    expect(loss!.start).toBeCloseTo(c.value_share, 12);
    expect(loss!.start + loss!.share).toBeCloseTo(1, 12);
    expect(loss!.share * 920_000).toBeCloseTo(70_000, 6);
  });

  it("puts the state bonus in its own segment, outside the personal deposits", () => {
    const pos = { asOf: "2026-11-13", isToday: true, value: 1_000_000, deposited: 800_000, stateBonus: 120_000, dividends: 0 };
    const g = positionGlanceFromInputs(inputs({ position: pos }));
    const c = g.composition!;
    expect(c.state_bonus).toEqual({ value: 120_000, currency: "clp" });
    expect(c.price.value).toBe(80_000);
    expect(c.deposited.value + c.state_bonus!.value + c.price.value + c.dividends.value).toBe(1_000_000);
    expect(c.segments.map((s) => s.kind)).toEqual(["deposited", "state_bonus", "price"]);
    expect(c.segments[1]!.start).toBeCloseTo(0.8, 12);
    expect(c.segments[1]!.share).toBeCloseTo(0.12, 12);
    // A loss: the bar is deposited + bonus, the loss over its end.
    const lost = positionGlanceFromInputs(inputs({ position: { ...pos, value: 870_000 } })).composition!;
    expect(lost.segments.map((s) => s.kind)).toEqual(["deposited", "state_bonus", "loss"]);
    expect(lost.value_share).toBeCloseTo(870_000 / 920_000, 12);
    expect(lost.segments[0]!.share + lost.segments[1]!.share).toBeCloseTo(1, 12);
  });

  it("leaves zero segments out and is null only without a known deposited", () => {
    const g = positionGlanceFromInputs(inputs({ position: { ...inputs().position, dividends: 0 } }));
    expect(g.composition!.segments.map((s) => s.kind)).toEqual(["deposited", "price"]);
    expect(positionGlanceFromInputs(inputs({ position: { ...inputs().position, deposited: null } })).composition).toBeNull();
  });

  it("overlays net withdrawn capital on the tail when more came out than went in", () => {
    // 300 more withdrawn than deposited, 120 still held: a 420 gain, the last 300 of it taken out.
    const g = positionGlanceFromInputs(
      inputs({ position: { ...inputs().position, value: 120, deposited: -300, dividends: 0, stateBonus: null } })
    );
    const c = g.composition!;
    expect(c.price.value).toBe(420);
    expect(c.segments).toEqual([
      { kind: "price", amount: 420, start: 0, share: 1 },
      { kind: "withdrawn", amount: 300, start: 1 - 300 / 420, share: 300 / 420 },
    ]);
    expect(c.value_share).toBeCloseTo(120 / 420, 12);
    expect(c.deposited.value + c.price.value + c.dividends.value).toBe(c.value.value);
  });

  it("puts the loss at the far right and the withdrawn capital just before it", () => {
    // value 10, deposited −50, dividends 80 → price −20; the bar is the 80 of dividends.
    const c = positionGlanceFromInputs(
      inputs({ position: { ...inputs().position, value: 10, deposited: -50, dividends: 80, stateBonus: null } })
    ).composition!;
    expect(c.segments.map((s) => s.kind)).toEqual(["dividends", "loss", "withdrawn"]);
    const loss = c.segments.find((s) => s.kind === "loss")!;
    const out = c.segments.find((s) => s.kind === "withdrawn")!;
    expect(loss.start).toBeCloseTo(0.75, 12);
    expect(out.start).toBeCloseTo(0.125, 12);
    expect(out.start + out.share).toBeCloseTo(loss.start, 12);
    expect(c.value_share).toBeCloseTo(10 / 80, 12);
  });
});

describe("positionGlanceFromInputs — quote, sparkline and track", () => {
  it("serves the quote, the instrument as given and the high since first held", () => {
    // A higher close before the first day held does not count as the high.
    const g = positionGlanceFromInputs(
      inputs({ closes: [{ date: "2026-02-27", price: 99 }, ...inputs().closes] })
    );
    expect(g.title).toBe("VGL");
    expect(g.instrument).toEqual(inputs().instrument);
    expect(g.quote).toEqual({ price: { value: 72, currency: "usd" }, price_as_of: "2026-11-13" });
    expect(g.track.high.price.value).toBe(90);
    expect(g.track.high.date).toBe("2026-09-01");
    expect(g.track.high.pct_from_high).toBeCloseTo(72 / 90 - 1, 12);
    expect(g.basket).toBeNull();
  });

  it("serves one sparkline per range, every axis the whole range, points placed by day", () => {
    const g = positionGlanceFromInputs(inputs());
    expect(g.sparklines.map((l) => l.range)).toEqual(["30d", "60d", "90d", "1y", "3y", "5y", "10y", "total"]);
    for (const l of g.sparklines) {
      expect(l.to).toBe("2026-11-13");
      expect(l.points[l.points.length - 1]).toMatchObject({ date: "2026-11-13", price: 72, x: 1 });
      for (const p of l.points) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(1);
        expect(p.y).toBeCloseTo((p.price - l.low) / (l.high - l.low), 12);
      }
      expect(l.cost_y).toBeCloseTo((69 - l.low) / (l.high - l.low), 12);
    }
    // A year: 366 days ending today, the history (from 2026-03-02) starting part way along.
    const year = g.sparklines.find((l) => l.range === "1y")!;
    expect(year.from).toBe("2025-11-13");
    expect(year.points[0]).toMatchObject({ date: "2026-03-02", price: 60 });
    expect(year.points[0]!.x).toBeCloseTo(109 / 365, 12);
    expect([year.low, year.high]).toEqual([60, 90]);
    // Thirty days: only the closes inside it; the cost still on the vertical range.
    const month = g.sparklines.find((l) => l.range === "30d")!;
    expect(month.from).toBe("2026-10-15");
    expect(month.points.map((p) => p.price)).toEqual([70, 72]);
    expect([month.low, month.high]).toEqual([69, 72]);
    // Held from 2026-03-02 on: the year's axis is held from that day to its end.
    expect(year.held).toHaveLength(1);
    expect(year.held[0]!.start).toBeCloseTo(109 / 365, 12);
    expect(year.held[0]!.end).toBe(1);
    expect(month.held).toEqual([{ start: 0, end: 1 }]);
    // Total: from the first stored close.
    const total = g.sparklines.find((l) => l.range === "total")!;
    expect(total.from).toBe("2026-03-02");
    expect(total.points[0]!.x).toBe(0);
  });

  it("marks only the stretches held, a sold-out gap left unheld", () => {
    const g = positionGlanceFromInputs(
      inputs({
        heldSpans: [
          { from: "2026-03-02", to: "2026-05-01" },
          { from: "2026-09-01", to: null },
        ],
      })
    );
    const year = g.sparklines.find((l) => l.range === "1y")!;
    expect(year.held).toHaveLength(2);
    expect(year.held[0]!.end).toBeCloseTo(169 / 365, 12);
    expect(year.held[1]!.start).toBeCloseTo(292 / 365, 12);
    // Thirty days, all inside the open stretch.
    expect(g.sparklines.find((l) => l.range === "30d")!.held).toEqual([{ start: 0, end: 1 }]);
  });

  it("samples a long history down to the point budget, first and last kept", () => {
    const start = Date.parse("2016-01-01T00:00:00Z");
    const closes = Array.from({ length: 2500 }, (_, i) => ({
      date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
      price: 50 + (i % 7),
    }));
    const last = closes[closes.length - 1]!.date;
    const asOf = new Date(Date.parse(`${last}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const g = positionGlanceFromInputs(inputs({ closes, priceAsOf: asOf, today: asOf, firstHeld: closes[0]!.date }));
    const total = g.sparklines.find((l) => l.range === "total")!;
    expect(total.points.length).toBeLessThanOrEqual(POSITION_GLANCE_SPARK_MAX_POINTS);
    expect(total.points[0]!.date).toBe(closes[0]!.date);
    expect(total.points[total.points.length - 1]!.date).toBe(asOf);
  });

  it("places cost, price and high on a rounded track with the fill between cost and price", () => {
    const g = positionGlanceFromInputs(inputs({ averageCost: 41.27, price: 43.86, closes: [{ date: "2026-10-06", price: 47.9 }] }));
    expect(g.track.min.value).toBe(40);
    expect(g.track.max.value).toBe(50);
    expect(g.track.cost.share).toBeCloseTo(0.127, 12);
    expect(g.track.price.share).toBeCloseTo(0.386, 12);
    expect(g.track.high.share).toBeCloseTo(0.79, 12);
    expect(g.track.fill).toEqual({ start: g.track.cost.share, end: g.track.price.share, side: "gain" });
    expect(g.price_vs_cost).toBe("above");
  });

  it("decides price vs cost at the quote currency's cents", () => {
    expect(positionGlanceFromInputs(inputs({ price: 60, averageCost: 69 })).price_vs_cost).toBe("below");
    const below = positionGlanceFromInputs(inputs({ price: 60, averageCost: 69 }));
    expect(below.track.fill.side).toBe("loss");
    expect(below.track.fill.start).toBeCloseTo(below.track.price.share, 12);
    expect(below.track.fill.end).toBeCloseTo(below.track.cost.share, 12);
    const equal = positionGlanceFromInputs(inputs({ price: 69.004, averageCost: 68.996 }));
    expect(equal.price_vs_cost).toBe("equal");
    expect(equal.track.fill.side).toBe("none");
    expect(equal.track.fill.start).toBe(equal.track.fill.end);
    expect(positionGlanceFromInputs(inputs({ price: 69.006, averageCost: 68.996 })).price_vs_cost).toBe("above");
    // A peso-quoted fund compares at whole pesos.
    expect(positionGlanceFromInputs(inputs({ quoteCurrency: "clp", price: 1000.4, averageCost: 999.6 })).price_vs_cost).toBe("equal");
  });

  it("rounds the track outwards to a 1/2/5 step and never collapses it", () => {
    expect(positionTrackRange([41.27, 43.86, 47.9])).toEqual({ min: 40, max: 50 });
    expect(positionTrackRange([1_230, 1_480])).toEqual({ min: 1_200, max: 1_600 });
    const flat = positionTrackRange([50, 50, 50]);
    expect(flat.min).toBeLessThanOrEqual(50);
    expect(flat.max).toBeGreaterThan(flat.min);
  });
});

describe("positionGlanceFromInputs — periods", () => {
  it("scales each bar by the largest |P/L| of the three", () => {
    const g = positionGlanceFromInputs(inputs());
    expect(g.periods.month.share).toBe(1);
    expect(g.periods.day.share).toBeCloseTo(0.25, 12);
    expect(g.periods.year.share).toBeCloseTo(0.5, 12);
    expect(g.periods.day.direction).toBe("down");
    expect(g.periods.year.direction).toBe("up");
    expect(g.periods.year.pl).toEqual({ value: 20_000, currency: "clp" });
    expect(g.periods.year.pct).toBe(0.02);
  });

  it("reads 0 shares when every period is 0 or unknown", () => {
    const g = positionGlanceFromInputs(
      inputs({
        periods: { day: { pl: 0, pct: 0 }, month: { pl: null, pct: null }, year: { pl: 0, pct: null } },
      })
    );
    expect([g.periods.day.share, g.periods.month.share, g.periods.year.share]).toEqual([0, 0, 0]);
    expect(g.periods.month).toEqual({ pl: null, pct: null, share: 0, direction: "flat" });
    expect(g.periods.day.direction).toBe("flat");
  });
});

// ---------- The fund lot walk ----------

function row(over: Partial<FundLotRow> & { id: number; occurred_on: string }): FundLotRow {
  return {
    account_id: 1,
    from_account_id: null,
    to_account_id: null,
    amount: 0,
    currency: "clp",
    counter_amount: null,
    counter_currency: null,
    note: null,
    units_delta: null,
    counter_units_delta: null,
    flow_kind: null,
    ...over,
  };
}
const sameCurrency = (amount: number) => amount;

describe("fundTaxLotEventsFromRows", () => {
  it("acquires cuota inflows at their pesos and disposes outflows FIFO", () => {
    const events = fundTaxLotEventsFromRows(
      1,
      [
        row({ id: 1, occurred_on: "2026-03-02", amount: 10_000, units_delta: 10 }),
        row({ id: 2, occurred_on: "2026-06-01", account_id: null, from_account_id: 9, to_account_id: 1, amount: 7_500, units_delta: 5 }),
        row({ id: 3, occurred_on: "2026-07-01", amount: -6_400, units_delta: -4 }),
      ],
      sameCurrency
    );
    expect(events).toEqual([
      { kind: "acquire", date: "2026-03-02", movementId: 1, units: 10, cost: 10_000 },
      { kind: "acquire", date: "2026-06-01", movementId: 2, units: 5, cost: 7_500 },
      { kind: "dispose", date: "2026-07-01", movementId: 3, units: 4, proceeds: 6_400 },
    ]);
    const { openLots } = realizeTaxLots(events, "fifo");
    expect(openLots.map((l) => [l.units, l.cost])).toEqual([
      [6, 6_000],
      [5, 7_500],
    ]);
  });

  it("moves an AFP switch's cost: egress at the pesos it produced, ingress at the same pesos for the bought cuotas", () => {
    const sw = row({
      id: 5,
      occurred_on: "2026-07-01",
      account_id: null,
      from_account_id: 1,
      to_account_id: 2,
      amount: 660_000,
      units_delta: 15,
      counter_units_delta: 20,
      flow_kind: "afp_fund_switch",
    });
    expect(fundTaxLotEventsFromRows(1, [sw], sameCurrency)).toEqual([
      { kind: "dispose", date: "2026-07-01", movementId: 5, units: 15, proceeds: 660_000 },
    ]);
    expect(fundTaxLotEventsFromRows(2, [sw], sameCurrency)).toEqual([
      { kind: "acquire", date: "2026-07-01", movementId: 5, units: 20, cost: 660_000 },
    ]);
  });

  it("disposes commissions at 0, acquires catch-up cuotas and the state bonus at 0 cost", () => {
    const events = fundTaxLotEventsFromRows(
      1,
      [
        row({ id: 1, occurred_on: "2026-03-02", amount: 400_000, units_delta: 100 }),
        row({ id: 2, occurred_on: "2026-04-01", amount: 1_500, units_delta: 1.5, flow_kind: "state_bonus" }),
        row({ id: 3, occurred_on: "2026-08-31", amount: -8_600, units_delta: -2, flow_kind: "cash_fee" }),
        row({ id: 4, occurred_on: "2026-09-30", amount: 4_350, units_delta: 1, flow_kind: "savings_earnings" }),
      ],
      sameCurrency
    );
    expect(events.map((e) => [e.kind, e.kind === "acquire" ? e.cost : e.kind === "dispose" ? e.proceeds : null])).toEqual([
      ["acquire", 400_000],
      ["acquire", 0],
      ["dispose", 0],
      ["acquire", 0],
    ]);
  });

  it("converts amounts into the fund's currency on their day", () => {
    const events = fundTaxLotEventsFromRows(
      1,
      [row({ id: 1, occurred_on: "2026-03-02", amount: 100, currency: "usd", units_delta: 4 })],
      (amount, currency, ymd) => {
        expect([currency, ymd]).toEqual(["usd", "2026-03-02"]);
        return amount * 900;
      }
    );
    expect(events).toEqual([{ kind: "acquire", date: "2026-03-02", movementId: 1, units: 4, cost: 90_000 }]);
  });

  it("throws on rows the ledger does not explain", () => {
    expect(() =>
      fundTaxLotEventsFromRows(1, [row({ id: 1, occurred_on: "2026-03-02", amount: -100, units_delta: 4 })], sameCurrency)
    ).toThrow(/moves 4 cuotas against -100/);
    expect(() =>
      fundTaxLotEventsFromRows(1, [row({ id: 1, occurred_on: "2026-03-02", amount: 100, units_delta: 1, flow_kind: "cash_fee" })], sameCurrency)
    ).toThrow(/commission 1 adds/);
    expect(() =>
      fundTaxLotEventsFromRows(
        1,
        [row({ id: 1, occurred_on: "2026-03-02", amount: -100, units_delta: -1, flow_kind: "savings_earnings" })],
        sameCurrency
      )
    ).toThrow(/catch-up cuotas 1 remove/);
  });
});

// ---------- From the database ----------

const PREFIX = "Vitest · position glance";
const TICKER = "VGLANCE";
const NOTE = "vitest:position-glance";
const created: { accounts: number[]; movements: number[]; series: string[]; equityRows: [string, string][] } = {
  accounts: [],
  movements: [],
  series: [],
  equityRows: [],
};
// A Saturday: NYSE is closed, the price is Friday's close.
const NOW = new Date("2026-11-14T15:00:00Z");
const TODAY = "2026-11-14";

function leafGroupIdBySlug(pattern: string): number {
  const row = db.prepare(`SELECT id FROM asset_groups WHERE slug LIKE ? ORDER BY slug LIMIT 1`).get(pattern) as
    | { id: number }
    | undefined;
  if (!row) throw new Error(`no ${pattern} leaf in the test DB`);
  return row.id;
}

function account(
  name: string,
  opts: { groupId?: number; ticker?: string | null; series?: string | null; goal?: string | null } = {}
): number {
  const id = Number(
    db
      .prepare(`INSERT INTO accounts (asset_group_id, name, equity_ticker, fund_series_key) VALUES (?, ?, ?, ?)`)
      .run(opts.groupId ?? leafGroupIdBySlug("brokerage_acciones__%"), `${PREFIX} ${name}`, opts.ticker ?? null, opts.series ?? null)
      .lastInsertRowid
  );
  created.accounts.push(id);
  if (opts.goal) db.prepare(`INSERT INTO account_roles (account_id, role, param) VALUES (?, 'fintual_goal', ?)`).run(id, opts.goal);
  return id;
}

function trade(from: number, to: number, on: string, units: number, amount: number, kind: "stock_buy" | "stock_sell"): void {
  created.movements.push(
    Number(
      db
        .prepare(
          `INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, flow_kind, units_delta)
           VALUES (?, ?, ?, 'usd', ?, ?, ?)`
        )
        .run(from, to, amount, on, kind, units).lastInsertRowid
    )
  );
}

/** A single-leg row on `accountId` (pesos signed for the account). */
function single(accountId: number, on: string, amount: number, units: number, flowKind: string | null = null): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta, flow_kind)
         VALUES (?, ?, 'clp', ?, ?, ?, ?)`
      )
      .run(accountId, amount, on, NOTE, units, flowKind).lastInsertRowid
  );
  created.movements.push(id);
  return id;
}

/** A peso transfer carrying units (an aporte from cash, a fund switch with `counterUnits`). */
function transfer(
  from: number,
  to: number,
  on: string,
  amount: number,
  units: number,
  opts: { counterUnits?: number; flowKind?: string } = {}
): void {
  created.movements.push(
    Number(
      db
        .prepare(
          `INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, note, units_delta, counter_units_delta, flow_kind)
           VALUES (?, ?, ?, 'clp', ?, ?, ?, ?, ?)`
        )
        .run(from, to, amount, on, NOTE, units, opts.counterUnits ?? null, opts.flowKind ?? null).lastInsertRowid
    )
  );
}

function fundSeries(seriesKey: string, rows: readonly [string, number][]): void {
  if (!created.series.includes(seriesKey)) created.series.push(seriesKey);
  const up = db.prepare(
    `INSERT INTO fund_unit_daily (series_key, day, unit_value, currency, note) VALUES (?, ?, ?, 'clp', ?)
     ON CONFLICT(series_key, day) DO UPDATE SET unit_value = excluded.unit_value, note = excluded.note`
  );
  for (const [day, v] of rows) up.run(seriesKey, day, v, NOTE);
}

function equityCloses(ticker: string, rows: readonly [string, number][]): void {
  const ins = db.prepare(`INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, ?, 'usd')`);
  for (const [d, c] of rows) {
    ins.run(ticker, d, c);
    created.equityRows.push([ticker, d]);
  }
}

const FIGURES: PositionGlanceBundleFigures = {
  unit: "clp",
  position: { units_kind: "shares", units: 11, value: 750_000, deposited: 700_000, dividends: 0 },
  row: { delta_day: 1_000, delta_month: -2_000, delta_year: 4_000, pct_day: 0.001, pct_month: -0.002, pct_year: 0.004 },
};
const figures = (value: number): PositionGlanceBundleFigures => ({ ...FIGURES, position: { ...FIGURES.position!, value } });

afterEach(() => {
  vi.restoreAllMocks();
  for (const id of created.movements.splice(0)) db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
  for (const id of created.accounts.splice(0)) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  for (const key of created.series.splice(0)) db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = ? AND note = ?`).run(key, NOTE);
  for (const [t, d] of created.equityRows.splice(0)) db.prepare(`DELETE FROM equity_daily WHERE ticker = ? AND trade_date = ?`).run(t, d);
  db.prepare(`DELETE FROM equity_daily WHERE ticker = ?`).run(TICKER);
  db.prepare(`DELETE FROM market_symbols WHERE ticker = ?`).run(TICKER);
  reloadMarketSymbols();
});

/** value = deposited + state bonus + price + dividends, to the cent. */
function expectCompositionIdentity(c: NonNullable<ReturnType<typeof positionGlanceFromInputs>["composition"]>): void {
  expect(c.deposited.value + (c.state_bonus?.value ?? 0) + c.price.value + c.dividends.value).toBeCloseTo(c.value.value, 6);
}

describe("buildPositionGlanceForAccount — stocks", () => {
  it("reads today's price, the closes since first held and the FIFO cost of the shares held", () => {
    declareTestInstrument(TICKER, { name: "Vitest Glance Fund" });
    const stock = account("stock", { ticker: TICKER });
    const cash = account("USD cash");
    trade(cash, stock, "2026-03-02", 10, 600, "stock_buy"); // 60 a share
    trade(cash, stock, "2026-06-01", 5, 400, "stock_buy"); // 80 a share
    trade(stock, cash, "2026-07-01", 4, 300, "stock_sell"); // FIFO: 4 of the 60s go
    equityCloses(TICKER, [
      ["2026-02-27", 55],
      ["2026-03-02", 60],
      ["2026-06-01", 80],
      ["2026-09-01", 90],
      ["2026-11-12", 70],
      ["2026-11-13", 72],
    ]);
    expect(accountUsesEquityMtm(stock)).toBe(true);

    const g = buildPositionGlanceForAccount(stock, FIGURES, NOW)!;
    expect(g).not.toBeNull();
    expect(g.title).toBe(TICKER);
    expect(g.instrument).toEqual({ kind: "market", ticker: TICKER, name: "Vitest Glance Fund", market_kind: "nyse", session: "closed" });
    expect(g.quote).toEqual({ price: { value: 72, currency: "usd" }, price_as_of: "2026-11-13" });
    // 6 shares at 60 + 5 at 80 over 11 shares.
    expect(g.track.cost.price.value).toBeCloseTo(760 / 11, 9);
    expect(g.price_vs_cost).toBe("above");
    // Every stored close of the instrument (the day before the first buy too), through today's price.
    const total = g.sparklines.find((l) => l.range === "total")!;
    expect(total.from).toBe("2026-02-27");
    expect(total.points.map((p) => p.price)).toEqual([55, 60, 80, 90, 70, 72]);
    expect(g.track.high).toMatchObject({ date: "2026-09-01" });
    expect(g.periods.month.pl).toEqual({ value: -2_000, currency: "clp" });
    expect(g.basket).toBeNull();
    // Held today: the split is today's position, value = deposited + price + dividends.
    const c = g.composition!;
    expect(c).toMatchObject({ as_of: TODAY, is_today: true, state_bonus: null });
    expectCompositionIdentity(c);
  });

  it("is null for an account that is not a unit position or never held a unit", () => {
    const plain = account("plain");
    expect(isUnitPositionAccount(plain)).toBe(false);
    expect(buildPositionGlanceForAccount(plain, FIGURES, NOW)).toBeNull();
  });

  it("measures a sold-out position on its last day held, through the same rules", () => {
    declareTestInstrument(TICKER);
    const stock = account("sold out", { ticker: TICKER });
    const cash = account("USD cash");
    trade(cash, stock, "2026-03-02", 10, 600, "stock_buy"); // 60 a share
    trade(stock, cash, "2026-07-01", 10, 700, "stock_sell");
    equityCloses(TICKER, [
      ["2026-03-02", 60],
      ["2026-06-01", 65],
      ["2026-11-13", 72],
    ]);
    // Held from the buy to the day the last share was sold.
    expect(positionHeldSpans(stock)).toEqual([{ from: "2026-03-02", to: "2026-07-01" }]);
    const g = buildPositionGlanceForAccount(stock, figures(0), NOW)!;
    expect(g).not.toBeNull();
    // The cost of the 10 shares held the day before the sale; today's price against it.
    expect(g.track.cost.price.value).toBeCloseTo(60, 9);
    expect(g.price_vs_cost).toBe("above");
    const c = g.composition!;
    expect(c).toMatchObject({ as_of: "2026-06-30", is_today: false });
    expectCompositionIdentity(c);
    // The year's sparkline dims everything after the sale.
    const year = g.sparklines.find((l) => l.range === "1y")!;
    expect(year.held).toHaveLength(1);
    expect(year.held[0]!.end).toBeLessThan(1);
  });
});

describe("buildPositionGlanceForAccount — coins", () => {
  it("reads the coin's dollar price and the ledger pesos paid per coin, in dollars on each purchase day", () => {
    const coin = account("bitcoin", { groupId: leafGroupIdBySlug("%crypto__bitcoin"), ticker: "BTC-USD" });
    const buy1 = single(coin, "2026-03-02", 600_000, 0.01);
    const buy2 = single(coin, "2026-06-01", 400_000, 0.005);
    const sell = single(coin, "2026-07-01", -300_000, -0.004);
    const kind = db.prepare(`INSERT INTO crypto_movement_kinds (movement_id, kind) VALUES (?, ?)`);
    kind.run(buy1, "buy");
    kind.run(buy2, "buy");
    kind.run(sell, "sell");
    // The first buy paid a 6.000 commission inside its 600.000; only it has an exchange record.
    db.prepare(
      `INSERT INTO crypto_trade_details (movement_id, exchange_trade_id, units, price, price_currency, fee_amount, fee_currency, created_at)
       VALUES (?, ?, 0.01, 60000000, 'clp', 6000, 'clp', '2026-01-01T00:00:00Z')`
    ).run(buy1, `${NOTE}-1`);
    equityCloses("BTC-USD", [
      ["2026-03-02", 64_000],
      ["2026-06-01", 85_000],
      ["2026-09-01", 95_000],
      ["2026-11-14", 90_000],
    ]);
    expect(isUnitPositionAccount(coin)).toBe(true);

    const g = buildPositionGlanceForAccount(coin, figures(900_000), NOW)!;
    expect(g.title).toBe("BTC-USD");
    expect(g.instrument).toMatchObject({ kind: "market", ticker: "BTC-USD", market_kind: "crypto24" });
    expect(g.quote.price).toEqual({ value: 90_000, currency: "usd" });
    // FIFO at the ledger pesos (commissions included, no exchange record needed): 0,006 of the
    // first buy (600.000 × 0,6) + the second buy, each in dollars on its day.
    const usd = (clp: number, ymd: string) => convertCurrency(clp, "clp", "usd", ymd, { side: "mid", storedOnly: true })!;
    const expected = (usd(600_000 * 0.6, "2026-03-02") + usd(400_000, "2026-06-01")) / 0.011;
    expect(g.track.cost.price.value).toBeCloseTo(expected, 6);
    expect(g.track.high).toMatchObject({ date: "2026-09-01" });
    const c = g.composition!;
    expect(c).toMatchObject({ as_of: TODAY, is_today: true, state_bonus: null });
    expect(c.deposited.value).toBe(700_000);
    expect(c.dividends.value).toBe(0);
    expectCompositionIdentity(c);
  });
});

describe("buildPositionGlanceForAccount — funds", () => {
  it("a Fintual goal: cuotas × its fund's valor cuota, the fund named, FIFO cost per cuota", () => {
    const fund = account("fintual goal", {
      groupId: leafGroupIdBySlug("%fondo_reserva"),
      series: "fintual_cert_reserva2",
      goal: "vitest-glance-goal",
    });
    const cash = account("cash");
    single(fund, "2026-03-02", 10_000, 10); // 1.000 a cuota
    transfer(cash, fund, "2026-06-01", 7_500, 5); // 1.500 a cuota
    single(fund, "2026-07-01", -6_400, -4); // FIFO: 4 of the first 10 go
    fundSeries("fintual_cert_reserva2", [
      ["2026-03-02", 1_000],
      ["2026-06-01", 1_500],
      ["2026-07-01", 1_600],
      ["2026-11-13", 1_700],
    ]);
    const g = buildPositionGlanceForAccount(fund, figures(18_700), NOW)!;
    expect(g.title).toBe(`${PREFIX} fintual goal`);
    expect(g.instrument).toEqual({
      kind: "fund",
      series: { kind: "fintual", series_key: "fintual_cert_reserva2", name: "Very Conservative Streep" },
      price_source: "official",
      published_on: "2026-11-13",
    });
    expect(g.quote).toEqual({ price: { value: 1_700, currency: "clp" }, price_as_of: "2026-11-13" });
    expect(g.track.cost.price.value).toBeCloseTo((6_000 + 7_500) / 11, 9);
    expect(g.price_vs_cost).toBe("above");
    expect(g.basket).toBeNull();
    const c = g.composition!;
    // 11 cuotas × 1.700; deposited 10.000 + 7.500 − 6.400.
    expect(c).toMatchObject({ as_of: TODAY, is_today: true, state_bonus: null });
    expect(c.value.value).toBe(18_700);
    expect(c.deposited.value).toBe(11_100);
    expect(c.price.value).toBe(7_600);
    expectCompositionIdentity(c);
  });

  it("an AFP switch: the sold-out fund measured on its last day held, the receiving fund's cost the switch's pesos", () => {
    const afp = leafAssetGroupIdForKindSlug("afp");
    const from = account("afp from", { groupId: afp, series: "afp_vtglx_cuota_a" });
    const to = account("afp to", { groupId: afp, series: "afp_vtgly_cuota_a" });
    single(from, "2026-03-02", 400_000, 10); // 40.000
    single(from, "2026-05-04", 210_000, 5); // 42.000
    transfer(from, to, "2026-07-01", 660_000, 15, { counterUnits: 20, flowKind: "afp_fund_switch" });
    single(to, "2026-09-01", 70_000, 2); // 35.000
    fundSeries("afp_vtglx_cuota_a", [
      ["2026-03-02", 40_000],
      ["2026-05-04", 42_000],
      ["2026-06-30", 44_000],
    ]);
    fundSeries("afp_vtgly_cuota_a", [
      ["2026-07-01", 33_000],
      ["2026-09-01", 35_000],
      ["2026-11-13", 36_000],
    ]);

    expect(positionHeldSpans(from)).toEqual([{ from: "2026-03-02", to: "2026-07-01" }]);
    const sold = buildPositionGlanceForAccount(from, figures(0), NOW)!;
    expect(sold.instrument).toMatchObject({
      kind: "fund",
      series: { kind: "afp", series_key: "afp_vtglx_cuota_a", manager: "vtglx", fund: "A" },
      price_source: "official",
      published_on: "2026-06-30",
    });
    expect(sold.track.cost.price.value).toBeCloseTo(610_000 / 15, 9);
    const sc = sold.composition!;
    expect(sc).toMatchObject({ as_of: "2026-06-30", is_today: false });
    expect(sc.value.value).toBe(660_000);
    expect(sc.deposited.value).toBe(610_000);
    expect(sc.price.value).toBe(50_000);
    expectCompositionIdentity(sc);
    expect(sold.sparklines.find((l) => l.range === "1y")!.held[0]!.end).toBeLessThan(1);

    const recv = buildPositionGlanceForAccount(to, figures(792_000), NOW)!;
    expect(positionHeldSpans(to)).toEqual([{ from: "2026-07-01", to: null }]);
    expect(recv.track.cost.price.value).toBeCloseTo(730_000 / 22, 9);
    const rc = recv.composition!;
    expect(rc).toMatchObject({ as_of: TODAY, is_today: true });
    expect(rc.value.value).toBe(22 * 36_000);
    expect(rc.deposited.value).toBe(730_000);
    expectCompositionIdentity(rc);
  });

  it("an AFC with a commission true-up: the commission leaves cuotas at no proceeds, catch-up cuotas cost nothing", () => {
    const afc = account("afc", { groupId: leafAssetGroupIdForKindSlug("afc"), series: "vitest_glance_afc" });
    single(afc, "2026-03-02", 400_000, 100);
    single(afc, "2026-06-01", 210_000, 50);
    single(afc, "2026-08-31", -8_600, -2, "cash_fee");
    single(afc, "2026-09-30", 4_350, 1, "savings_earnings");
    fundSeries("vitest_glance_afc", [
      ["2026-03-02", 4_000],
      ["2026-06-01", 4_200],
      ["2026-08-31", 4_300],
      ["2026-11-13", 4_400],
    ]);
    const g = buildPositionGlanceForAccount(afc, figures(149 * 4_400), NOW)!;
    expect(g.instrument).toMatchObject({ kind: "fund", series: { kind: "afc", series_key: "vitest_glance_afc" } });
    // 98 of the first 100 cuotas (392.000) + 50 (210.000) + 1 at no cost, over 149.
    expect(g.track.cost.price.value).toBeCloseTo(602_000 / 149, 9);
    const c = g.composition!;
    expect(c.value.value).toBe(149 * 4_400);
    // The commission and the catch-up cuotas are P/L, never capital.
    expect(c.deposited.value).toBe(610_000);
    expectCompositionIdentity(c);
  });

  it("an APV with a state bonus: personal cost per cuota, the bonus its own segment", () => {
    const apv = account("apv", {
      groupId: leafGroupIdBySlug("%apv_a__apv"),
      series: "vitest_glance_apv",
      goal: "vitest-glance-apv",
    });
    single(apv, "2026-03-02", 10_000, 10);
    single(apv, "2026-04-01", 1_500, 1.5, "state_bonus");
    fundSeries("vitest_glance_apv", [
      ["2026-03-02", 1_000],
      ["2026-04-01", 1_000],
      ["2026-11-13", 1_100],
    ]);
    const g = buildPositionGlanceForAccount(apv, figures(12_650), NOW)!;
    expect(g.instrument).toMatchObject({ kind: "fund", series: { kind: "other", series_key: "vitest_glance_apv" } });
    // Only the personal pesos are cost: 10.000 over 11,5 cuotas.
    expect(g.track.cost.price.value).toBeCloseTo(10_000 / 11.5, 9);
    expect(g.price_vs_cost).toBe("above");
    const c = g.composition!;
    expect(c.value.value).toBe(12_650);
    expect(c.deposited.value).toBe(10_000);
    expect(c.state_bonus).toEqual({ value: 1_500, currency: "clp" });
    expect(c.price.value).toBe(1_150);
    expect(c.segments.map((s) => s.kind)).toEqual(["deposited", "state_bonus", "price"]);
    expectCompositionIdentity(c);
  });

  it("a proxy-priced fund: today's estimate with price_source proxy, the last published day, and the basket", () => {
    const apv = account("apv proxy", {
      groupId: leafGroupIdBySlug("%apv_a__apv"),
      series: "fintual_cert_apv_a",
      goal: "vitest-glance-apv-proxy",
    });
    single(apv, "2026-03-02", 10_000, 10);
    fundSeries("fintual_cert_apv_a", [
      ["2026-03-02", 1_000],
      ["2026-11-13", 1_050],
    ]);
    vi.spyOn(riskyNorrisProxyMtm, "shouldUseRiskyNorrisProxyMtm").mockReturnValue(true);
    vi.spyOn(riskyNorrisProxyMtm, "riskyNorrisProxyAppliesOnYmd").mockReturnValue(false);
    vi.spyOn(riskyNorrisProxyMtm, "riskyNorrisProxyCuotaForMtm").mockReturnValue(1_100);
    const period = { day: null, month: null, year: null };
    vi.spyOn(proxyBasketBreakdown, "loadProxyBasketBreakdown").mockReturnValue({
      bucket_slug: "vitest",
      positions_date: "2026-10-31",
      other_weight: 0.1,
      holdings: [
        { ticker: "SPXS", price_ticker: "SPY", weight: 0.6, pct: period, contribution_pct: period, days_held: { day: { held: 0, total: 0 }, month: { held: 0, total: 0 }, year: { held: 0, total: 0 } } },
        { ticker: "AAPL", price_ticker: "AAPL", weight: 0.3, pct: period, contribution_pct: period, days_held: { day: { held: 0, total: 0 }, month: { held: 0, total: 0 }, year: { held: 0, total: 0 } } },
      ],
    });
    const g = buildPositionGlanceForAccount(apv, figures(11_000), NOW)!;
    expect(g.instrument).toEqual({
      kind: "fund",
      series: { kind: "fintual", series_key: "fintual_cert_apv_a", name: "Risky Norris" },
      price_source: "proxy",
      published_on: "2026-11-13",
    });
    expect(g.quote).toEqual({ price: { value: 1_100, currency: "clp" }, price_as_of: TODAY });
    expect(g.track.cost.price.value).toBeCloseTo(1_000, 9);
    expect(g.price_vs_cost).toBe("above");
    expect(g.basket).toEqual({
      positions_date: "2026-10-31",
      rows: [
        { kind: "holding", ticker: "SPXS", name: marketSymbol("SPY")?.name ?? null, share: 0.6, value: { value: 0.6 * 11_000, currency: "clp" } },
        { kind: "holding", ticker: "AAPL", name: marketSymbol("AAPL")?.name ?? null, share: 0.3, value: { value: 0.3 * 11_000, currency: "clp" } },
        { kind: "other", share: 0.1, value: { value: 0.1 * 11_000, currency: "clp" } },
      ],
    });
  });
});

describe("position_glance on the account detail bundle", () => {
  it("is served for every unit-position account of the test person that ever held units, and null elsewhere", async () => {
    const { buildAccountDetailBundle } = await import("./accountDetailBundle.js");
    const ids = (db.prepare(`SELECT id FROM accounts ORDER BY id`).all() as { id: number }[]).map((r) => r.id);
    let built = 0;
    const kinds = new Set<string>();
    const today = chileCalendarTodayYmd();
    for (const id of ids) {
      const holding = accountProfile(id).holding;
      if (
        isUnitPositionAccount(id) &&
        positionHeldSpans(id).length > 0 &&
        (holding.kind === "stock" || holding.kind === "coin" || holding.kind === "fund") &&
        holdingPriceAt(holding, today) == null
      ) {
        // A held position with no unit price on file is a data gap: the page fails, never guesses.
        await expect(buildAccountDetailBundle(id, "clp", "monthly"), `account ${id}`).rejects.toThrow(/no value today|no unit price today/);
        continue;
      }
      const bundle = (await buildAccountDetailBundle(id, "clp", "monthly"))!;
      if (bundle == null) continue;
      const g = bundle.position_glance;
      const pos = bundle.summary.position;
      if (!isUnitPositionAccount(id) || positionHeldSpans(id).length === 0) {
        expect(g, `account ${id}`).toBeNull();
        continue;
      }
      expect(g, `account ${id}`).not.toBeNull();
      built += 1;
      kinds.add(g!.instrument.kind);
      expect(g!.value.value).toBe(pos!.value);
      expect(g!.periods.day.pl?.value ?? null).toBe(bundle.dashboard_account_row?.delta_day ?? null);
      for (const l of g!.sparklines) expect(l.points[l.points.length - 1]!.price).toBe(g!.quote.price.value);
      if (g!.composition) expectCompositionIdentity(g!.composition);
    }
    expect(built).toBeGreaterThan(0);
    // The test person holds stocks and an AFP fund (UNO-A).
    expect([...kinds].sort()).toEqual(["fund", "market"]);
  });

  it("is served for a fund account through the bundle, from the bundle's own position", async () => {
    const { buildAccountDetailBundle } = await import("./accountDetailBundle.js");
    const afc = account("afc bundle", { groupId: leafAssetGroupIdForKindSlug("afc"), series: "vitest_glance_afc_bundle" });
    single(afc, "2026-03-02", 400_000, 100);
    single(afc, "2026-08-31", -8_600, -2, "cash_fee");
    fundSeries("vitest_glance_afc_bundle", [
      ["2026-03-02", 4_000],
      ["2026-08-31", 4_300],
      ["2026-11-13", 4_400],
    ]);
    const bundle = (await buildAccountDetailBundle(afc, "clp", "monthly"))!;
    const g = bundle.position_glance!;
    expect(g).not.toBeNull();
    expect(g.instrument).toMatchObject({ kind: "fund", price_source: "official", published_on: "2026-11-13" });
    expect(g.value.value).toBe(bundle.summary.position!.value);
    expect(g.value.value).toBe(98 * 4_400);
    expect(g.track.cost.price.value).toBeCloseTo(4_000, 9);
    expectCompositionIdentity(g.composition!);
  });

  it("is null on an account that is not a unit position", async () => {
    const { buildAccountDetailBundle } = await import("./accountDetailBundle.js");
    const plain = account("plain bundle");
    const bundle = (await buildAccountDetailBundle(plain, "clp", "monthly"))!;
    expect(bundle.position_glance).toBeNull();
  });
});
