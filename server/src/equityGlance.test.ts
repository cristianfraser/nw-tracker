import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { accountUsesEquityMtm } from "./brokerageEquityMtm.js";
import {
  buildEquityGlanceForAccount,
  equityGlanceFromInputs,
  equityHeldSpans,
  equityTrackRange,
  EQUITY_GLANCE_SPARK_MAX_POINTS,
  type EquityGlanceInputs,
} from "./equityGlance.js";
import { reloadMarketSymbols } from "./marketSymbols.js";
import { declareTestInstrument } from "./test/instrumentFixtures.js";

function inputs(over: Partial<EquityGlanceInputs> = {}): EquityGlanceInputs {
  return {
    accountId: 1,
    ticker: "VGL",
    name: "Vitest Glance ETF",
    marketKind: "nyse",
    unit: "clp",
    quoteCurrency: "usd",
    price: 72,
    priceAsOf: "2026-11-13",
    sessionOpen: false,
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
    position: { asOf: "2026-11-13", isToday: true, value: 1_000_000, deposited: 900_000, dividends: 20_000 },
    periods: {
      day: { pl: -10_000, pct: -0.01 },
      month: { pl: -40_000, pct: -0.04 },
      year: { pl: 20_000, pct: 0.02 },
    },
    ...over,
  };
}

const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);

describe("equityGlanceFromInputs — composition", () => {
  it("splits a gain as deposited + price + dividends, segments filling the bar", () => {
    const g = equityGlanceFromInputs(inputs());
    const c = g.composition!;
    expect(c.price.value).toBe(80_000);
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
    const g = equityGlanceFromInputs(inputs({ position: { ...inputs().position, value: 850_000 } }));
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

  it("leaves zero segments out and is null without a deposited base", () => {
    const g = equityGlanceFromInputs(inputs({ position: { ...inputs().position, dividends: 0 } }));
    expect(g.composition!.segments.map((s) => s.kind)).toEqual(["deposited", "price"]);
    expect(equityGlanceFromInputs(inputs({ position: { ...inputs().position, deposited: null } })).composition).toBeNull();
    expect(equityGlanceFromInputs(inputs({ position: { ...inputs().position, deposited: -5 } })).composition).toBeNull();
  });
});

describe("equityGlanceFromInputs — quote, sparkline and track", () => {
  it("serves the quote and the high since first held", () => {
    // A higher close before the first day held does not count as the high.
    const g = equityGlanceFromInputs(
      inputs({ closes: [{ date: "2026-02-27", price: 99 }, ...inputs().closes] })
    );
    expect(g.quote.price).toEqual({ value: 72, currency: "usd" });
    expect(g.quote.session).toBe("closed");
    expect(g.track.high.price.value).toBe(90);
    expect(g.track.high.date).toBe("2026-09-01");
    expect(g.track.high.pct_from_high).toBeCloseTo(72 / 90 - 1, 12);
  });

  it("serves one sparkline per range, every axis the whole range, points placed by day", () => {
    const g = equityGlanceFromInputs(inputs());
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
    const g = equityGlanceFromInputs(
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
    const g = equityGlanceFromInputs(inputs({ closes, priceAsOf: asOf, today: asOf, firstHeld: closes[0]!.date }));
    const total = g.sparklines.find((l) => l.range === "total")!;
    expect(total.points.length).toBeLessThanOrEqual(EQUITY_GLANCE_SPARK_MAX_POINTS);
    expect(total.points[0]!.date).toBe(closes[0]!.date);
    expect(total.points[total.points.length - 1]!.date).toBe(asOf);
  });

  it("places cost, price and high on a rounded track with the fill between cost and price", () => {
    const g = equityGlanceFromInputs(inputs({ averageCost: 41.27, price: 43.86, closes: [{ date: "2026-10-06", price: 47.9 }] }));
    expect(g.track.min.value).toBe(40);
    expect(g.track.max.value).toBe(50);
    expect(g.track.cost.share).toBeCloseTo(0.127, 12);
    expect(g.track.price.share).toBeCloseTo(0.386, 12);
    expect(g.track.high.share).toBeCloseTo(0.79, 12);
    expect(g.track.fill).toEqual({ start: g.track.cost.share, end: g.track.price.share, side: "gain" });
    expect(g.price_vs_cost).toBe("above");
  });

  it("decides price vs cost at the quote currency's cents", () => {
    expect(equityGlanceFromInputs(inputs({ price: 60, averageCost: 69 })).price_vs_cost).toBe("below");
    const below = equityGlanceFromInputs(inputs({ price: 60, averageCost: 69 }));
    expect(below.track.fill.side).toBe("loss");
    expect(below.track.fill.start).toBeCloseTo(below.track.price.share, 12);
    expect(below.track.fill.end).toBeCloseTo(below.track.cost.share, 12);
    const equal = equityGlanceFromInputs(inputs({ price: 69.004, averageCost: 68.996 }));
    expect(equal.price_vs_cost).toBe("equal");
    expect(equal.track.fill.side).toBe("none");
    expect(equal.track.fill.start).toBe(equal.track.fill.end);
    expect(equityGlanceFromInputs(inputs({ price: 69.006, averageCost: 68.996 })).price_vs_cost).toBe("above");
  });

  it("rounds the track outwards to a 1/2/5 step and never collapses it", () => {
    expect(equityTrackRange([41.27, 43.86, 47.9])).toEqual({ min: 40, max: 50 });
    expect(equityTrackRange([1_230, 1_480])).toEqual({ min: 1_200, max: 1_600 });
    const flat = equityTrackRange([50, 50, 50]);
    expect(flat.min).toBeLessThanOrEqual(50);
    expect(flat.max).toBeGreaterThan(flat.min);
  });
});

describe("equityGlanceFromInputs — periods", () => {
  it("scales each bar by the largest |P/L| of the three", () => {
    const g = equityGlanceFromInputs(inputs());
    expect(g.periods.month.share).toBe(1);
    expect(g.periods.day.share).toBeCloseTo(0.25, 12);
    expect(g.periods.year.share).toBeCloseTo(0.5, 12);
    expect(g.periods.day.direction).toBe("down");
    expect(g.periods.year.direction).toBe("up");
    expect(g.periods.year.pl).toEqual({ value: 20_000, currency: "clp" });
    expect(g.periods.year.pct).toBe(0.02);
  });

  it("reads 0 shares when every period is 0 or unknown", () => {
    const g = equityGlanceFromInputs(
      inputs({
        periods: { day: { pl: 0, pct: 0 }, month: { pl: null, pct: null }, year: { pl: 0, pct: null } },
      })
    );
    expect([g.periods.day.share, g.periods.month.share, g.periods.year.share]).toEqual([0, 0, 0]);
    expect(g.periods.month).toEqual({ pl: null, pct: null, share: 0, direction: "flat" });
    expect(g.periods.day.direction).toBe("flat");
  });
});

// ---------- From the database ----------

const PREFIX = "Vitest · equity glance";
const TICKER = "VGLANCE";
const created: { accounts: number[]; movements: number[] } = { accounts: [], movements: [] };
// A Saturday: NYSE is closed, the price is Friday's close.
const NOW = new Date("2026-11-14T15:00:00Z");

function leafGroupId(): number {
  const row = db
    .prepare(`SELECT id FROM asset_groups WHERE slug LIKE 'brokerage_acciones__%' LIMIT 1`)
    .get() as { id: number } | undefined;
  if (!row) throw new Error("no brokerage_acciones leaf in the test DB");
  return row.id;
}

function account(name: string, ticker: string | null = null): number {
  const id = Number(
    db
      .prepare(`INSERT INTO accounts (asset_group_id, name, equity_ticker) VALUES (?, ?, ?)`)
      .run(leafGroupId(), `${PREFIX} ${name}`, ticker).lastInsertRowid
  );
  created.accounts.push(id);
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

const FIGURES = {
  unit: "clp",
  position: { units_kind: "shares", units: 11, value: 750_000, deposited: 700_000, dividends: 0 },
  row: { delta_day: 1_000, delta_month: -2_000, delta_year: 4_000, pct_day: 0.001, pct_month: -0.002, pct_year: 0.004 },
};

afterEach(() => {
  for (const id of created.movements.splice(0)) db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
  for (const id of created.accounts.splice(0)) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  db.prepare(`DELETE FROM equity_daily WHERE ticker = ?`).run(TICKER);
  db.prepare(`DELETE FROM market_symbols WHERE ticker = ?`).run(TICKER);
  reloadMarketSymbols();
});

describe("buildEquityGlanceForAccount", () => {
  it("reads today's price, the closes since first held and the FIFO cost of the shares held", () => {
    declareTestInstrument(TICKER, { name: "Vitest Glance Fund" });
    const stock = account("stock", TICKER);
    const cash = account("USD cash");
    trade(cash, stock, "2026-03-02", 10, 600, "stock_buy"); // 60 a share
    trade(cash, stock, "2026-06-01", 5, 400, "stock_buy"); // 80 a share
    trade(stock, cash, "2026-07-01", 4, 300, "stock_sell"); // FIFO: 4 of the 60s go
    const close = db.prepare(`INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, ?, 'usd')`);
    for (const [d, c] of [
      ["2026-02-27", 55],
      ["2026-03-02", 60],
      ["2026-06-01", 80],
      ["2026-09-01", 90],
      ["2026-11-12", 70],
      ["2026-11-13", 72],
    ] as const) {
      close.run(TICKER, d, c);
    }
    expect(accountUsesEquityMtm(stock)).toBe(true);

    const g = buildEquityGlanceForAccount(stock, true, FIGURES, NOW)!;
    expect(g).not.toBeNull();
    expect(g.ticker).toBe(TICKER);
    expect(g.name).toBe("Vitest Glance Fund");
    expect(g.quote.market_kind).toBe("nyse");
    expect(g.quote.price).toEqual({ value: 72, currency: "usd" });
    expect(g.quote.price_as_of).toBe("2026-11-13");
    expect(g.quote.session).toBe("closed");
    // 6 shares at 60 + 5 at 80 over 11 shares.
    expect(g.track.cost.price.value).toBeCloseTo(760 / 11, 9);
    expect(g.price_vs_cost).toBe("above");
    // Every stored close of the instrument (the day before the first buy too), through today's price.
    const total = g.sparklines.find((l) => l.range === "total")!;
    expect(total.from).toBe("2026-02-27");
    expect(total.points.map((p) => p.price)).toEqual([55, 60, 80, 90, 70, 72]);
    expect(g.track.high).toMatchObject({ date: "2026-09-01" });
    expect(g.periods.month.pl).toEqual({ value: -2_000, currency: "clp" });
    // Held today: the split is today's position, value = deposited + price + dividends.
    const c = g.composition!;
    expect(c).toMatchObject({ as_of: "2026-11-14", is_today: true });
    expect(c.deposited.value + c.price.value + c.dividends.value).toBeCloseTo(c.value.value, 6);
  });

  it("is null for an account that is not an equity account or never held a share", () => {
    const plain = account("plain");
    expect(accountUsesEquityMtm(plain)).toBe(false);
    expect(buildEquityGlanceForAccount(plain, accountUsesEquityMtm(plain), FIGURES, NOW)).toBeNull();
  });

  it("measures a sold-out position on its last day held, through the same rules", () => {
    declareTestInstrument(TICKER);
    const stock = account("sold out", TICKER);
    const cash = account("USD cash");
    trade(cash, stock, "2026-03-02", 10, 600, "stock_buy"); // 60 a share
    trade(stock, cash, "2026-07-01", 10, 700, "stock_sell");
    const close = db.prepare(`INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, ?, 'usd')`);
    for (const [d, c] of [
      ["2026-03-02", 60],
      ["2026-06-01", 65],
      ["2026-11-13", 72],
    ] as const) {
      close.run(TICKER, d, c);
    }
    // Held from the buy to the day the last share was sold.
    expect(equityHeldSpans(stock)).toEqual([{ from: "2026-03-02", to: "2026-07-01" }]);
    const g = buildEquityGlanceForAccount(stock, true, { ...FIGURES, position: { ...FIGURES.position, units: 0, value: 0 } }, NOW)!;
    expect(g).not.toBeNull();
    // The cost of the 10 shares held the day before the sale; today's price against it.
    expect(g.track.cost.price.value).toBeCloseTo(60, 9);
    expect(g.price_vs_cost).toBe("above");
    const c = g.composition!;
    expect(c).toMatchObject({ as_of: "2026-06-30", is_today: false });
    expect(c.deposited.value + c.price.value + c.dividends.value).toBeCloseTo(c.value.value, 6);
    // The year's sparkline dims everything after the sale.
    const year = g.sparklines.find((l) => l.range === "1y")!;
    expect(year.held).toHaveLength(1);
    expect(year.held[0]!.end).toBeLessThan(1);
  });
});

describe("equity_glance on the account detail bundle", () => {
  it("is served for every stock account of the test person that ever held shares, sold out too", async () => {
    const { buildAccountDetailBundle } = await import("./accountDetailBundle.js");
    const ids = (
      db.prepare(`SELECT id FROM accounts WHERE equity_ticker IS NOT NULL ORDER BY id`).all() as { id: number }[]
    ).map((r) => r.id);
    let built = 0;
    for (const id of ids) {
      const bundle = (await buildAccountDetailBundle(id, "clp", "monthly"))!;
      const g = bundle.equity_glance;
      const pos = bundle.summary.position;
      if (!accountUsesEquityMtm(id) || pos?.units_kind !== "shares" || equityHeldSpans(id).length === 0) {
        expect(g).toBeNull();
        continue;
      }
      expect(g).not.toBeNull();
      built += 1;
      expect(g!.value.value).toBe(pos.value);
      expect(g!.periods.day.pl?.value ?? null).toBe(bundle.dashboard_account_row?.delta_day ?? null);
      for (const l of g!.sparklines) expect(l.points[l.points.length - 1]!.price).toBe(g!.quote.price.value);
      if (g!.composition) {
        const c = g!.composition;
        expect(c.deposited.value + c.price.value + c.dividends.value).toBeCloseTo(c.value.value, 6);
      }
    }
    expect(built).toBeGreaterThan(0);
  });
});

// A plain (non-equity) account's bundle carries no glance.
describe("equity_glance on a non-equity bundle", () => {
  it("is null", async () => {
    const { buildAccountDetailBundle } = await import("./accountDetailBundle.js");
    const plain = account("plain bundle");
    const bundle = (await buildAccountDetailBundle(plain, "clp", "monthly"))!;
    expect(bundle.equity_glance).toBeNull();
  });
});
