import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { clpCashBalanceClpAt, isClpCashAccount } from "./clpCashAccounts.js";
import { buildDashboardAccountRows } from "./dashboardAccounts.js";

describe("CLP cash account (ledger / flows-based)", () => {
  it("derives its balance from movement/transfer legs, not valuation snapshots", async () => {
    const row = db
      .prepare(
        `SELECT a.id AS account_id, g.slug AS bucket_slug
         FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE a.notes LIKE '%kind=clp%'
         LIMIT 1`
      )
      .get() as { account_id: number; bucket_slug: string } | undefined;
    if (!row) return;

    expect(isClpCashAccount(row.account_id)).toBe(true);

    // No valuation snapshots for a flows-based cash account.
    const valCount = db
      .prepare(`SELECT COUNT(*) AS n FROM valuations WHERE account_id = ?`)
      .get(row.account_id) as { n: number };
    expect(valCount.n).toBe(0);

    const today = new Date().toISOString().slice(0, 10);
    const ledger = clpCashBalanceClpAt(row.account_id, today);

    const dashRows = await buildDashboardAccountRows(false);
    const dash = dashRows.find((r) => r.account_id === row.account_id);
    // Dashboard balance matches the ledger sum (not the missing valuation → 0).
    expect(dash?.current_value_clp).toBe(ledger);
  });
});
