import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { db } from "./db.js";
import { overrideFxDaily } from "./test/fxDailyFixture.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { validateMovementCreate, type AccountRow } from "./movementUnitsPolicy.js";
import { totalDepositsClpForAccount } from "./accountDeposits.js";
import { clpCashBalanceClpAt } from "./clpCashAccounts.js";
import { usdCashBalanceUsdAt, usdCashBalanceClpAt } from "./usdCashAccounts.js";
import { getAccountMonthlyPerformance } from "./accountPerformance.js";
import { flowsDepositsNetTotalByAccount, flowsDepositsNetTotalUsdByAccount } from "./flowsDeposits.js";
import { monthKeyFromYmd } from "./calendarMonth.js";

const FIXTURE_USD = "vitest-interest-usd";
const FIXTURE_CLP = "vitest-interest-clp";
const NOTE = "vitest-cash-interest";

function insertAccountIdMovement(v: {
  account_id: number;
  amount_clp: number;
  amount_usd: number | null;
  occurred_on: string;
  flow_kind: string;
}): number {
  return Number(
    db
      .prepare(
        `INSERT INTO movements (account_id, amount_clp, occurred_on, note, flow_kind, amount_usd)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(v.account_id, v.amount_clp, v.occurred_on, NOTE, v.flow_kind, v.amount_usd)
      .lastInsertRowid
  );
}

let restoreFx: (() => void) | null = null;

describe("cash-account interest (savings_earnings): balance up, deposits flat, P/L", () => {
  let usdId = 0;
  let clpId = 0;
  let usdRow: AccountRow;
  let clpRow: AccountRow;

  beforeAll(() => {
    const usdLeaf = db
      .prepare(`SELECT id, slug FROM asset_groups WHERE slug LIKE '%__usd' LIMIT 1`)
      .get() as { id: number; slug: string } | undefined;
    const clpLeaf = db
      .prepare(`SELECT id, slug FROM asset_groups WHERE slug LIKE '%__clp' LIMIT 1`)
      .get() as { id: number; slug: string } | undefined;
    if (!usdLeaf || !clpLeaf) return;

    db.prepare(`DELETE FROM movements WHERE note = ?`).run(NOTE);
    db.prepare(`DELETE FROM accounts WHERE name IN (?, ?)`).run(FIXTURE_USD, FIXTURE_CLP);
    const ins = db.prepare(`INSERT INTO accounts (asset_group_id, name) VALUES (?, ?)`);
    usdId = Number(ins.run(usdLeaf.id, FIXTURE_USD).lastInsertRowid);
    clpId = Number(ins.run(clpLeaf.id, FIXTURE_CLP).lastInsertRowid);
    usdRow = { bucket_slug: usdLeaf.slug, group_slug: usdLeaf.slug };
    clpRow = { bucket_slug: clpLeaf.slug, group_slug: clpLeaf.slug };

    // Pin fx for every date the assertions resolve: the fixture month-ends, the 2026-12-31
    // as-of valuation, and *today* (deposited-capital display converts at the latest on-or-
    // before-today row). Without these the test drifts with every daily fx sync.
    restoreFx = overrideFxDaily([
      ["2026-05-31", 900],
      ["2026-06-30", 900],
      ["2026-07-31", 900],
      ["2026-12-31", 900],
      [chileCalendarTodayYmd(), 900],
    ]);

    // USD cash: buy 1000 USD of capital in May, earn 10 USD interest in June.
    insertAccountIdMovement({ account_id: usdId, amount_clp: -900_000, amount_usd: 1000, occurred_on: "2026-05-15", flow_kind: "compra_usd_venta_clp" });
    insertAccountIdMovement({ account_id: usdId, amount_clp: 0, amount_usd: 10, occurred_on: "2026-06-15", flow_kind: "savings_earnings" });

    // CLP cash: deposit 2,000,000 in May, earn 5,000 interest in June.
    insertAccountIdMovement({ account_id: clpId, amount_clp: 2_000_000, amount_usd: null, occurred_on: "2026-05-15", flow_kind: "deposit_clp" });
    insertAccountIdMovement({ account_id: clpId, amount_clp: 5_000, amount_usd: null, occurred_on: "2026-06-15", flow_kind: "savings_earnings" });
  });

  afterAll(() => {
    restoreFx?.();
    db.prepare(`DELETE FROM movements WHERE note = ?`).run(NOTE);
    db.prepare(`DELETE FROM accounts WHERE name IN (?, ?)`).run(FIXTURE_USD, FIXTURE_CLP);
  });

  it("validates savings_earnings on USD cash (amount_usd) and CLP cash (amount_clp)", () => {
    if (!usdId || !clpId) return;
    const vUsd = validateMovementCreate(usdRow, { occurred_on: "2026-06-15", flow_kind: "savings_earnings", amount_usd: 10 }, usdId);
    expect(vUsd.ok).toBe(true);
    if (vUsd.ok) {
      expect(vUsd.flow_kind).toBe("savings_earnings");
      expect(vUsd.amount_usd).toBe(10);
    }
    const vClp = validateMovementCreate(clpRow, { occurred_on: "2026-06-15", flow_kind: "savings_earnings", amount_clp: 5000 }, clpId);
    expect(vClp.ok).toBe(true);
    if (vClp.ok) expect(vClp.flow_kind).toBe("savings_earnings");

    // USD cash requires amount_usd for interest; CLP cash requires amount_clp.
    expect(validateMovementCreate(usdRow, { occurred_on: "2026-06-15", flow_kind: "savings_earnings" }, usdId).ok).toBe(false);
    expect(validateMovementCreate(clpRow, { occurred_on: "2026-06-15", flow_kind: "savings_earnings" }, clpId).ok).toBe(false);
  });

  it("interest raises the balance but is excluded from deposited capital", () => {
    if (!usdId || !clpId) return;
    // USD: balance includes the 10 USD interest; deposited excludes it.
    expect(usdCashBalanceUsdAt(usdId, "2026-12-31")).toBeCloseTo(1010, 6);
    const usdValueClp = usdCashBalanceClpAt(usdId, "2026-12-31");
    const usdDepClp = totalDepositsClpForAccount(usdId);
    // P/L = value − deposited = the 10 USD interest converted at the same (sell) rate as the balance.
    const impliedRate = usdValueClp / 1010;
    expect(usdValueClp - usdDepClp).toBeCloseTo(10 * impliedRate, 0);

    // CLP: balance includes 5,000 interest; deposited excludes it.
    expect(clpCashBalanceClpAt(clpId, "2026-12-31")).toBeCloseTo(2_005_000, 0);
    const clpDep = totalDepositsClpForAccount(clpId);
    expect(clpDep).toBeCloseTo(2_000_000, 0);
    expect(clpCashBalanceClpAt(clpId, "2026-12-31") - clpDep).toBeCloseTo(5_000, 0);
  });

  it("dashboard deposits exclude interest so total P/L (value − deposited) = interest", () => {
    if (!usdId) return;
    // Regression: flowsDepositsNet* previously returned the full balance for USD cash → total P/L = 0.
    const depUsd = flowsDepositsNetTotalUsdByAccount().get(usdId);
    const depClp = flowsDepositsNetTotalByAccount().get(usdId);
    expect(depUsd).toBeDefined();
    expect(depClp).toBeDefined();
    // Deposited USD = 1000 capital (the 10 USD interest is excluded).
    expect(depUsd!).toBeCloseTo(1000, 6);
    expect(usdCashBalanceUsdAt(usdId, "2026-12-31") - depUsd!).toBeCloseTo(10, 6);
    expect(usdCashBalanceClpAt(usdId, "2026-12-31") - depClp!).toBeGreaterThan(0);
  });

  it("USD cash now produces a monthly P/L series with the interest as gain", () => {
    if (!usdId) return;
    const perf = getAccountMonthlyPerformance(usdId, "clp");
    expect(perf).not.toBeNull();
    expect(perf!.monthly.length).toBeGreaterThan(0);
    const june = perf!.monthly.find((r) => monthKeyFromYmd(r.as_of_date) === "2026-06");
    expect(june).toBeDefined();
    // June P/L ≈ the 10 USD interest in CLP (~8k–12k depending on the sell rate), and small vs balance.
    expect(june!.nominal_pl ?? 0).toBeGreaterThan(7_000);
    expect(june!.nominal_pl ?? 0).toBeLessThan(13_000);
  });
});
