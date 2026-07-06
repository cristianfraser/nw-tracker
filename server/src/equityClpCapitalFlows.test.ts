import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { db } from "./db.js";
import { getMergedDepositInflowEventsForAccount } from "./accountDeposits.js";
import { loadEquityBrokerageCapitalInflowEvents } from "./equityBrokerageCapitalFlows.js";
import { clpCashBalanceClpAt } from "./clpCashAccounts.js";

const FIXTURE_CLP = "vitest-clp-cap-cash";
const FIXTURE_STOCK = "vitest-clp-cap-stock";
const FIXTURE_NOTE = "vitest-clp-capital-flows";

/**
 * CLP-funded stock_buy (CLP-quoted .SN stock): the transfer carries amount_clp only.
 * - Equity account: counts as a `clp_wire` capital inflow at face CLP (cost basis).
 * - Funding CLP cash account: balance AND aportes both drop by amount_clp (no phantom P/L).
 */
describe("CLP-funded stock_buy capital flows", () => {
  let clpId = 0;
  let stockId = 0;

  beforeAll(() => {
    const stockLeaf = db
      .prepare(`SELECT id FROM asset_groups WHERE slug LIKE 'brokerage_acciones__%' LIMIT 1`)
      .get() as { id: number } | undefined;
    const clpLeaf = db
      .prepare(`SELECT id FROM asset_groups WHERE slug LIKE '%__clp' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!stockLeaf || !clpLeaf) return;

    db.prepare(`DELETE FROM movements WHERE note LIKE ?`).run(`${FIXTURE_NOTE}%`);
    db.prepare(`DELETE FROM accounts WHERE name IN (?, ?)`).run(FIXTURE_CLP, FIXTURE_STOCK);

    const ins = db.prepare(`INSERT INTO accounts (asset_group_id, name, equity_ticker) VALUES (?, ?, ?)`);
    clpId = Number(ins.run(clpLeaf.id, FIXTURE_CLP, null).lastInsertRowid);
    stockId = Number(ins.run(stockLeaf.id, FIXTURE_STOCK, "VITEST.SN").lastInsertRowid);

    // Fund the CLP cash account, then buy the .SN stock from it.
    db.prepare(
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note, flow_kind)
       VALUES (?, 3_000_000, '2026-07-02', ?, 'deposit_clp')`
    ).run(clpId, `${FIXTURE_NOTE}|deposit`);
    db.prepare(
      `INSERT INTO movements (
         account_id, from_account_id, to_account_id, amount_clp, occurred_on, note,
         units_delta, flow_kind, amount_usd, ticker
       ) VALUES (NULL, ?, ?, 2_985_000, '2026-07-03', ?, 2282, 'stock_buy', NULL, 'VITEST.SN')`
    ).run(clpId, stockId, `${FIXTURE_NOTE}|buy`);
  });

  afterAll(() => {
    db.prepare(`DELETE FROM movements WHERE note LIKE ?`).run(`${FIXTURE_NOTE}%`);
    db.prepare(`DELETE FROM accounts WHERE name IN (?, ?)`).run(FIXTURE_CLP, FIXTURE_STOCK);
  });

  it("counts the CLP buy as a clp_wire capital inflow on the equity account", () => {
    if (!clpId || !stockId) return;
    const events = loadEquityBrokerageCapitalInflowEvents([stockId]).get(stockId) ?? [];
    expect(events).toHaveLength(1);
    expect(events[0]!.amt).toBeCloseTo(2_985_000, 6);
    expect(events[0]!.capital_kind).toBe("clp_wire");
    expect(events[0]!.amt_usd ?? null).toBeNull();
  });

  it("drops the CLP cash account's balance and aportes together", () => {
    if (!clpId || !stockId) return;
    expect(clpCashBalanceClpAt(clpId, "2026-07-04")).toBeCloseTo(15_000, 6);
    const aportes = getMergedDepositInflowEventsForAccount(clpId);
    const total = aportes.reduce((s, e) => s + e.amt, 0);
    expect(total).toBeCloseTo(3_000_000 - 2_985_000, 6);
  });
});
