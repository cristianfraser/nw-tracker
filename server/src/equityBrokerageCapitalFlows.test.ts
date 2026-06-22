import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { accountUsesEquityMtm } from "./brokerageEquityMtm.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { db } from "./db.js";
import {
  getMergedDepositInflowEventsForAccount,
  getMergedDisplayDepositInflowEventsForAccount,
} from "./accountDeposits.js";
import { loadEquityBrokerageCapitalInflowEvents } from "./equityBrokerageCapitalFlows.js";
import {
  equityReturnSnapshot,
  pocketDepositsClpForAccount,
  totalDividendsReinvestedClpForAccount,
} from "./equityDividendReinvested.js";
import { getAccountMonthlyPerformance } from "./accountPerformance.js";
import { usdToClpAtPaymentRounded } from "./fxRates.js";

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

    db.prepare(
      `INSERT OR REPLACE INTO fx_daily (date, clp_per_usd) VALUES ('2026-04-30', 900), ('2026-05-05', 900), ('2026-03-26', 900)`
    ).run();
  });

  afterAll(() => {
    db.prepare(`DELETE FROM movements WHERE note = ?`).run(FIXTURE_NOTE);
    db.prepare(`DELETE FROM accounts WHERE name IN (?, ?)`).run(FIXTURE_USD, FIXTURE_STOCK);
  });

  it("loads stock_buy transfer as CLP capital inflow", () => {
    if (!usdId || !stockId || !transferId) return;
    expect(accountUsesEquityMtm(stockId)).toBe(true);

    const full = loadEquityBrokerageCapitalInflowEvents([stockId], false).get(stockId) ?? [];
    expect(full).toHaveLength(1);
    expect(full[0]!.occurred_on).toBe("2026-05-28");
    expect(full[0]!.amt).toBeCloseTo(usdToClpAtPaymentRounded(100, "2026-05-28")!, 0);

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

    const full = loadEquityBrokerageCapitalInflowEvents([stockId], false).get(stockId) ?? [];
    const june = full.filter((e) => e.occurred_on === "2026-06-16");
    expect(june).toHaveLength(1);
    expect(june[0]!.amt).toBeCloseTo(usdToClpAtPaymentRounded(50, "2026-06-16")!, 0);

    db.prepare(`DELETE FROM movements WHERE id = ?`).run(buyId);
  });

  it("excludes DRIP stock_buy from personal series when dividend_usd matches", () => {
    if (!usdId || !stockId) return;
    db.prepare(`DELETE FROM movements WHERE note LIKE ?`).run(`${FIXTURE_NOTE}|drip%`);

    const divId = Number(
      db
        .prepare(
          `INSERT INTO movements (account_id, amount_clp, occurred_on, note, flow_kind, amount_usd)
           VALUES (?, 0, '2026-02-05', ?, 'dividend_usd', 1.7)`
        )
        .run(stockId, `${FIXTURE_NOTE}|drip-div`).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO movements (
         account_id, from_account_id, to_account_id, amount_clp, occurred_on, note,
         units_delta, flow_kind, amount_usd, ticker
       ) VALUES (NULL, ?, ?, 0, '2026-02-05', ?, 0.01, 'stock_buy', 1.7, 'VITEST')`
    ).run(usdId, stockId, `${FIXTURE_NOTE}|drip-buy`);

    const full = loadEquityBrokerageCapitalInflowEvents([stockId], false).get(stockId) ?? [];
    const personal = loadEquityBrokerageCapitalInflowEvents([stockId], true).get(stockId) ?? [];
    const fullFeb = full.filter((e) => monthKeyFromYmd(e.occurred_on) === "2026-02");
    const personalFeb = personal.filter((e) => monthKeyFromYmd(e.occurred_on) === "2026-02");
    expect(fullFeb.length).toBeGreaterThan(personalFeb.length);

    db.prepare(`DELETE FROM movements WHERE id = ? OR note LIKE ?`).run(
      divId,
      `${FIXTURE_NOTE}|drip%`
    );
  });

  it("attributes only the dividend USD from a larger manual-reinvest stock_buy", () => {
    if (!usdId || !stockId) return;
    db.prepare(`DELETE FROM movements WHERE note LIKE ?`).run(`${FIXTURE_NOTE}|partial%`);

    db.prepare(
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note, flow_kind, amount_usd)
       VALUES (?, 0, '2026-03-24', ?, 'dividend_usd', 0.54)`
    ).run(stockId, `${FIXTURE_NOTE}|partial-div`);
    db.prepare(
      `INSERT INTO movements (
         account_id, from_account_id, to_account_id, amount_clp, occurred_on, note,
         units_delta, flow_kind, amount_usd, ticker
       ) VALUES (NULL, ?, ?, 0, '2026-03-26', ?, 0.865, 'stock_buy', 54.68, 'VITEST')`
    ).run(usdId, stockId, `${FIXTURE_NOTE}|partial-buy`);

    const full = loadEquityBrokerageCapitalInflowEvents([stockId], false).get(stockId) ?? [];
    const personal = loadEquityBrokerageCapitalInflowEvents([stockId], true).get(stockId) ?? [];
    const fullMar26 = full.find((e) => e.occurred_on === "2026-03-26");
    const pocketMar26 = personal.find((e) => e.occurred_on === "2026-03-26");
    expect(fullMar26).toBeDefined();
    expect(pocketMar26).toBeDefined();
    expect(fullMar26!.amt).toBeGreaterThan(pocketMar26!.amt);
    expect(pocketMar26!.amt).toBeCloseTo(
      usdToClpAtPaymentRounded(54.68 - 0.54, "2026-03-26")!,
      0
    );

    db.prepare(`DELETE FROM movements WHERE note LIKE ?`).run(`${FIXTURE_NOTE}|partial%`);
  });
});

describe("equityBrokerageCapitalFlows dev data", () => {
  it("OILK loads stock_buy transfer capital when migrated data exists", () => {
    const oilkId = findEquityAccountByName("OILK");
    if (oilkId == null || !hasStockBuyTransfer(oilkId)) return;

    const full = loadEquityBrokerageCapitalInflowEvents([oilkId], false).get(oilkId) ?? [];
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
    expect(mayEvent!.amt).toBeCloseTo(
      usdToClpAtPaymentRounded(mayBuy.amount_usd, mayBuy.occurred_on)!,
      0
    );
    expect(mayEvent!.amt).toBeGreaterThan(2_000_000);
  });

  it("SPY pocket deposits are below cost basis when dividends were reinvested", () => {
    const spyId = findEquityAccountByName("SPY");
    if (spyId == null || !hasStockBuyTransfer(spyId)) return;

    const pocket = pocketDepositsClpForAccount(spyId);
    const dividends = totalDividendsReinvestedClpForAccount(spyId);
    if (dividends <= 0) return;

    const snap = equityReturnSnapshot(spyId, pocket, null);
    expect(snap).not.toBeNull();
    expect(snap!.dividends_reinvested_clp).toBeGreaterThan(0);
    expect(snap!.cost_basis_clp).toBeGreaterThan(pocket);
    expect(snap!.cost_basis_clp).toBeCloseTo(pocket + dividends, -2);
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
