import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { afterEach, describe, expect, it } from "vitest";
import {
  apiInFlightMiddleware,
  apiRequestCountsAsInFlight,
  inFlightApiRequests,
  resetApiRequestsInFlightForTest,
  whenNoApiRequestsInFlight,
} from "./apiRequestsInFlight.js";

/** Runs the middleware on a fake request; the returned response emits `finish` / `close`. */
function fakeRequest(path: string): EventEmitter {
  const res = new EventEmitter();
  let nextCalled = false;
  apiInFlightMiddleware()({ path } as Request, res as unknown as Response, () => {
    nextCalled = true;
  });
  expect(nextCalled).toBe(true);
  return res;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Whether the waiter resolved within `withinMs`. */
async function settledWithin(p: Promise<void>, withinMs: number): Promise<boolean> {
  let done = false;
  void p.then(() => {
    done = true;
  });
  await sleep(withinMs);
  return done;
}

afterEach(() => resetApiRequestsInFlightForTest());

describe("api requests in flight", () => {
  it("counts /api requests until they finish, once even when finish and close both fire", () => {
    const a = fakeRequest("/api/dashboard/nav-context");
    const b = fakeRequest("/api/daily-series");
    expect(inFlightApiRequests()).toBe(2);
    a.emit("finish");
    a.emit("close");
    expect(inFlightApiRequests()).toBe(1);
    // An aborted request only closes.
    b.emit("close");
    b.emit("finish");
    expect(inFlightApiRequests()).toBe(0);
  });

  it("leaves out the health check, the beacon, machine traffic and non-API paths", () => {
    for (const path of [
      "/api/health",
      "/api/usage/page-view",
      "/api/ingest/card.statement",
      "/api/jobs/7/heartbeat",
      "/assets/x.js",
      "/",
    ]) {
      expect(apiRequestCountsAsInFlight(path)).toBe(false);
      fakeRequest(path);
    }
    expect(inFlightApiRequests()).toBe(0);
    expect(apiRequestCountsAsInFlight("/api/live-quotes/stamp")).toBe(true);
    expect(apiRequestCountsAsInFlight("/api/usage/report")).toBe(true);
  });

  it("resolves at once when nothing was requested", async () => {
    expect(await settledWithin(whenNoApiRequestsInFlight({ settleMs: 1_000 }), 20)).toBe(true);
  });

  it("waits while a request is in flight, then for the settle window", async () => {
    const res = fakeRequest("/api/dashboard/page-bundle");
    const waiting = whenNoApiRequestsInFlight({ settleMs: 80 });
    expect(await settledWithin(waiting, 60)).toBe(false);
    res.emit("finish");
    const tFinish = performance.now();
    await waiting;
    const afterFinish = performance.now() - tFinish;
    expect(afterFinish).toBeGreaterThanOrEqual(75);
    expect(afterFinish).toBeLessThan(1_000);
  });

  it("restarts the settle window when another request of the burst arrives", async () => {
    const first = fakeRequest("/api/live-quotes/stamp");
    const waiting = whenNoApiRequestsInFlight({ settleMs: 100 });
    first.emit("finish");
    await sleep(50);
    const second = fakeRequest("/api/dashboard/page-bundle");
    expect(await settledWithin(waiting, 120)).toBe(false);
    second.emit("finish");
    expect(await settledWithin(waiting, 200)).toBe(true);
  });

  it("stops counting a request in flight past the stale cap", async () => {
    fakeRequest("/api/accounts/7/imports/cc-statement"); // never answers
    expect(inFlightApiRequests(10_000)).toBe(1);
    const t0 = performance.now();
    await whenNoApiRequestsInFlight({ settleMs: 10, staleMs: 80 });
    const waited = performance.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(70);
    expect(waited).toBeLessThan(1_000);
    expect(inFlightApiRequests(80)).toBe(0);
  });

  it("never waits longer than the max wait", async () => {
    fakeRequest("/api/dashboard/page-bundle");
    const t0 = performance.now();
    await whenNoApiRequestsInFlight({ settleMs: 10, staleMs: 60_000, maxWaitMs: 60 });
    const waited = performance.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(55);
    expect(waited).toBeLessThan(1_000);
  });
});
