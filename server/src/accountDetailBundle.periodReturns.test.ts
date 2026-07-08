import { describe, expect, it } from "vitest";
import { buildAccountDetailBundle } from "./accountDetailBundle.js";
import { computePeriodReturns, PERIOD_RETURN_ORDER } from "./periodReturns.js";
import { isInvestmentPerformanceAccount } from "./portfolioGroupTree.js";
import { getAccountMonthlyPerformance } from "./accountPerformance.js";
import { db } from "./db.js";

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

    const bundle = await buildAccountDetailBundle(accountId, "clp", "monthly", {});
    expect(bundle?.period_returns).not.toBeNull();
    // d1/w1 lead, then the monthly windows.
    expect(bundle!.period_returns!.periods.map((c) => c.period)).toEqual([
      "d1",
      "w1",
      ...PERIOD_RETURN_ORDER,
    ]);

    // The monthly tail is exactly the pure chained builder over the same monthly rows.
    const expected = computePeriodReturns(bundle!.monthly_performance!.monthly, "clp")!;
    expect(bundle!.period_returns!.periods.slice(2)).toEqual(expected.periods);
    expect(bundle!.period_returns!.mtd_is_live).toBe(expected.mtd_is_live);
  });

  it("returns null period_returns for a non-investment account", async () => {
    const rows = db.prepare(`SELECT id FROM accounts ORDER BY id`).all() as { id: number }[];
    const nonInvestmentId = rows.map((r) => r.id).find((id) => !isInvestmentPerformanceAccount(id));
    if (nonInvestmentId == null) return;

    const bundle = await buildAccountDetailBundle(nonInvestmentId, "clp", "monthly", {});
    expect(bundle?.period_returns ?? null).toBeNull();
  });
});
