import { afterAll, describe, expect, it } from "vitest";
import { aggregationCacheKeysForTest, clearAggregationCache } from "./cacheRegistry.js";
import { usageDb } from "./usageDb.js";
import { planVisitedWarm, visitedWarmPlanFromUsageLog, warmVisitedPages } from "./visitedPagesWarm.js";

afterAll(() => clearAggregationCache());

const routes = new Map([
  ["/", "dashboard"],
  ["/liabilities", "liabilities"],
  ["/inversiones/brokerage", "brokerage"],
  ["/cash_eqs", "cash_eqs"],
]);

describe("planVisitedWarm", () => {
  it("ranks groups by page views, keeps each one's most requested daily variants and units", () => {
    const plan = planVisitedWarm(
      [
        { path: "/liabilities", n: 9 },
        { path: "/", n: 20 },
        { path: "/inversiones/brokerage", n: 3 },
        { path: "/account/32", n: 4 },
        { path: "/account/7", n: 1 },
        { path: "/flows", n: 50 },
      ],
      [
        { route: "/api/daily-series", params: "days=1096&portfolio_group=liabilities", n: 12 },
        { route: "/api/daily-series", params: "days=0&portfolio_group=liabilities", n: 2 },
        { route: "/api/daily-series", params: "days=90&include_usd=1&portfolio_group=liabilities", n: 5 },
        { route: "/api/dashboard/valuation-timeseries", params: "portfolio_group=brokerage", n: 3 },
        { route: "/api/dashboard/valuation-timeseries", params: "include_usd=1&portfolio_group=brokerage", n: 7 },
        { route: "/api/dashboard/valuation-timeseries", params: "portfolio_group=cash_eqs", n: 2 },
        { route: "/api/accounts/:id/detail-bundle", params: "granularity=daily", n: 1 },
      ],
      routes
    );
    // The home page is the bundle's (warmed first anyway); /flows is no group page.
    expect(plan.groups.map((g) => g.slug)).toEqual(["liabilities", "brokerage", "cash_eqs"]);
    expect(plan.groups[0]!.daily).toEqual([
      { days: 1096, unit: "clp", perfLevels: false },
      { days: 90, unit: "usd", perfLevels: false },
    ]);
    expect(plan.groups[0]!.units).toEqual(["clp"]);
    expect(plan.groups[1]!.units).toEqual(["usd", "clp"]);
    expect(plan.accounts).toEqual([
      { id: 32, unit: "clp", granularity: "daily" },
      { id: 7, unit: "clp", granularity: "daily" },
    ]);
    expect(plan.navContexts).toEqual([
      { root: "liabilities", unit: "clp" },
      { root: "brokerage", unit: "usd" },
      { root: "brokerage", unit: "clp" },
      { root: "cash_eqs", unit: "clp" },
    ]);
  });

  it("is empty without a visit", () => {
    expect(planVisitedWarm([], [], routes)).toEqual({ groups: [], accounts: [], navContexts: [] });
  });
});

describe("warmVisitedPages", () => {
  it("leaves the planned payloads cached", async () => {
    clearAggregationCache();
    const pages = await warmVisitedPages({
      groups: [{ slug: "liabilities", units: ["clp"], daily: [{ days: 90, unit: "clp", perfLevels: false }] }],
      accounts: [],
      navContexts: [{ root: "liabilities", unit: "clp" }],
    });
    expect(pages).toBe(1);
    const keys = aggregationCacheKeysForTest();
    expect(keys).toContain("dashboard.page_bundle|group|valuation_ts|liabilities|clp");
    expect(keys).toContain("dashboard.page_bundle|group|consolidated_tables|liabilities|clp");
    expect(keys).toContain("dashboard.page_bundle|group|monthly_pl_series|liabilities|clp");
    expect(keys).toContain("daily.series|response|group|liabilities|clp|90|plain");
    expect(keys).toContain("dashboard.page_bundle|sidebar_nav");
  }, 120_000);
});

describe("visitedWarmPlanFromUsageLog", () => {
  it("plans only the group pages the nav strip serves", () => {
    const usage = usageDb();
    const now = new Date();
    const ins = usage.prepare(
      `INSERT INTO usage_page_views (viewed_at, route, path, visitor, initial, outcome, settle_ms, fetched_queries)
       VALUES (?, ?, ?, 'vitest-visited-warm', 1, 'settled', 100, 1)`
    );
    const ids: number[] = [];
    for (const path of ["/flows/expenses", "/flows/expenses", "/inversiones/brokerage"]) {
      ids.push(Number(ins.run(now.toISOString(), path, path).lastInsertRowid));
    }
    try {
      const plan = visitedWarmPlanFromUsageLog(now);
      expect(plan.groups.map((g) => g.slug)).toContain("brokerage");
      expect(plan.groups.map((g) => g.slug)).not.toContain("flows_expenses");
      expect(plan.navContexts.map((c) => c.root)).toContain("brokerage");
      expect(plan.navContexts.map((c) => c.root)).not.toContain("flows_expenses");
    } finally {
      usage.prepare(`DELETE FROM usage_page_views WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
    }
  });
});
