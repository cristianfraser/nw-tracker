import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { db } from "./db.js";
import { overrideFxDaily } from "./test/fxDailyFixture.js";
import {
  equityReturnSnapshot,
  getDividendReinvestedInflowEventsForAccount,
  totalDividendsReinvestedClpForAccount,
} from "./equityDividendReinvested.js";

const FIXTURE_STOCK = "vitest-drip-equity-stock";
const FIXTURE_NOTE = "vitest-drip-equity";

let restoreFx: (() => void) | null = null;

describe("equityDividendReinvested", () => {
  let stockId = 0;

  beforeAll(() => {
    const leaf = db
      .prepare(`SELECT id FROM asset_groups WHERE slug LIKE 'brokerage_acciones__%' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!leaf) return;
    db.prepare(`DELETE FROM movements WHERE note LIKE ?`).run(`${FIXTURE_NOTE}%`);
    db.prepare(`DELETE FROM accounts WHERE name = ?`).run(FIXTURE_STOCK);
    stockId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, equity_ticker) VALUES (?, ?, ?)`)
        .run(leaf.id, FIXTURE_STOCK, "VITEST").lastInsertRowid
    );
    restoreFx = overrideFxDaily([
      ["2026-04-30", 900],
      ["2026-05-05", 900],
    ]);
    db.prepare(
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note, flow_kind, amount_usd, units_delta, ticker)
       VALUES (?, 0, '2026-04-30', ?, 'dividend_usd', 1.57, 0.002175, 'VITEST')`
    ).run(stockId, `${FIXTURE_NOTE}|div`);
  });

  afterAll(() => {
    restoreFx?.();
    db.prepare(`DELETE FROM movements WHERE note LIKE ?`).run(`${FIXTURE_NOTE}%`);
    db.prepare(`DELETE FROM accounts WHERE name = ?`).run(FIXTURE_STOCK);
  });

  it("sums dividend_usd CLP for cost basis leg", () => {
    if (!stockId) return;
    const total = totalDividendsReinvestedClpForAccount(stockId);
    expect(total).toBeCloseTo(1.57 * 900, 0);
    expect(getDividendReinvestedInflowEventsForAccount(stockId)).toHaveLength(1);
  });

  it("computes return on deposited vs naive gain", () => {
    if (!stockId) return;
    const deposited = 3_000_000;
    const value = 3_100_000;
    const snap = equityReturnSnapshot(stockId, deposited, value);
    expect(snap).not.toBeNull();
    const divClp = 1.57 * 900;
    expect(snap!.cost_basis_clp).toBeCloseTo(deposited + divClp, 0);
    expect(snap!.total_return_clp).toBeCloseTo(value - deposited - divClp, 0);
    expect(snap!.naive_gain_clp).toBeCloseTo(value - deposited, 0);
    expect(snap!.return_on_deposited_pct).toBeCloseTo(snap!.total_return_clp! / deposited, 6);
  });
});
