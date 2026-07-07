import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  cacheKeyAccountMonthlyPerf,
  cacheKeyCcBillingDetail,
  cacheKeyDashboardPageBundle,
  cacheKeyGroupClosingByDate,
  cacheKeyGroupConsolidatedMonthly,
  clearAggregationCache,
  forwardMonthKeysForInvalidationTest,
  getAggregationCached,
  invalidateAggregationForAccountDate,
  invalidateCcBillingDetail,
  invalidateLinkedCreditCardAggregationCache,
  invalidateMarketDataAggregations,
  setAggregationInvalidationListener,
} from "./aggregationCache.js";

describe("aggregationCache", () => {
  beforeEach(() => clearAggregationCache());

  it("caches build results by key", () => {
    let n = 0;
    const v1 = getAggregationCached("test|a", () => {
      n += 1;
      return 42;
    });
    const v2 = getAggregationCached("test|a", () => {
      n += 1;
      return 99;
    });
    expect(v1).toBe(42);
    expect(v2).toBe(42);
    expect(n).toBe(1);
  });

  it("invalidates account perf and unrelated keys remain", () => {
    getAggregationCached(cacheKeyAccountMonthlyPerf(1, "clp"), () => ({ monthly: [] }));
    getAggregationCached(cacheKeyAccountMonthlyPerf(2, "clp"), () => ({ monthly: [] }));
    getAggregationCached(cacheKeyGroupConsolidatedMonthly("brokerage", "clp"), () => []);

    invalidateAggregationForAccountDate(1, "2026-03-15");

    let rebuilt1 = 0;
    getAggregationCached(cacheKeyAccountMonthlyPerf(1, "clp"), () => {
      rebuilt1 += 1;
      return { monthly: [] };
    });
    expect(rebuilt1).toBe(1);

    let rebuilt2 = 0;
    getAggregationCached(cacheKeyAccountMonthlyPerf(2, "clp"), () => {
      rebuilt2 += 1;
      return { monthly: [] };
    });
    expect(rebuilt2).toBe(0);
  });

  it("forward month invalidation includes later months in the same year", () => {
    const keys = forwardMonthKeysForInvalidationTest("2026-03-10");
    expect(keys[0]).toBe("2026-03");
    expect(keys).toContain("2026-04");
  });

  it("invalidateLinkedCreditCardAggregationCache clears cash_eqs consolidated keys", () => {
    getAggregationCached(cacheKeyGroupConsolidatedMonthly("cash_eqs", "clp"), () => ({ rows: [1] }));
    getAggregationCached(cacheKeyGroupConsolidatedMonthly("brokerage", "clp"), () => []);

    invalidateLinkedCreditCardAggregationCache();

    let cashEqsRebuilds = 0;
    getAggregationCached(cacheKeyGroupConsolidatedMonthly("cash_eqs", "clp"), () => {
      cashEqsRebuilds += 1;
      return { rows: [2] };
    });
    expect(cashEqsRebuilds).toBe(1);

    let brokerageRebuilds = 0;
    getAggregationCached(cacheKeyGroupConsolidatedMonthly("brokerage", "clp"), () => {
      brokerageRebuilds += 1;
      return [];
    });
    expect(brokerageRebuilds).toBe(0);
  });

  it("invalidateMarketDataAggregations drops live-mark namespaces, keeps CC billing detail, notifies listener", () => {
    getAggregationCached(cacheKeyAccountMonthlyPerf(1, "clp"), () => ({ monthly: [] }));
    getAggregationCached(cacheKeyGroupConsolidatedMonthly("retirement", "clp"), () => []);
    getAggregationCached(cacheKeyGroupClosingByDate("retirement", "clp"), () => new Map());
    getAggregationCached(cacheKeyCcBillingDetail(9), () => ({ months: [] }));

    let notified = 0;
    setAggregationInvalidationListener(() => {
      notified += 1;
    });
    try {
      invalidateMarketDataAggregations();
    } finally {
      setAggregationInvalidationListener(null);
    }
    expect(notified).toBe(1);

    let perfRebuilds = 0;
    getAggregationCached(cacheKeyAccountMonthlyPerf(1, "clp"), () => {
      perfRebuilds += 1;
      return { monthly: [] };
    });
    let consolidatedRebuilds = 0;
    getAggregationCached(cacheKeyGroupConsolidatedMonthly("retirement", "clp"), () => {
      consolidatedRebuilds += 1;
      return [];
    });
    let closingRebuilds = 0;
    getAggregationCached(cacheKeyGroupClosingByDate("retirement", "clp"), () => {
      closingRebuilds += 1;
      return new Map();
    });
    let ccRebuilds = 0;
    getAggregationCached(cacheKeyCcBillingDetail(9), () => {
      ccRebuilds += 1;
      return { months: [] };
    });

    expect(perfRebuilds).toBe(1);
    expect(consolidatedRebuilds).toBe(1);
    expect(closingRebuilds).toBe(1);
    expect(ccRebuilds).toBe(0);
  });

  it("every explicit invalidation drops the cached page bundle", () => {
    const invalidations: Array<[string, () => void]> = [
      ["invalidateAggregationForAccountDate", () => invalidateAggregationForAccountDate(1, "2026-03-15")],
      ["invalidateMarketDataAggregations", () => invalidateMarketDataAggregations()],
      ["invalidateCcBillingDetail(one account)", () => invalidateCcBillingDetail(9)],
      ["invalidateLinkedCreditCardAggregationCache", () => invalidateLinkedCreditCardAggregationCache()],
    ];
    for (const [name, invalidate] of invalidations) {
      for (const unit of ["clp", "usd"] as const) {
        getAggregationCached(cacheKeyDashboardPageBundle(unit), () => ({ unit }));
      }
      invalidate();
      for (const unit of ["clp", "usd"] as const) {
        let rebuilds = 0;
        getAggregationCached(cacheKeyDashboardPageBundle(unit), () => {
          rebuilds += 1;
          return { unit };
        });
        expect(rebuilds, `${name} should drop dashboard.page_bundle|${unit}`).toBe(1);
      }
    }
  });

  describe("Chile calendar day rollover", () => {
    afterEach(() => vi.useRealTimers());

    it("drops all cached entries when the day rolls over", () => {
      vi.useFakeTimers();
      // Late on June 30 in Chile (UTC-4): a long-running server warms the cache before midnight.
      vi.setSystemTime(new Date("2026-06-30T22:00:00-04:00"));
      let builds = 0;
      const build = () => {
        builds += 1;
        return builds;
      };

      expect(getAggregationCached("test|rollover", build)).toBe(1);
      expect(getAggregationCached("test|rollover", build)).toBe(1); // cached, no rebuild

      // Clock advances past midnight into July — cache must rebuild with the new "today".
      vi.setSystemTime(new Date("2026-07-01T01:00:00-04:00"));
      expect(getAggregationCached("test|rollover", build)).toBe(2);
      expect(builds).toBe(2);

      // Same day again keeps the freshly built value cached.
      expect(getAggregationCached("test|rollover", build)).toBe(2);
      expect(builds).toBe(2);
    });
  });
});
