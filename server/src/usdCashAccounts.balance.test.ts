import { describe, expect, it } from "vitest";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { usdCashBalanceUsdAt } from "./usdCashAccounts.js";
import { buildDashboardAccountRows } from "./dashboardAccounts.js";

describe("USD cash account 90 balance", () => {
  it("nets to zero after CCJ buy links from USD cash and migration mirror legs are ignored", async () => {
    const row = db
      .prepare(
        `SELECT a.id AS account_id, g.slug AS bucket_slug, a.notes, a.name
         FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE a.notes LIKE '%kind=usd%'
         LIMIT 1`
      )
      .get() as { account_id: number } | undefined;
    if (!row) return;

    const mov = db
      .prepare(`SELECT from_account_id, account_id FROM movements WHERE id = 10800`)
      .get() as { from_account_id: number | null; account_id: number | null } | undefined;
    expect(mov?.from_account_id).toBe(row.account_id);
    expect(mov?.account_id).toBeNull();

    // The regressions this guards: same-day conversion+buy pairs must NET (CCJ buy links
    // funded from USD cash, and the migration-mirror legs, are each counted once, not
    // twice). Absolute zero-at-a-date pins rotted as new real rows (e.g. a backdated
    // dividend) landed on the account.
    const dayNet = (d: string, prev: string) =>
      usdCashBalanceUsdAt(row.account_id, d) - usdCashBalanceUsdAt(row.account_id, prev);
    // 2026-05-28: migration-era compra +3353.07 and mirrored stock_buy −3353.07.
    expect(dayNet("2026-05-28", "2026-05-27")).toBeCloseTo(0, 6);
    // 2026-06-16: stock_sell +3072.48 into cash and stock_buy −3072.48 out (mov 10800).
    expect(dayNet("2026-06-16", "2026-06-15")).toBeCloseTo(0, 6);

    // Dashboard rows agree with the balance function and keep the value/deposits/delta
    // identity in both units.
    const dashRows = await buildDashboardAccountRows(false);
    const dash = dashRows.find((r) => r.account_id === row.account_id);
    expect(dash).toBeDefined();
    if (
      dash?.current_value_clp != null &&
      dash.deposits_clp != null &&
      dash.delta_total_clp != null
    ) {
      expect(dash.delta_total_clp).toBeCloseTo(dash.current_value_clp - dash.deposits_clp, 0);
    }

    const dashUsd = await buildDashboardAccountRows(true);
    const dashUsdRow = dashUsd.find((r) => r.account_id === row.account_id);
    expect(dashUsdRow).toBeDefined();
    const today = chileCalendarTodayYmd();
    if (dashUsdRow?.current_value_usd != null) {
      expect(dashUsdRow.current_value_usd).toBeCloseTo(
        usdCashBalanceUsdAt(row.account_id, today),
        2
      );
    }
    if (
      dashUsdRow?.current_value_usd != null &&
      dashUsdRow.deposits_usd != null &&
      dashUsdRow.delta_total_usd != null
    ) {
      expect(dashUsdRow.delta_total_usd).toBeCloseTo(
        dashUsdRow.current_value_usd - dashUsdRow.deposits_usd,
        2
      );
    }
  });
});
