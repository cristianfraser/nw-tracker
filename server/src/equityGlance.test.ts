import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { accountUsesEquityMtm } from "./brokerageEquityMtm.js";
import {
  buildEquityGlanceForAccount,
  equityGlanceFromInputs,
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
    previousClose: 70,
    closes: [
      { date: "2026-03-02", price: 60 },
      { date: "2026-09-01", price: 90 },
      { date: "2026-11-12", price: 70 },
    ],
    averageCost: 69,
    value: 1_000_000,
    deposited: 900_000,
    dividends: 20_000,
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
    const g = equityGlanceFromInputs(inputs({ value: 850_000 }));
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
    const g = equityGlanceFromInputs(inputs({ dividends: 0 }));
    expect(g.composition!.segments.map((s) => s.kind)).toEqual(["deposited", "price"]);
    expect(equityGlanceFromInputs(inputs({ deposited: null })).composition).toBeNull();
    expect(equityGlanceFromInputs(inputs({ deposited: -5 })).composition).toBeNull();
  });
});

describe("equityGlanceFromInputs — quote, sparkline and track", () => {
  it("serves the quote's change and the high since first held", () => {
    const g = equityGlanceFromInputs(inputs());
    expect(g.quote.price).toEqual({ value: 72, currency: "usd" });
    expect(g.quote.change!.value).toBe(2);
    expect(g.quote.change_pct).toBeCloseTo(2 / 70, 12);
    expect(g.quote.direction).toBe("up");
    expect(g.quote.session).toBe("closed");
    expect(g.track.high.price.value).toBe(90);
    expect(g.track.high.date).toBe("2026-09-01");
    expect(g.track.high.pct_from_high).toBeCloseTo(72 / 90 - 1, 12);
  });

  it("ends the sparkline on the quote's price and keeps every point on its 0..1 range", () => {
    const g = equityGlanceFromInputs(inputs());
    const last = g.sparkline.points[g.sparkline.points.length - 1]!;
    expect(last).toMatchObject({ date: "2026-11-13", price: 72 });
    expect(g.sparkline.first_date).toBe("2026-03-02");
    expect(g.sparkline.low).toBe(60);
    expect(g.sparkline.high).toBe(90);
    expect(g.sparkline.cost_y).toBeCloseTo((69 - 60) / 30, 12);
    for (const p of g.sparkline.points) expect(p.y).toBeCloseTo((p.price - 60) / 30, 12);
  });

  it("samples a long history down to the point budget, first and last kept", () => {
    const closes = Array.from({ length: 1000 }, (_, i) => ({
      date: `2020-01-01+${String(i).padStart(4, "0")}`,
      price: 50 + (i % 7),
    }));
    const g = equityGlanceFromInputs(inputs({ closes, priceAsOf: "2099-01-01" }));
    expect(g.sparkline.points.length).toBeLessThanOrEqual(EQUITY_GLANCE_SPARK_MAX_POINTS);
    expect(g.sparkline.points[0]!.date).toBe(closes[0]!.date);
    expect(g.sparkline.points[g.sparkline.points.length - 1]!.date).toBe("2099-01-01");
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
    expect(g.quote.previous_close!.value).toBe(70);
    expect(g.quote.session).toBe("closed");
    // 6 shares at 60 + 5 at 80 over 11 shares.
    expect(g.track.cost.price.value).toBeCloseTo(760 / 11, 9);
    expect(g.price_vs_cost).toBe("above");
    expect(g.sparkline.first_date).toBe("2026-03-02");
    expect(g.sparkline.points.map((p) => p.price)).toEqual([60, 80, 90, 70, 72]);
    expect(g.track.high).toMatchObject({ date: "2026-09-01" });
    expect(g.periods.month.pl).toEqual({ value: -2_000, currency: "clp" });
    expect(g.composition!.price.value).toBe(50_000);
  });

  it("is null for an account that is not an equity account or holds no shares today", () => {
    const plain = account("plain");
    expect(accountUsesEquityMtm(plain)).toBe(false);
    expect(buildEquityGlanceForAccount(plain, accountUsesEquityMtm(plain), FIGURES, NOW)).toBeNull();

    declareTestInstrument(TICKER);
    const stock = account("sold out", TICKER);
    const cash = account("USD cash");
    trade(cash, stock, "2026-03-02", 10, 600, "stock_buy");
    trade(stock, cash, "2026-07-01", 10, 700, "stock_sell");
    expect(buildEquityGlanceForAccount(stock, true, FIGURES, NOW)).toBeNull();
  });
});

describe("equity_glance on the account detail bundle", () => {
  it("is served for every share-holding stock account of the test person, in step with its position", async () => {
    const { buildAccountDetailBundle } = await import("./accountDetailBundle.js");
    const ids = (
      db.prepare(`SELECT id FROM accounts WHERE equity_ticker IS NOT NULL ORDER BY id`).all() as { id: number }[]
    ).map((r) => r.id);
    let built = 0;
    for (const id of ids) {
      const bundle = (await buildAccountDetailBundle(id, "clp", "monthly"))!;
      const g = bundle.equity_glance;
      const pos = bundle.summary.position;
      if (!accountUsesEquityMtm(id) || pos?.units_kind !== "shares" || !(Number(pos.units) > 0)) {
        expect(g).toBeNull();
        continue;
      }
      expect(g).not.toBeNull();
      built += 1;
      expect(g!.value.value).toBe(pos.value);
      expect(g!.periods.day.pl?.value ?? null).toBe(bundle.dashboard_account_row?.delta_day ?? null);
      const last = g!.sparkline.points[g!.sparkline.points.length - 1]!;
      expect(last.price).toBe(g!.quote.price.value);
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
