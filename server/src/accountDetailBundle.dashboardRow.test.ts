import { describe, expect, it } from "vitest";
import { buildAccountDetailBundle } from "./accountDetailBundle.js";
import { buildDashboardAccountRows } from "./dashboardAccounts.js";
import { db } from "./db.js";

describe("accountDetailBundle dashboard_account_row", () => {
  it("includes fresh dashboard row aligned with buildDashboardAccountRows for a stock (SPY)", async () => {
    const row = db.prepare(`SELECT id FROM accounts WHERE equity_ticker = 'SPY' LIMIT 1`).get() as { id: number };

    const bundle = await buildAccountDetailBundle(row.id, "clp", "monthly");
    expect(bundle?.dashboard_account_row).toBeTruthy();

    const dashRows = await buildDashboardAccountRows(false);
    const expected = dashRows.find((r) => r.account_id === row.id);
    if (!expected || !bundle?.dashboard_account_row) throw new Error("SPY has no dashboard row");

    expect(bundle.dashboard_account_row.current_value_clp).toBeCloseTo(
      expected.current_value_clp ?? 0,
      0
    );
    expect(bundle.dashboard_account_row.delta_month_clp).toBeCloseTo(
      expected.delta_month_clp ?? 0,
      0
    );
    expect(bundle.dashboard_account_row.delta_year_clp).toBeCloseTo(
      expected.delta_year_clp ?? 0,
      0
    );
    expect(bundle.dashboard_account_row.deposits_clp).toBe(expected.deposits_clp);
  });
});
