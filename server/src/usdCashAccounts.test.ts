import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { createPanelAccount } from "./createPanelAccount.js";
import { usdCashBalanceClpAt, usdCashBalanceUsdAt } from "./usdCashAccounts.js";

let created: { account_id: number; asset_group_id: number; created_leaf_bucket: boolean } | null = null;

afterEach(() => {
  if (!created) return;
  db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(created.account_id);
  db.prepare(`DELETE FROM accounts WHERE id = ?`).run(created.account_id);
  if (created.created_leaf_bucket) {
    db.prepare(`DELETE FROM asset_groups WHERE id = ?`).run(created.asset_group_id);
  }
  created = null;
});

describe("usdCashBalanceClpAt", () => {
  it("returns 0 without an fx_daily lookup for dates before the account (or fx history) exists", () => {
    created = createPanelAccount({
      account: {
        account_type: "usd_cash",
        name: "vitest-usd-cash-zero-fx",
        bucket_slug: "brokerage_cash",
        exclude_from_group_totals: false,
      },
    });
    // Consolidation baselines mark every account at every month-end, including dates
    // predating both the account and fx_daily history (starts at portfolioStartYmd).
    // A zero USD balance must convert to 0 CLP without demanding a rate.
    const earlierThanAnyFxRow = "1990-01-31";
    expect(usdCashBalanceUsdAt(created.account_id, earlierThanAnyFxRow)).toBe(0);
    expect(usdCashBalanceClpAt(created.account_id, earlierThanAnyFxRow)).toBe(0);
  });
});
