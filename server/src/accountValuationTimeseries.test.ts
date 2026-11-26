/**
 * The per-account valuation chart's conversions and its live last point
 * (`accountValuationTimeseries.ts`), on synthetic fixtures: a Santiago stock (pesos, no fx in
 * its price), a card, and fixed dollar and UF rows. Dates: a Friday close 2026-05-22 read on
 * Sunday 2026-05-24 (no market and no fx day open, so every figure is a stored one).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "./db.js";
import { chartValueInUnit, patchAccountLiveLastPoint, propertyPagoAcumuladoInUnitByDate } from "./accountValuationTimeseries.js";
import { FX_BID_ASK_SPREAD_CLP } from "./fxBidAsk.js";
import { overrideFxDaily } from "./test/fxDailyFixture.js";
import { declareTestInstrument } from "./test/instrumentFixtures.js";
import { snapshotTables } from "./test/snapshotTables.js";
import type { DeptoMortgageSheetRow } from "./deptoDividendosLedger.js";

const FRIDAY = "2026-05-22";
const MID = 950;
const HALF = FX_BID_ASK_SPREAD_CLP / 2; // 2 pesos

describe("chartValueInUnit", () => {
  let restoreFx: () => void = () => {};
  const restoreBidAsk = snapshotTables(["fx_daily_bid_ask"]);
  beforeAll(() => {
    restoreFx = overrideFxDaily([[FRIDAY, MID]]);
    db.prepare(`DELETE FROM fx_daily_bid_ask WHERE date >= ?`).run(FRIDAY);
  });
  afterAll(() => {
    restoreFx();
    restoreBidAsk();
  });

  it("is the pesos themselves in pesos, whatever the side", () => {
    expect(chartValueInUnit(1_000_000, FRIDAY, "clp")).toBe(1_000_000);
    expect(chartValueInUnit(-5, FRIDAY, "clp", "debt")).toBe(-5);
  });

  it("buys dollars at the ask for an asset and at the bid for a debt (mid ∓ half the spread with no bid/ask on file)", () => {
    // Asset: 951.000 pesos buy 951.000 / (950 + 2) dollars; debt: 951.000 / (950 − 2).
    expect(chartValueInUnit(951_000, FRIDAY, "usd")).toBeCloseTo(951_000 / (MID + HALF), 9);
    expect(chartValueInUnit(951_000, FRIDAY, "usd", "debt")).toBeCloseTo(951_000 / (MID - HALF), 9);
    expect(chartValueInUnit(951_000, FRIDAY, "usd", "debt")).toBeGreaterThan(chartValueInUnit(951_000, FRIDAY, "usd"));
  });

  it("reads the day's stored bid and ask when the bank observed them", () => {
    db.prepare(`INSERT INTO fx_daily_bid_ask (date, buy_clp_per_usd, sell_clp_per_usd, source) VALUES (?, 960, 940, 'vitest')`).run(FRIDAY);
    try {
      // The asset side pays the buy rate 960, the debt side the sell rate 940.
      expect(chartValueInUnit(960_000, FRIDAY, "usd")).toBeCloseTo(1_000, 9);
      expect(chartValueInUnit(940_000, FRIDAY, "usd", "debt")).toBeCloseTo(1_000, 9);
    } finally {
      db.prepare(`DELETE FROM fx_daily_bid_ask WHERE date = ? AND source = 'vitest'`).run(FRIDAY);
    }
  });
});

describe("propertyPagoAcumuladoInUnitByDate in UF", () => {
  const restoreUf = snapshotTables(["uf_daily"]);
  beforeAll(() => {
    db.prepare(`DELETE FROM uf_daily WHERE date LIKE '2098-%'`).run();
    const ins = db.prepare(`INSERT INTO uf_daily (date, clp_per_uf) VALUES (?, ?)`);
    ins.run("2098-03-10", 40_000);
    ins.run("2098-04-10", 50_000);
  });
  afterAll(() => restoreUf());

  const payment = (cuota: string, occurred_on: string, pago_clp: number) => ({ cuota, occurred_on, pago_clp }) as DeptoMortgageSheetRow;

  it("converts each payment at its own day's UF across a UF change, ordered by date then cuota", () => {
    // Given out of order: cuota 2 first. 800.000 / 40.000 = 20 UF; 1.000.000 / 50.000 = 20 UF; 500.000 / 50.000 = 10 UF.
    const ledger = [payment("2", "2098-04-10", 1_000_000), payment("1", "2098-03-10", 800_000), payment("3", "2098-04-10", 500_000)];
    const byDate = propertyPagoAcumuladoInUnitByDate(["2098-03-31", "2098-04-30", "2098-05-31"], ledger, "uf");
    expect(byDate.get("2098-03-31")).toBeCloseTo(20, 9);
    // The March payment stays at March's UF: 20 + 20 + 10, not 1.800.000 / 50.000 = 36 + 10.
    expect(byDate.get("2098-04-30")).toBeCloseTo(50, 9);
    expect(byDate.get("2098-05-31")).toBeCloseTo(50, 9);
    expect(propertyPagoAcumuladoInUnitByDate([], ledger, "uf").size).toBe(0);
    expect(propertyPagoAcumuladoInUnitByDate(["2098-03-31"], [], "uf").size).toBe(0);
  });
});

describe("patchAccountLiveLastPoint", () => {
  const TICKER = "VITESTLIVEPT.SN";
  const created = { accounts: [] as number[], movements: [] as number[] };
  let stock = 0;
  let restoreFx: () => void = () => {};
  const restoreBidAsk = snapshotTables(["fx_daily_bid_ask"]);

  const groupId = (slug: string) => (db.prepare(`SELECT id FROM asset_groups WHERE slug = ?`).get(slug) as { id: number }).id;

  beforeAll(() => {
    declareTestInstrument(TICKER, { market_kind: "santiago", quote_currency: "clp", display_symbol: "VITESTLIVEPT" });
    stock = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, equity_ticker) VALUES (?, 'vitest live point stock', ?)`)
        .run(groupId("brokerage_acciones"), TICKER).lastInsertRowid
    );
    created.accounts.push(stock);
    created.movements.push(
      Number(
        db
          .prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, flow_kind, units_delta) VALUES (?, 10000, 'clp', '2026-05-04', 'stock_buy', 10)`)
          .run(stock).lastInsertRowid
      )
    );
    db.prepare(`INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, 1234, 'clp')`).run(TICKER, FRIDAY);
    restoreFx = overrideFxDaily([[FRIDAY, MID]]);
    db.prepare(`DELETE FROM fx_daily_bid_ask WHERE date >= ?`).run(FRIDAY);
  });

  afterAll(() => {
    for (const id of created.movements) db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
    db.prepare(`DELETE FROM equity_daily WHERE ticker = ?`).run(TICKER);
    for (const id of created.accounts) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
    db.prepare(`DELETE FROM market_symbols WHERE ticker = ?`).run(TICKER);
    restoreFx();
    restoreBidAsk();
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-24T16:00:00Z")); // Sunday 12:00 Chile
  });
  afterEach(() => vi.useRealTimers());

  const row = () => ({ account_id: stock, bucket_slug: "brokerage_acciones" });
  const dk = () => String(stock);

  it("appends a today point from the latest one, priced at the account's today value", () => {
    const points = [
      { as_of_date: "2026-04-30", [dk()]: 9_000, other: 1 },
      { as_of_date: "2026-05-22", [dk()]: 11_000, other: 2 },
    ];
    const out = patchAccountLiveLastPoint(row(), "clp", points);
    // 10 shares × the Friday close 1.234 = 12.340; the other keys copied from the latest row.
    expect(out).toEqual([
      { as_of_date: "2026-04-30", [dk()]: 9_000, other: 1 },
      { as_of_date: "2026-05-22", [dk()]: 11_000, other: 2 },
      { as_of_date: "2026-05-24", [dk()]: 12_340, other: 2 },
    ]);
    // The input is not mutated.
    expect(points).toHaveLength(2);
  });

  it("overwrites a point already dated today (or later), and starts a series that has none", () => {
    const today = patchAccountLiveLastPoint(row(), "clp", [{ as_of_date: "2026-05-24", [dk()]: 1 }]);
    expect(today).toEqual([{ as_of_date: "2026-05-24", [dk()]: 12_340 }]);
    const later = patchAccountLiveLastPoint(row(), "clp", [
      { as_of_date: "2026-05-24", [dk()]: 1 },
      { as_of_date: "2026-05-31", [dk()]: 2 },
    ]);
    expect(later).toEqual([
      { as_of_date: "2026-05-24", [dk()]: 1 },
      { as_of_date: "2026-05-31", [dk()]: 12_340 },
    ]);
    expect(patchAccountLiveLastPoint(row(), "clp", [])).toEqual([{ as_of_date: "2026-05-24", [dk()]: 12_340 }]);
  });

  it("converts today's value once into the unit: a peso stock buys dollars at the Friday ask", () => {
    const out = patchAccountLiveLastPoint(row(), "usd", [{ as_of_date: "2026-05-22", [dk()]: 11 }]);
    // 12.340 / (950 + 2).
    expect(out[1]![dk()]).toBeCloseTo(12_340 / (MID + HALF), 9);
  });

  it("leaves a ledger account's points as they are", () => {
    const checking = (db.prepare(`SELECT a.id FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id WHERE g.slug LIKE '%cuenta_corriente%' LIMIT 1`).get() as
      | { id: number }
      | undefined)!;
    const points = [{ as_of_date: "2026-05-22", [String(checking.id)]: 5 }];
    expect(patchAccountLiveLastPoint({ account_id: checking.id, bucket_slug: null }, "clp", points)).toBe(points);
  });
});

