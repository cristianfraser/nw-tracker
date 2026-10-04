import { describe, expect, it } from "vitest";
import { buildAccountDetailBundle } from "./accountDetailBundle.js";
import { computePeriodReturns, PERIOD_RETURN_ORDER } from "./periodReturns.js";
import { isInvestmentPerformanceAccount } from "./portfolioGroupTree.js";
import { getAccountMonthlyPerformance } from "./accountPerformance.js";
import { db } from "./db.js";
import { resolveAccountDailySeries } from "./groupDailySeries.js";
import { withDailyChainedReturns } from "./periodReturnsDaily.js";

/** First investment account (brokerage/retirement) that has monthly perf rows. */
function findInvestmentAccountId(): number | null {
  const rows = db.prepare(`SELECT id FROM accounts ORDER BY id`).all() as { id: number }[];
  for (const { id } of rows) {
    if (!isInvestmentPerformanceAccount(id)) continue;
    const perf = getAccountMonthlyPerformance(id, "clp");
    if (perf && perf.monthly.length > 0) return id;
  }
  return null;
}

describe("accountDetailBundle period_returns", () => {
  it("attaches period returns wired from the same monthly rows for an investment account", async () => {
    const accountId = findInvestmentAccountId();
    if (accountId == null) return; // synthetic DB may lack a populated investment account

    const bundle = await buildAccountDetailBundle(accountId, "clp", "monthly");
    expect(bundle?.period_returns).not.toBeNull();
    // d1/w1 lead, then the monthly windows.
    expect(bundle!.period_returns!.periods.map((c) => c.period)).toEqual([
      "d1",
      "w1",
      ...PERIOD_RETURN_ORDER,
    ]);

    // The month windows are the monthly builder's windows and pesos, their % chained from the
    // account's own daily returns.
    const acc = db
      .prepare(
        `SELECT a.id AS account_id, a.name, g.slug AS bucket_slug, a.import_key
         FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id WHERE a.id = ?`
      )
      .get(accountId) as { account_id: number; name: string; bucket_slug: string; import_key: string | null };
    const expected = withDailyChainedReturns(
      computePeriodReturns(bundle!.monthly_performance!.monthly, "clp"),
      resolveAccountDailySeries(acc, "clp", 0).points
    )!;
    expect(bundle!.period_returns!.periods.slice(2)).toEqual(expected.periods);
  });

  it("returns null period_returns for a non-investment account", async () => {
    const rows = db.prepare(`SELECT id FROM accounts ORDER BY id`).all() as { id: number }[];
    const nonInvestmentId = rows.map((r) => r.id).find((id) => !isInvestmentPerformanceAccount(id));
    if (nonInvestmentId == null) return;

    const bundle = await buildAccountDetailBundle(nonInvestmentId, "clp", "monthly");
    expect(bundle?.period_returns ?? null).toBeNull();
  });
});
