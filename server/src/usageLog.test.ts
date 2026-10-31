import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getAggregationCached } from "./aggregationCache.js";
import { usageDb } from "./usageDb.js";
import { registerUsageRoutes } from "./routes/usage.js";
import {
  flushUsageLog,
  resetUsageLogBufferForTest,
  usageHistogramBucket,
  usageLogMiddleware,
  usageParamsKey,
} from "./usageLog.js";
import { usagePageRoute } from "./usagePagePath.js";
import { buildUsageEndpointTrend, buildUsageReport, histogramPercentile } from "./usageReport.js";

function clearTables(): void {
  usageDb().prepare(`DELETE FROM usage_endpoint_hourly`).run();
  usageDb().prepare(`DELETE FROM usage_page_views`).run();
}

describe("usage log keys", () => {
  it("keeps only the work-changing params, sorted", () => {
    expect(usageParamsKey({ unit: "usd", account_id: "12", days: "0", q: "lider" })).toBe("days=0&unit=usd");
    expect(usageParamsKey({})).toBe("");
  });

  it("groups page paths by their numeric segments", () => {
    expect(usagePageRoute("/account/123")).toBe("/account/:id");
    expect(usagePageRoute("/inversiones/brokerage/acciones")).toBe("/inversiones/brokerage/acciones");
  });

  it("puts a duration in the bucket of the first bound it does not exceed", () => {
    expect(usageHistogramBucket(0.4)).toBe(0);
    expect(usageHistogramBucket(2)).toBe(0);
    expect(usageHistogramBucket(3)).toBe(1);
    expect(usageHistogramBucket(120_000)).toBe(14);
  });

  it("interpolates a percentile inside its bucket and never above the max", () => {
    const hist = new Array<number>(15).fill(0);
    hist[5] = 10; // (50, 100]
    expect(histogramPercentile(hist, 0.5, 90)).toBe(75);
    expect(histogramPercentile(hist, 0.95, 90)).toBe(90);
    expect(histogramPercentile(new Array<number>(15).fill(0), 0.5, 0)).toBeNull();
  });
});

describe("usage log over HTTP", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(usageLogMiddleware());
    app.use(express.json());
    const router = express.Router();
    router.get("/:slug/thing", (req, res) => {
      res.json({ value: getAggregationCached(`usage-test|${req.params.slug}`, () => req.params.slug) });
    });
    app.use("/api/test-groups", router);
    app.get("/api/boom", (_req, res) => void res.status(500).json({ error: "boom" }));
    registerUsageRoutes(app);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
    clearTables();
  });

  beforeEach(() => {
    resetUsageLogBufferForTest();
    clearTables();
  });

  it("records route pattern, params, status and cache outcome; the report aggregates them", async () => {
    await fetch(`${base}/api/test-groups/a/thing?unit=usd&account_id=4`);
    await fetch(`${base}/api/test-groups/a/thing?unit=usd`);
    await fetch(`${base}/api/test-groups/b/thing?unit=usd`);
    await fetch(`${base}/api/boom`);
    await fetch(`${base}/api/nowhere`);
    const beacon = await fetch(`${base}/api/usage/page-view`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/account/7", initial: true, outcome: "settled", settle_ms: 840, fetched_queries: 3 }),
    });
    expect(beacon.status).toBe(204);
    const bad = await fetch(`${base}/api/usage/page-view`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/x", initial: false, outcome: "left", settle_ms: 3, fetched_queries: 0 }),
    });
    expect(bad.status).toBe(400);

    expect(flushUsageLog()).toEqual({ endpoints: 3, page_views: 1 });

    const report = buildUsageReport(7);
    const thing = report.endpoints.find((e) => e.route === "/api/test-groups/:slug/thing");
    expect(thing).toMatchObject({ method: "GET", params: "unit=usd", count: 3, server_errors: 0 });
    // a: miss then hit; b: miss → one warm request in three.
    expect(thing!.cache_warm_share).toBeCloseTo(1 / 3);
    expect(thing!.cache_cold_share).toBeCloseTo(2 / 3);
    expect(thing!.avg_bytes).toBeGreaterThan(0);
    expect(report.endpoints.find((e) => e.route === "/api/boom")?.server_errors).toBe(1);
    expect(report.endpoints.find((e) => e.route === "(unmatched)")?.client_errors).toBe(1);
    // The beacon itself is not timed.
    expect(report.endpoints.some((e) => e.route.startsWith("/api/usage"))).toBe(false);
    expect(report.pages).toEqual([
      expect.objectContaining({ route: "/account/:id", views: 1, settle_p50_ms: 840, avg_fetched_queries: 3 }),
    ]);

    const trend = buildUsageEndpointTrend({ method: "GET", route: "/api/test-groups/:slug/thing", params: "unit=usd" }, 7);
    expect(trend.points).toHaveLength(7);
    expect(trend.points.at(-1)?.count).toBe(3);
    expect(trend.points[0]?.count).toBe(0);
  });

  it("adds a second flush of the same hour onto the stored row", async () => {
    await fetch(`${base}/api/boom`);
    flushUsageLog();
    await fetch(`${base}/api/boom`);
    flushUsageLog();
    const row = usageDb().prepare(`SELECT count, server_errors FROM usage_endpoint_hourly WHERE route = '/api/boom'`).get();
    expect(row).toEqual({ count: 2, server_errors: 2 });
  });
});
