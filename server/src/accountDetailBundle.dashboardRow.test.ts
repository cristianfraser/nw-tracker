import { describe, expect, it } from "vitest";
import { buildAccountDetailBundle } from "./accountDetailBundle.js";
import { buildDashboardAccountRows } from "./dashboardAccounts.js";
import { db } from "./db.js";

describe("accountDetailBundle dashboard_account_row", () => {
  it("includes fresh dashboard row aligned with buildDashboardAccountRows for OILK", async () => {
    const row = db
      .prepare(`SELECT id FROM accounts WHERE equity_ticker = 'OILK' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!row) return;

    const bundle = await buildAccountDetailBundle(row.id, "clp", "monthly", {});
    if (!bundle?.dashboard_account_row) return;

    const dashRows = await buildDashboardAccountRows(false);
    const expected = dashRows.find((r) => r.account_id === row.id);
    if (!expected) return;

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
