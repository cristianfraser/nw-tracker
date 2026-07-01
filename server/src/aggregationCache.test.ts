import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  cacheKeyAccountMonthlyPerf,
  cacheKeyGroupConsolidatedMonthly,
  clearAggregationCache,
  forwardMonthKeysForInvalidationTest,
  getAggregationCached,
  invalidateAggregationForAccountDate,
  invalidateLinkedCreditCardAggregationCache,
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
