import { describe, expect, it } from "vitest";
import {
  GLOBAL_SYNC_RESUME_NETWORK_WAIT_MS,
  GLOBAL_SYNC_RETRY_DELAYS_MS,
  planAfterGlobalSync,
  planGlobalSyncTick,
  suspendedGapMs,
} from "./globalSyncSchedulerPolicy.js";

describe("suspendedGapMs", () => {
  it("takes the larger of lateness and clock divergence", () => {
    expect(suspendedGapMs({ lateByMs: 600_000, divergenceMs: 10 })).toBe(600_000);
    expect(suspendedGapMs({ lateByMs: 0, divergenceMs: 800_000 })).toBe(800_000);
  });
  it("reads early timers and negative drift as no suspend", () => {
    expect(suspendedGapMs({ lateByMs: -5_000, divergenceMs: -1 })).toBe(0);
  });
});

describe("planGlobalSyncTick", () => {
  const wakeGapMs = 5 * 60_000;
  it("waits for the network after a suspend of at least the wake gap", () => {
    expect(planGlobalSyncTick({ suspendedGapMs: wakeGapMs, wakeGapMs })).toEqual({
      resumed: true,
      waitBeforeSyncMs: GLOBAL_SYNC_RESUME_NETWORK_WAIT_MS,
    });
    expect(planGlobalSyncTick({ suspendedGapMs: 3 * 60 * 60_000, wakeGapMs }).resumed).toBe(true);
  });
  it("syncs at once on an ordinary tick", () => {
    expect(planGlobalSyncTick({ suspendedGapMs: 0, wakeGapMs })).toEqual({ resumed: false, waitBeforeSyncMs: 0 });
    expect(planGlobalSyncTick({ suspendedGapMs: wakeGapMs - 1, wakeGapMs }).waitBeforeSyncMs).toBe(0);
  });
});

describe("planAfterGlobalSync", () => {
  it("retries after 60 s, then 180 s, then gives up", () => {
    const first = planAfterGlobalSync({ resumedAfterSuspend: true, exitCode: 1, retriesUsed: 0 });
    expect(first).toEqual({ retryAfterMs: 60_000, retriesUsed: 1 });
    // The retry tick itself did not follow a suspend, but continues the sequence.
    const second = planAfterGlobalSync({ resumedAfterSuspend: false, exitCode: 1, retriesUsed: first.retriesUsed });
    expect(second).toEqual({ retryAfterMs: 180_000, retriesUsed: 2 });
    const third = planAfterGlobalSync({ resumedAfterSuspend: false, exitCode: 1, retriesUsed: second.retriesUsed });
    expect(third).toEqual({ retryAfterMs: null, retriesUsed: 2 });
    expect(GLOBAL_SYNC_RETRY_DELAYS_MS).toEqual([60_000, 180_000]);
  });

  it("does not refill the budget on another failure, even after a new wake", () => {
    expect(planAfterGlobalSync({ resumedAfterSuspend: true, exitCode: 1, retriesUsed: 2 })).toEqual({
      retryAfterMs: null,
      retriesUsed: 2,
    });
  });

  it("a success cancels the pending retry and refills the budget", () => {
    expect(planAfterGlobalSync({ resumedAfterSuspend: false, exitCode: 0, retriesUsed: 1 })).toEqual({
      retryAfterMs: null,
      retriesUsed: 0,
    });
    expect(planAfterGlobalSync({ resumedAfterSuspend: true, exitCode: 0, retriesUsed: 2 }).retriesUsed).toBe(0);
    const afterSuccess = planAfterGlobalSync({ resumedAfterSuspend: true, exitCode: 1, retriesUsed: 0 });
    expect(afterSuccess.retryAfterMs).toBe(60_000);
  });

  it("never retries a failure that did not follow a wake", () => {
    expect(planAfterGlobalSync({ resumedAfterSuspend: false, exitCode: 1, retriesUsed: 0 })).toEqual({
      retryAfterMs: null,
      retriesUsed: 0,
    });
  });

  it("counts a throw (exitCode null) as a failure", () => {
    expect(planAfterGlobalSync({ resumedAfterSuspend: true, exitCode: null, retriesUsed: 0 })).toEqual({
      retryAfterMs: 60_000,
      retriesUsed: 1,
    });
    expect(planAfterGlobalSync({ resumedAfterSuspend: false, exitCode: null, retriesUsed: 0 }).retryAfterMs).toBeNull();
  });
});
