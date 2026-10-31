/**
 * Chart-inactive of a peso ledger (checking, a broker's peso balance, a portfolio caja) reads
 * its balance today instead of building its monthly series: same flag as the month-close rule
 * it replaced, for every such account plus fixtures.
 */
import { describe, expect, it } from "vitest";
import { accountBucketKindSlug, bucketSlugForAccountId } from "./accountBucket.js";
import { accountChartInactive, chartInactiveFromMonthlyClosingAsc } from "./accountChartInactive.js";
import { CHART_TRAILING_ZERO_MONTHS_KEPT } from "./accountValuationTailInactive.js";
import { loadBookValuationsAsc } from "./bookValuations.js";
import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { monthlyPerfForAccountId } from "./groupMonthlyPerfConsolidation.js";
import { isMovementBalanceCashCategory } from "./movementBalanceCashAccounts.js";
import { isClpCashKindSlug } from "./clpCashAccounts.js";
import { allAccountIds, holdingFixtures } from "./test/holdingParityFixtures.js";

const fixtures = holdingFixtures();

/** The rule as it was: the account's month closes, else stored rows, else today's mark. */
function priorMonthCloseChartInactive(accountId: number): boolean {
  const perf = monthlyPerfForAccountId(accountId, "clp");
  let closing: number[];
  if (perf?.monthly.length) closing = [...perf.monthly].reverse().map((r) => r.closing_value);
  else {
    const stored = loadBookValuationsAsc(accountId).map((r) => r.value_clp);
    if (stored.length) closing = stored;
    else {
      const mark = accountMarkClpAtYmd(accountId, chileCalendarTodayYmd());
      closing = mark ? [mark.value_clp] : [];
    }
  }
  if (!closing.length) return false;
  return chartInactiveFromMonthlyClosingAsc(closing, CHART_TRAILING_ZERO_MONTHS_KEPT);
}

describe("chart-inactive of a peso ledger reads its balance", () => {
  it("matches the month-close rule for every checking and peso cash account", () => {
    const cajaLeaf = fixtures.pesoCashLeafSlug();
    const held = fixtures.account("held caja", cajaLeaf);
    fixtures.singleLeg(held, "2024-03-01", 50_000, null, null);
    const emptied = fixtures.account("emptied caja", cajaLeaf);
    fixtures.singleLeg(emptied, "2024-03-01", 50_000, null, null);
    fixtures.singleLeg(emptied, "2025-03-01", -50_000, null, null);
    fixtures.account("caja without movements", cajaLeaf);

    let compared = 0;
    for (const id of allAccountIds()) {
      const slug = bucketSlugForAccountId(id);
      if (slug == null) continue;
      if (!isMovementBalanceCashCategory(slug) && !isClpCashKindSlug(accountBucketKindSlug(slug))) continue;
      expect(accountChartInactive(id), `account ${id} (${slug})`).toBe(priorMonthCloseChartInactive(id));
      compared++;
    }
    expect(compared).toBeGreaterThanOrEqual(5);
    expect(accountChartInactive(held)).toBe(false);
    expect(accountChartInactive(emptied)).toBe(true);
  });
});
