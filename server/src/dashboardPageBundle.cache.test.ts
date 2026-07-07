import { describe, expect, it } from "vitest";
import {
  clearAggregationCache,
  invalidateMarketDataAggregations,
} from "./aggregationCache.js";
import { buildDashboardPageBundle } from "./dashboardPageBundle.js";

describe("dashboard page-bundle response cache", () => {
  it("serves the cached bundle object until an invalidation drops it", async () => {
    clearAggregationCache();

    const first = await buildDashboardPageBundle("clp");
    const second = await buildDashboardPageBundle("clp");
    expect(second).toBe(first);

    // Units cache independently.
    const usd = await buildDashboardPageBundle("usd");
    expect(usd).not.toBe(first);
    expect(await buildDashboardPageBundle("usd")).toBe(usd);

    invalidateMarketDataAggregations();
    const rebuilt = await buildDashboardPageBundle("clp");
    expect(rebuilt).not.toBe(first);
  });

  it("concurrent cold requests share one in-flight build", async () => {
    clearAggregationCache();
    const [a, b] = await Promise.all([
      buildDashboardPageBundle("clp"),
      buildDashboardPageBundle("clp"),
    ]);
    expect(b).toBe(a);
  });
});
