import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { accountUsesEquityMtm } from "./brokerageEquityMtm.js";
import { overrideFxDaily } from "./test/fxDailyFixture.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { db } from "./db.js";
import {
  getMergedDepositInflowEventsForAccount,
  getMergedDisplayDepositInflowEventsForAccount,
  pocketDepositsClpForAccount,
} from "./accountDeposits.js";
import { loadEquityBrokerageCapitalInflowEvents } from "./equityBrokerageCapitalFlows.js";
import { equityReturnSnapshot, totalDividendsClpForAccount } from "./equityReturns.js";
import { getAccountMonthlyPerformance } from "./accountPerformance.js";
import { usdToClpReferenceRounded } from "./fxRates.js";

const FIXTURE_USD = "vitest-equity-cap-usd";
const FIXTURE_STOCK = "vitest-equity-cap-stock";
const FIXTURE_NOTE = "vitest-equity-capital-flows";

function findEquityAccountByName(name: string): number | null {
  const row = db.prepare(`SELECT id FROM accounts WHERE name = ? LIMIT 1`).get(name) as
    | { id: number }
    | undefined;
  return row?.id ?? null;
}

function hasStockBuyTransfer(accountId: number): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM movements
         WHERE to_account_id = ? AND flow_kind = 'stock_buy' LIMIT 1`
      )
      .get(accountId) != null
  );
}

let restoreFx: (() => void) | null = null;

describe("equityBrokerageCapitalFlows fixture", () => {
  let usdId = 0;
  let stockId = 0;
  let transferId = 0;

  beforeAll(() => {
    const leaf = db
      .prepare(
        `SELECT id FROM asset_groups WHERE slug LIKE 'brokerage_acciones__%' LIMIT 1`
      )
      .get() as { id: number } | undefined;
    const usdLeaf = db
      .prepare(`SELECT id FROM asset_groups WHERE slug LIKE '%__usd' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!leaf || !usdLeaf) return;

    db.prepare(`DELETE FROM movements WHERE note = ?`).run(FIXTURE_NOTE);
    db.prepare(`DELETE FROM accounts WHERE name IN (?, ?)`).run(FIXTURE_USD, FIXTURE_STOCK);

    const ins = db.prepare(`INSERT INTO accounts (asset_group_id, name, equity_ticker) VALUES (?, ?, ?)`);
    usdId = Number(ins.run(usdLeaf.id, FIXTURE_USD, null).lastInsertRowid);
    stockId = Number(ins.run(leaf.id, FIXTURE_STOCK, "VITEST").lastInsertRowid);

    transferId = Number(
      db
        .prepare(
          `INSERT INTO movements (
             account_id, from_account_id, to_account_id, amount_clp, occurred_on, note,
             units_delta, flow_kind, amount_usd, ticker
           ) VALUES (NULL, ?, ?, 0, '2026-05-28', ?, 1.5, 'stock_buy', 100, 'VITEST')`
        )
        .run(usdId, stockId, FIXTURE_NOTE).lastInsertRowid
    );

    restoreFx = overrideFxDaily([
      ["2026-04-30", 900],
      ["2026-05-05", 900],
      ["2026-03-26", 900],
    ]);
  });

  afterAll(() => {
    restoreFx?.();
    db.prepare(`DELETE FROM movements WHERE note = ?`).run(FIXTURE_NOTE);
    db.prepare(`DELETE FROM accounts WHERE name IN (?, ?)`).run(FIXTURE_USD, FIXTURE_STOCK);
  });

  it("loads stock_buy transfer as CLP capital inflow", () => {
    if (!usdId || !stockId || !transferId) return;
    expect(accountUsesEquityMtm(stockId)).toBe(true);

    const full = loadEquityBrokerageCapitalInflowEvents([stockId]).get(stockId) ?? [];
    expect(full).toHaveLength(1);
    expect(full[0]!.occurred_on).toBe("2026-05-28");
    expect(full[0]!.amt).toBeCloseTo(usdToClpReferenceRounded(100, "2026-05-28")!, 0);

    const merged = getMergedDepositInflowEventsForAccount(stockId);
    expect(merged.reduce((s, e) => s + e.amt, 0)).toBeCloseTo(full[0]!.amt, 0);
  });

  it("loads stock_buy on account_id (panel create without transfer row) as capital inflow", () => {
    if (!stockId) return;
    db.prepare(`DELETE FROM movements WHERE note = ?`).run(`${FIXTURE_NOTE}|account-id-buy`);

    const buyId = Number(
      db
        .prepare(
          `INSERT INTO movements (
             account_id, amount_clp, occurred_on, note, units_delta, flow_kind, amount_usd, ticker
           ) VALUES (?, 0, '2026-06-16', ?, 2, 'stock_buy', 50, 'VITEST')`
        )
        .run(stockId, `${FIXTURE_NOTE}|account-id-buy`).lastInsertRowid
    );
    expect(buyId).toBeGreaterThan(0);

    const full = loadEquityBrokerageCapitalInflowEvents([stockId]).get(stockId) ?? [];
    const june = full.filter((e) => e.occurred_on === "2026-06-16");
    expect(june).toHaveLength(1);
    expect(june[0]!.amt).toBeCloseTo(usdToClpReferenceRounded(50, "2026-06-16")!, 0);

    db.prepare(`DELETE FROM movements WHERE id = ?`).run(buyId);
  });

  it("DRIP dividend_usd (units on the row) contributes no capital flow", () => {
    if (!stockId) return;
    db.prepare(`DELETE FROM movements WHERE note LIKE ?`).run(`${FIXTURE_NOTE}|drip%`);

    const divId = Number(
      db
        .prepare(
          `INSERT INTO movements (account_id, amount_clp, occurred_on, note, flow_kind, amount_usd, units_delta)
           VALUES (?, 0, '2026-02-05', ?, 'dividend_usd', 1.7, 0.01)`
        )
        .run(stockId, `${FIXTURE_NOTE}|drip-div`).lastInsertRowid
    );

    const events = loadEquityBrokerageCapitalInflowEvents([stockId]).get(stockId) ?? [];
    expect(events.filter((e) => monthKeyFromYmd(e.occurred_on) === "2026-02")).toHaveLength(0);
    // The dividend still counts as informational return income.
    expect(totalDividendsClpForAccount(stockId)).toBeCloseTo(
      usdToClpReferenceRounded(1.7, "2026-02-05")!,
      0
    );

    db.prepare(`DELETE FROM movements WHERE id = ?`).run(divId);
  });

  it("throws on unitless dividend_usd (cash dividends must be dividend_payout)", () => {
    if (!stockId) return;
    const divId = Number(
      db
        .prepare(
          `INSERT INTO movements (account_id, amount_clp, occurred_on, note, flow_kind, amount_usd)
           VALUES (?, 0, '2026-03-24', ?, 'dividend_usd', 0.54)`
        )
        .run(stockId, `${FIXTURE_NOTE}|unitless-div`).lastInsertRowid
    );

    expect(() => loadEquityBrokerageCapitalInflowEvents([stockId])).toThrow(/units_delta/);

    db.prepare(`DELETE FROM movements WHERE id = ?`).run(divId);
  });
});

describe("equityBrokerageCapitalFlows dev data", () => {
  it("OILK loads stock_buy transfer capital when migrated data exists", () => {
    const oilkId = findEquityAccountByName("OILK");
    if (oilkId == null || !hasStockBuyTransfer(oilkId)) return;

    const full = loadEquityBrokerageCapitalInflowEvents([oilkId]).get(oilkId) ?? [];
    expect(full.length).toBeGreaterThan(0);

    const mayBuy = db
      .prepare(
        `SELECT occurred_on, amount_usd FROM movements
         WHERE to_account_id = ? AND flow_kind = 'stock_buy'
           AND occurred_on LIKE '2026-05%'
         LIMIT 1`
      )
      .get(oilkId) as { occurred_on: string; amount_usd: number } | undefined;
    if (!mayBuy) return;

    const mayEvent = full.find((e) => monthKeyFromYmd(e.occurred_on) === "2026-05");
    expect(mayEvent).toBeDefined();
    if (mayEvent!.capital_kind === "clp_wire") {
      expect(mayEvent!.amt).toBeGreaterThan(2_900_000);
      expect(mayEvent!.amt_usd).toBeCloseTo(Math.abs(mayBuy.amount_usd), 1);
    } else {
      expect(mayEvent!.amt).toBeCloseTo(
        usdToClpReferenceRounded(mayBuy.amount_usd, mayBuy.occurred_on)!,
        0
      );
    }
    expect(mayEvent!.amt).toBeGreaterThan(2_000_000);
  });

  it("SPY return snapshot: total return vs deposited, dividends informational", () => {
    const spyId = findEquityAccountByName("SPY");
    if (spyId == null || !hasStockBuyTransfer(spyId)) return;

    const pocket = pocketDepositsClpForAccount(spyId);
    const dividends = totalDividendsClpForAccount(spyId);
    if (dividends <= 0) return;

    const snap = equityReturnSnapshot(spyId, pocket, pocket + 1_000);
    expect(snap).not.toBeNull();
    expect(snap!.dividends_clp).toBeCloseTo(dividends, -2);
    expect(snap!.total_return_clp).toBeCloseTo(1_000, 0);
  });

  it("merged deposits include equity transfer capital for OILK", () => {
    const oilkId = findEquityAccountByName("OILK");
    if (oilkId == null || !hasStockBuyTransfer(oilkId)) return;

    const merged = getMergedDepositInflowEventsForAccount(oilkId);
    const display = getMergedDisplayDepositInflowEventsForAccount(oilkId);
    expect(merged.reduce((s, e) => s + e.amt, 0)).toBeGreaterThan(0);
    expect(display.reduce((s, e) => s + e.amt, 0)).toBeGreaterThan(0);
  });
});

describe("getAccountMonthlyPerformance equity MTM", () => {
  it("OILK May 2026 attributes stock_buy USD to net_capital_flow, not all P/L", () => {
    const oilkId = findEquityAccountByName("OILK");
    if (oilkId == null || !hasStockBuyTransfer(oilkId)) return;

    const perf = getAccountMonthlyPerformance(oilkId, "clp");
    const may = perf?.monthly.find((r) => monthKeyFromYmd(r.as_of_date) === "2026-05");
    if (!may) return;

    expect(may.net_capital_flow).toBeGreaterThan(2_000_000);
    expect(may.nominal_pl).not.toBeNull();
    expect(Math.abs(may.nominal_pl!)).toBeLessThan(Math.abs(may.closing_value) * 0.5);
    if (may.prior_closing != null && may.nominal_pl != null) {
      expect(may.nominal_pl).toBeCloseTo(
        may.closing_value - may.prior_closing - may.net_capital_flow,
        -2
      );
    }
  });

  it("OILK stock_units_inflow includes transfer to_account legs", () => {
    const oilkId = findEquityAccountByName("OILK");
    if (oilkId == null || !hasStockBuyTransfer(oilkId)) return;

    const perf = getAccountMonthlyPerformance(oilkId, "clp");
    const may = perf?.monthly.find((r) => monthKeyFromYmd(r.as_of_date) === "2026-05");
    if (!may) return;

    const transferUnits = db
      .prepare(
        `SELECT COALESCE(units_delta, 0) AS ud FROM movements
         WHERE to_account_id = ? AND flow_kind = 'stock_buy'
           AND occurred_on LIKE '2026-05%'`
      )
      .get(oilkId) as { ud: number } | undefined;
    if (!transferUnits || transferUnits.ud <= 0) return;

    expect(may.stock_units_inflow).toBeCloseTo(transferUnits.ud, 6);
  });

  it("OILK June 2026 stock_sell zeros shares and attributes outflow to net_capital_flow, not P/L", () => {
    const oilkId = findEquityAccountByName("OILK");
    if (oilkId == null) return;

    const sell = db
      .prepare(
        `SELECT 1 FROM movements
         WHERE from_account_id = ? AND flow_kind = 'stock_sell'
           AND occurred_on LIKE '2026-06%'`
      )
      .get(oilkId);
    if (!sell) return;

    const perf = getAccountMonthlyPerformance(oilkId, "clp");
    const june = perf?.monthly.find((r) => monthKeyFromYmd(r.as_of_date) === "2026-06");
    if (!june) return;

    expect(june.net_capital_flow).toBeLessThan(0);
    expect(Math.abs(june.nominal_pl ?? 0)).toBeLessThan(Math.abs(june.net_capital_flow) * 0.15);
    if (june.prior_closing != null && june.nominal_pl != null) {
      expect(june.nominal_pl).toBeCloseTo(
        june.closing_value - june.prior_closing - june.net_capital_flow,
        -2
      );
    }
  });

  it("CCJ June 2026 panel stock_buy counts deposit in net_capital_flow, not P/L", () => {
    const ccjId = findEquityAccountByName("CCJ");
    if (ccjId == null) return;

    const buy = db
      .prepare(
        `SELECT 1 FROM movements
         WHERE account_id = ? AND flow_kind = 'stock_buy'
           AND occurred_on LIKE '2026-06%'`
      )
      .get(ccjId);
    if (!buy) return;

    const perf = getAccountMonthlyPerformance(ccjId, "clp");
    const june = perf?.monthly.find((r) => monthKeyFromYmd(r.as_of_date) === "2026-06");
    if (!june) return;

    expect(june.net_capital_flow).toBeGreaterThan(2_000_000);
    expect(Math.abs(june.nominal_pl ?? 0)).toBeLessThan(Math.abs(june.net_capital_flow) * 0.15);
    if (june.prior_closing != null && june.nominal_pl != null) {
      expect(june.nominal_pl).toBeCloseTo(
        june.closing_value - june.prior_closing - june.net_capital_flow,
        -2
      );
    }
  });

  it("fixture stock account monthly perf uses transfer capital", () => {
    const row = db
      .prepare(`SELECT id FROM accounts WHERE name = ? LIMIT 1`)
      .get(FIXTURE_STOCK) as { id: number } | undefined;
    if (!row) return;

    const perf = getAccountMonthlyPerformance(row.id, "clp");
    const may = perf?.monthly.find((r) => monthKeyFromYmd(r.as_of_date) === "2026-05");
    if (!may) return;

    expect(may.net_capital_flow).toBeGreaterThan(0);
    expect(may.nominal_pl).not.toBeCloseTo(may.closing_value, 0);
  });
});
