import { describe, expect, it } from "vitest";
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

    expect(usdCashBalanceUsdAt(row.account_id, "2026-06-23")).toBe(0);

    const dashRows = await buildDashboardAccountRows(false);
    const dash = dashRows.find((r) => r.account_id === row.account_id);
    expect(dash?.current_value_clp).toBe(0);
    expect(dash?.deposits_clp).toBe(0);
    expect(dash?.delta_total_clp).toBe(0);

    const dashUsd = await buildDashboardAccountRows(true);
    const dashUsdRow = dashUsd.find((r) => r.account_id === row.account_id);
    expect(dashUsdRow?.current_value_usd).toBe(0);
    expect(dashUsdRow?.deposits_usd).toBe(0);
    expect(dashUsdRow?.delta_total_usd).toBe(0);
  });
});
