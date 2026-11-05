import { afterEach, describe, expect, it } from "vitest";
import { equityShareUnitsThroughYmd, upsertEquityDailySeries } from "./brokerageEquityMtm.js";
import { db } from "./db.js";
import { equityBrokerHoldings } from "./equityBrokerHoldings.js";
import { insertEquityDividendsIfMissing } from "./equityDividends.js";
import { equityAsTradedClose, equitySplitFactorAfter, recordEquitySplit } from "./equitySplits.js";
import { loadEquityTaxLotEvents } from "./equityTaxLotEvents.js";
import { realizeTaxLots } from "./taxLots.js";

const PREFIX = "Vitest · splits";
const TICKER = "VTSPLITX";
const EX = "2025-03-05";
const created: { accounts: number[]; movements: number[] } = { accounts: [], movements: [] };

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

function closes(rows: [string, number][]): void {
  const ins = db.prepare(`INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, ?, 'usd')`);
  for (const [d, c] of rows) ins.run(TICKER, d, c);
}

function storedClose(d: string): number {
  return (db.prepare(`SELECT close FROM equity_daily WHERE ticker = ? AND trade_date = ?`).get(TICKER, d) as { close: number })
    .close;
}

function splitRows(accountId: number): { id: number; units_delta: number }[] {
  return db
    .prepare(`SELECT id, units_delta FROM movements WHERE account_id = ? AND flow_kind = 'stock_split'`)
    .all(accountId) as { id: number; units_delta: number }[];
}

/** Two brokers buy before the split; prices as traded: 300 before, 100 from the ex-date. */
function setup(): { stock: number; cashA: number; cashB: number } {
  const stock = account("stock", TICKER);
  const cashA = account("cash A");
  const cashB = account("cash B");
  trade(cashA, stock, "2025-03-03", 4, 1200, "stock_buy");
  trade(cashB, stock, "2025-03-03", 6, 1800, "stock_buy");
  closes([
    ["2025-03-03", 300],
    ["2025-03-04", 303],
    ["2025-03-05", 101],
  ]);
  return { stock, cashA, cashB };
}

afterEach(() => {
  for (const a of created.accounts) {
    db.prepare(`DELETE FROM movements WHERE account_id = ? OR from_account_id = ? OR to_account_id = ?`).run(a, a, a);
  }
  created.movements.length = 0;
  for (const id of created.accounts.splice(0)) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  db.prepare(`DELETE FROM equity_daily WHERE ticker = ?`).run(TICKER);
  db.prepare(`DELETE FROM equity_dividends WHERE ticker = ?`).run(TICKER);
  db.prepare(`DELETE FROM equity_splits WHERE ticker = ?`).run(TICKER);
});

const split3 = { ticker: TICKER, ex_date: EX, numerator: 3, denominator: 1, source: "manual" as const };

describe("recordEquitySplit", () => {
  it("re-frames the prices before the ex-date and gives each holder its new shares, the value unchanged", () => {
    const { stock } = setup();
    insertEquityDividendsIfMissing(TICKER, [{ ex_date: "2025-03-03", amount: 0.9 }]);
    const valueBefore = equityShareUnitsThroughYmd(stock, "2025-03-04") * equityAsTradedClose(TICKER, "2025-03-04")!;

    const out = recordEquitySplit(split3);
    expect(out.status).toBe("recorded");
    expect(out.rescaled).toMatchObject({ closes: 2, dividends: 1 });
    expect(storedClose("2025-03-03")).toBeCloseTo(100, 9);
    expect(storedClose("2025-03-04")).toBeCloseTo(101, 9);
    expect(storedClose("2025-03-05")).toBe(101);
    expect(splitRows(stock)).toEqual([{ id: out.ledger[0]!.movement_id, units_delta: 20 }]);

    // The day before keeps its shares and its traded price; the ex-date has three times the shares.
    expect(equityShareUnitsThroughYmd(stock, "2025-03-04")).toBe(10);
    expect(equityShareUnitsThroughYmd(stock, "2025-03-05")).toBe(30);
    expect(equitySplitFactorAfter(TICKER, "2025-03-04")).toBe(3);
    expect(equityShareUnitsThroughYmd(stock, "2025-03-04") * equityAsTradedClose(TICKER, "2025-03-04")!).toBeCloseTo(
      valueBefore,
      9
    );
    expect(equityShareUnitsThroughYmd(stock, "2025-03-05") * equityAsTradedClose(TICKER, "2025-03-05")!).toBeCloseTo(
      3030,
      9
    );
  });

  it("is idempotent, and refuses another ratio for the same ex-date", () => {
    const { stock } = setup();
    recordEquitySplit(split3);
    const again = recordEquitySplit({ ...split3, source: "yahoo" });
    expect(again.status).toBe("unchanged");
    expect(again.ledger[0]!.status).toBe("present");
    expect(storedClose("2025-03-03")).toBeCloseTo(100, 9);
    expect(splitRows(stock)).toHaveLength(1);
    expect(() => recordEquitySplit({ ...split3, numerator: 4 })).toThrow(/recorded 3:1/);
  });

  it("keeps rows a source had already stored in post-split terms", () => {
    setup();
    db.prepare(`UPDATE equity_daily SET close = 101 WHERE ticker = ? AND trade_date = '2025-03-04'`).run(TICKER);
    const out = recordEquitySplit(split3);
    expect(out.rescaled.closes).toBe(1);
    expect(storedClose("2025-03-04")).toBe(101);
    expect(storedClose("2025-03-03")).toBeCloseTo(100, 9);
  });

  it("refuses an ex-date that has not come yet", () => {
    setup();
    expect(() => recordEquitySplit({ ...split3, ex_date: "2099-01-02" })).toThrow(/has not come yet/);
  });
});

describe("prices around a split", () => {
  it("re-frames a close sent as traded, and refuses a split-like move nobody recorded", () => {
    setup();
    expect(() => upsertEquityDailySeries(TICKER, { dates: ["2025-03-06"], closes: [33] })).toThrow(/split no source has recorded/);
    recordEquitySplit(split3);
    upsertEquityDailySeries(TICKER, { dates: ["2025-03-04", "2025-03-06"], closes: [303, 102] });
    expect(storedClose("2025-03-04")).toBeCloseTo(101, 9);
    expect(storedClose("2025-03-06")).toBe(102);
    // A dividend a source still states pre-split is the stored one.
    insertEquityDividendsIfMissing(TICKER, [{ ex_date: "2025-03-03", amount: 0.3 }]);
    expect(() => insertEquityDividendsIfMissing(TICKER, [{ ex_date: "2025-03-03", amount: 0.9 }])).not.toThrow();
  });
});

describe("ledger readers", () => {
  it("scales every broker's shares and every open lot, cost and purchase date unchanged", () => {
    const { stock, cashA, cashB } = setup();
    recordEquitySplit(split3);
    const byBroker = equityBrokerHoldings(stock, "2025-03-05", null).map((h) => [h.cash_account_id, h.units]);
    expect(byBroker).toEqual([
      [cashB, 18],
      [cashA, 12],
    ]);
    trade(stock, cashA, "2025-03-06", 15, 1600, "stock_sell");
    const { disposals, openLots } = realizeTaxLots(loadEquityTaxLotEvents(stock).events, "fifo");
    expect(disposals).toHaveLength(1);
    expect(disposals[0]!.slices.map((s) => [s.units, s.cost, s.acquiredOn])).toEqual([
      [12, 1200, "2025-03-03"],
      [3, 300, "2025-03-03"],
    ]);
    expect(openLots.map((l) => [l.units, l.cost])).toEqual([[15, 1500]]);
  });
});
