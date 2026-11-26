import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "./db.js";
import {
  NEXT_ERROR_RETRY_MS,
  ScheduledJob,
  nextErrorNotificationTitle,
  stopAllScheduledJobs,
  nextAlignedMs,
  planRetry,
  planTick,
  suspendedGapMs,
  type KernelRetryPolicy,
  type KernelRunResult,
} from "./schedulerKernel.js";

/** The global sync's retry policy: only while recovering from a wake, a throw counts. */
const AFTER_WAKE: KernelRetryPolicy = { delaysMs: [60_000, 180_000], when: "after_wake", retryThrown: true };
/** The live quotes' policy: every wholesale failure, a throw is a bug. */
const ALWAYS: KernelRetryPolicy = { delaysMs: [15_000, 45_000], when: "always", retryThrown: false };

describe("suspendedGapMs", () => {
  it("takes the larger of lateness and clock divergence", () => {
    expect(suspendedGapMs({ lateByMs: 600_000, divergenceMs: 10 })).toBe(600_000);
    expect(suspendedGapMs({ lateByMs: 0, divergenceMs: 800_000 })).toBe(800_000);
  });
  it("reads early timers and negative drift as no suspend", () => {
    expect(suspendedGapMs({ lateByMs: -5_000, divergenceMs: -1 })).toBe(0);
  });
});

describe("planTick", () => {
  const wake = { wakeGapMs: 5 * 60_000, networkGraceMs: 10_000 };
  it("waits for the network after a suspend of at least the wake gap", () => {
    expect(planTick({ suspendedGapMs: wake.wakeGapMs, wake })).toEqual({ resumed: true, waitMs: 10_000 });
    expect(planTick({ suspendedGapMs: 3 * 60 * 60_000, wake }).resumed).toBe(true);
  });
  it("runs at once on an ordinary tick, or for a job with no wake policy", () => {
    expect(planTick({ suspendedGapMs: 0, wake })).toEqual({ resumed: false, waitMs: 0 });
    expect(planTick({ suspendedGapMs: wake.wakeGapMs - 1, wake }).waitMs).toBe(0);
    expect(planTick({ suspendedGapMs: 3 * 60 * 60_000, wake: undefined })).toEqual({ resumed: false, waitMs: 0 });
  });
});

describe("planRetry", () => {
  const plan = (result: KernelRunResult, resumed: boolean, retriesUsed: number, policy: KernelRetryPolicy) =>
    planRetry({ result, resumed, retriesUsed }, policy);

  it("after a wake: retries after each delay in turn, the retry runs chaining, then gives up", () => {
    const first = plan("failed", true, 0, AFTER_WAKE);
    expect(first).toEqual({ retryAfterMs: 60_000, retriesUsed: 1 });
    const second = plan("failed", false, first.retriesUsed, AFTER_WAKE);
    expect(second).toEqual({ retryAfterMs: 180_000, retriesUsed: 2 });
    expect(plan("failed", false, second.retriesUsed, AFTER_WAKE)).toEqual({ retryAfterMs: null, retriesUsed: 2 });
  });

  it("does not refill the budget on another failure, even after a new wake", () => {
    expect(plan("failed", true, 2, AFTER_WAKE)).toEqual({ retryAfterMs: null, retriesUsed: 2 });
  });

  it("a success cancels the retries and refills the budget", () => {
    expect(plan("ok", false, 1, AFTER_WAKE)).toEqual({ retryAfterMs: null, retriesUsed: 0 });
    expect(plan("ok", true, 2, ALWAYS)).toEqual({ retryAfterMs: null, retriesUsed: 0 });
  });

  it("after_wake: never retries a failure that did not follow a wake", () => {
    expect(plan("failed", false, 0, AFTER_WAKE)).toEqual({ retryAfterMs: null, retriesUsed: 0 });
  });

  it("counts a throw as a failure only when the policy says so", () => {
    expect(plan("threw", true, 0, AFTER_WAKE)).toEqual({ retryAfterMs: 60_000, retriesUsed: 1 });
    expect(plan("threw", false, 0, AFTER_WAKE).retryAfterMs).toBeNull();
    expect(plan("threw", false, 0, ALWAYS)).toEqual({ retryAfterMs: null, retriesUsed: 0 });
  });

  it("always: spends the retries in order on any failure, then stops until a success", () => {
    const first = plan("failed", false, 0, ALWAYS);
    expect(first).toEqual({ retryAfterMs: 15_000, retriesUsed: 1 });
    const second = plan("failed", false, first.retriesUsed, ALWAYS);
    expect(second).toEqual({ retryAfterMs: 45_000, retriesUsed: 2 });
    expect(plan("failed", false, second.retriesUsed, ALWAYS).retryAfterMs).toBeNull();
  });

  it("a job without a retry policy never retries", () => {
    expect(planRetry({ result: "failed", resumed: true, retriesUsed: 0 }, undefined)).toEqual({ retryAfterMs: null, retriesUsed: 0 });
  });
});

describe("nextAlignedMs", () => {
  it("is the next wall-clock multiple strictly after now", () => {
    expect(nextAlignedMs(0, 30_000)).toBe(30_000);
    expect(nextAlignedMs(29_999, 30_000)).toBe(30_000);
    expect(nextAlignedMs(30_000, 30_000)).toBe(60_000);
  });
});

describe("ScheduledJob", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-05-27T14:00:00Z") });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function intervalJob(over: Partial<ConstructorParameters<typeof ScheduledJob>[0]> = {}) {
    const runs: string[] = [];
    let last: number | null = null;
    const job = new ScheduledJob({
      name: "test",
      enabled: () => true,
      next: (now) => (last == null ? now : last + 60_000),
      run: async (tick) => {
        last = Date.now();
        runs.push(tick.cause + (tick.resumed ? ":resumed" : ""));
        return "ok";
      },
      ...over,
    });
    return { job, runs };
  }

  it("runs at once when due, then on its next instant", async () => {
    const { job, runs } = intervalJob();
    job.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toEqual(["timer"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs).toEqual(["timer", "timer"]);
    job.stop();
  });

  it("never arms when disabled", async () => {
    const { job, runs } = intervalJob({ enabled: () => false });
    expect(job.start()).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runs).toEqual([]);
  });

  it("waits out the network grace when its timer fires after a suspend", async () => {
    const { job, runs } = intervalJob({ wake: () => ({ wakeGapMs: 30_000, networkGraceMs: 10_000 }) });
    job.start();
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + 20 * 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs).toEqual(["timer"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runs).toEqual(["timer", "timer:resumed"]);
    job.stop();
  });

  it("skips its runs while asleep and runs when its wake source fires", async () => {
    let awake = false;
    let wakeListener: (() => void) | null = null;
    const { job, runs } = intervalJob({ awake: () => awake, onWake: (l) => (wakeListener = l) });
    job.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runs).toEqual([]);
    awake = true;
    wakeListener!();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toEqual(["trigger"]);
    job.stop();
  });

  it("runs once more after a run when triggered meanwhile (`again`), skips otherwise", async () => {
    for (const whileRunning of ["again", "skip"] as const) {
      let release: () => void = () => {};
      const runs: string[] = [];
      const job = new ScheduledJob({
        name: "test",
        enabled: () => true,
        whileRunning,
        next: () => null,
        run: async (tick) => {
          runs.push(tick.cause);
          if (runs.length === 1) await new Promise<void>((r) => (release = r));
          return "ok";
        },
      });
      job.start();
      job.trigger();
      job.trigger();
      job.trigger();
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(runs).toEqual(whileRunning === "again" ? ["trigger", "trigger"] : ["trigger"]);
      job.stop();
    }
  });

  it("retries a failed run on its policy's delays", async () => {
    const results: KernelRunResult[] = ["failed", "failed", "failed"];
    const runs: string[] = [];
    const job = new ScheduledJob({
      name: "test",
      enabled: () => true,
      next: () => null,
      retry: ALWAYS,
      run: async (tick) => {
        runs.push(tick.cause);
        return results.shift() ?? "ok";
      },
    });
    job.start();
    job.trigger();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(runs).toEqual(["trigger", "retry"]);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(runs).toEqual(["trigger", "retry", "retry"]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(runs).toHaveLength(3);
    job.stop();
  });
});

describe("ScheduledJob — a `next` that throws", () => {
  const JOB = "vitest-kernel-next-throws";
  const notifications = () =>
    (
      db
        .prepare(`SELECT COUNT(*) AS c FROM app_messages WHERE kind = 'notification' AND title = ?`)
        .get(nextErrorNotificationTitle(JOB)) as { c: number }
    ).c;

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-05-27T14:00:00Z") });
  });
  afterEach(() => {
    vi.useRealTimers();
    db.prepare(`DELETE FROM app_messages WHERE title = ?`).run(nextErrorNotificationTitle(JOB));
  });

  it("asks again after the retry delay, notifies once per streak, and runs once it answers", async () => {
    let throws = 2;
    const runs: string[] = [];
    const job = new ScheduledJob({
      name: JOB,
      enabled: () => true,
      next: (now) => {
        if (throws > 0) {
          throws--;
          throw new Error("stale rule row");
        }
        return runs.length === 0 ? now : null;
      },
      run: async (tick) => {
        runs.push(tick.cause);
        return "ok";
      },
    });
    job.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toEqual([]);
    expect(notifications()).toBe(1);
    await vi.advanceTimersByTimeAsync(NEXT_ERROR_RETRY_MS);
    await vi.advanceTimersByTimeAsync(NEXT_ERROR_RETRY_MS - 1);
    expect(runs).toEqual([]);
    expect(notifications()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toEqual(["timer"]);

    // A new streak after a recovery notifies again.
    throws = 1;
    job.reschedule();
    expect(notifications()).toBe(2);
    job.stop();
  });
});

describe("stopAllScheduledJobs", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-05-27T14:00:00Z") });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops every started job, and only started ones are counted", async () => {
    const runs: string[] = [];
    const make = (name: string) =>
      new ScheduledJob({
        name,
        enabled: () => true,
        next: (now) => now + 60_000,
        run: async () => {
          runs.push(name);
          return "ok";
        },
      });
    const a = make("a");
    const b = make("b");
    make("never-started");
    a.start();
    b.start();
    expect(stopAllScheduledJobs()).toBeGreaterThanOrEqual(2);
    expect(a.isEnabled || b.isEnabled).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runs).toEqual([]);
    expect(stopAllScheduledJobs()).toBe(0);
  });
});
