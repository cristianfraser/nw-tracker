import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

/** The step under test records its calls instead of building the nav context. */
const navContextCalls: string[] = [];
vi.mock("./dashboardAccounts.js", () => ({
  buildDashboardNavContext: async (_includeUsd: boolean, unit: string) => {
    navContextCalls.push(unit);
    return {};
  },
}));

const { API_IN_FLIGHT_SETTLE_MS, apiInFlightMiddleware, resetApiRequestsInFlightForTest } = await import(
  "./apiRequestsInFlight.js"
);
const { warmVisitedPages } = await import("./visitedPagesWarm.js");

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  resetApiRequestsInFlightForTest();
  navContextCalls.length = 0;
});

describe("warmVisitedPages and requests in flight", () => {
  it("does not start a step while a request is in flight", async () => {
    const res = new EventEmitter();
    apiInFlightMiddleware()({ path: "/api/dashboard/nav-context" } as Request, res as unknown as Response, () => {});
    const warm = warmVisitedPages({ groups: [], accounts: [], navContextUnits: ["clp"] });
    await sleep(100);
    expect(navContextCalls).toEqual([]);
    res.emit("finish");
    const tFinish = performance.now();
    expect(await warm).toBe(0);
    expect(navContextCalls).toEqual(["clp"]);
    expect(performance.now() - tFinish).toBeGreaterThanOrEqual(API_IN_FLIGHT_SETTLE_MS - 5);
  });

  it("runs at once with nothing in flight", async () => {
    const t0 = performance.now();
    await warmVisitedPages({ groups: [], accounts: [], navContextUnits: ["usd"] });
    expect(navContextCalls).toEqual(["usd"]);
    expect(performance.now() - t0).toBeLessThan(API_IN_FLIGHT_SETTLE_MS);
  });
});
