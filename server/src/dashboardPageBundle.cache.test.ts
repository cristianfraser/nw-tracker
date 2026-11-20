import { describe, expect, it, vi } from "vitest";
import { clearAggregationCache, invalidateMarketDataAggregations } from "./cacheRegistry.js";
import { buildDashboardPageBundle } from "./dashboardPageBundle.js";

/**
 * This file is about the bundle's response cache (identity per unit, dropped by an invalidation,
 * one in-flight build), not its contents: the pieces the bundle assembles are stubbed with a fresh
 * object per call, so each cold build is a real build through `getAggregationCached` without
 * computing the Vitest person's whole portfolio four times. The real pieces are exercised by
 * `requestPathCaches.test.ts` and `liveTickIncrementalRebuild.test.ts`.
 */
vi.mock("./dashboardPagePayload.js", () => ({
  buildDashboardPagePayload: vi.fn(async () => ({ inversiones_deposits_chart: { monthly: [] } })),
}));
vi.mock("./valuationTimeseries.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./valuationTimeseries.js")>()),
  getDashboardValuationTimeseries: vi.fn(() => ({})),
}));
vi.mock("./netWorthAllTimeHigh.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./netWorthAllTimeHigh.js")>()),
  attachNetWorthAth: vi.fn((payload: unknown) => payload),
}));
vi.mock("./inversionesPerfSeries.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./inversionesPerfSeries.js")>()),
  buildInversionesPerfMonthly: vi.fn(() => []),
}));
vi.mock("./upcomingPayments.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./upcomingPayments.js")>()),
  buildUpcomingPayments: vi.fn(() => []),
}));
vi.mock("./fxCoverage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./fxCoverage.js")>()),
  buildFxCoverageWithConversionWarnings: vi.fn(() => ({})),
}));

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
