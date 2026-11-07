/**
 * The one scheduler kernel every background job runs on (2026-11-07, docs/untangle-plan.md F14):
 * the global sync, the live quotes and their companions, the ingest scheduler's tick, the job
 * queue's executor, the cache warmer's midnight rollover and data-version check, the backup check
 * and the usage-log flush. Until then each carried its own timers, and the global sync and the
 * live quotes each their own wake and retry handling (four wake strategies on one machine).
 *
 * A job says when it next wants to run (`next`, a wall-clock instant — a slot, an interval, a
 * source falling due) and what a run does; the kernel owns the rest:
 *
 * - **One timer per job, on the wall clock.** Timers stall while the machine sleeps; the instant a
 *   job asked for does not, so the first fire after a wake is late, and the kernel sees it.
 * - **Suspend detection** (`suspendedGapMs`): how late the timer fired, or how far the wall clock
 *   ran ahead of the monotonic one since the job's last activity (a wake that lands exactly on
 *   schedule reads 0 lateness). A gap of at least the job's `wakeGapMs` is a wake.
 * - **Network grace after a wake.** A slept-through due time fires its timer the moment the Mac
 *   wakes, before the network is back (2026-09-15 07:10 → 10:53 hibernation: every Yahoo request
 *   of the catch-up tick failed one second after the wake), so a run after a wake first waits
 *   `networkGraceMs`.
 * - **A bounded retry budget** (`planRetry`): a failed run is retried after each of the job's
 *   delays in turn, and the budget refills only when a run succeeds, so a continuous outage costs
 *   that many extra attempts in total. A job retries every failure, or only while it is recovering
 *   from a wake; a run that threw retries only when the job says a throw is a failure worth it.
 * - **An in-flight guard**: a fire while a run is in progress is skipped, or (`whileRunning:
 *   "again"`) runs once more right after.
 * - **Enabled and awake gates**: a job not enabled at start never arms; an asleep job (the hosted
 *   demo with nobody browsing) skips its run and stays unarmed until its wake source triggers one.
 */

/** A run's outcome: `failed` — the work reported a failure; `threw` — it raised. */
export type KernelRunResult = "ok" | "failed" | "threw";

export type KernelRetryPolicy = {
  delaysMs: readonly number[];
  /** `always`: every failure retries; `after_wake`: only a failure while recovering from a wake. */
  when: "always" | "after_wake";
  /** A run that threw is retried too (a sync step's throw); else a throw is a bug, not the network. */
  retryThrown: boolean;
};

export type KernelWakePolicy = {
  /** Suspended time that counts as a wake. */
  wakeGapMs: number;
  /** After a wake, how long to give the network before running. */
  networkGraceMs: number;
};

export type KernelTick = {
  /** The tick follows a wake (and the grace period has passed). */
  resumed: boolean;
  /** Why it runs: the job's own timer, a retry, or a trigger (`ScheduledJob.trigger`). */
  cause: "timer" | "retry" | "trigger";
  /** The instant the job asked for, when the job's own timer fired. */
  scheduledAtMs: number | null;
};

export type ScheduledJobSpec = {
  /** The log prefix (`sync:scheduler`, `live-quotes:scheduler`, …). */
  name: string;
  /** Read once at start; a disabled job never arms. */
  enabled: () => boolean;
  /** Read before each run; an asleep job skips it. */
  awake?: () => boolean;
  /** Registers a listener the job's wake source calls (the demo's first visitor). */
  onWake?: (listener: () => void) => void;
  /** The next wall-clock instant to run at, or null for none. Asked at start, after every run and on `reschedule`. */
  next: (nowMs: number) => number | null;
  run: (tick: KernelTick) => Promise<KernelRunResult>;
  /** Read when a run starts (so a configured gap is the boot config's). */
  wake?: () => KernelWakePolicy;
  retry?: KernelRetryPolicy;
  whileRunning?: "skip" | "again";
  /** Log a skipped fire while a run is in progress. */
  logSkips?: boolean;
};

/**
 * Estimated time the process was suspended before a timer fired, from two independent signals:
 * - `lateByMs`: how much later than scheduled (wall clock) the timer fired;
 * - `divergenceMs`: wall-clock elapsed minus monotonic elapsed since the last activity. The
 *   monotonic clock stops during sleep, so this catches a wake that lands exactly on schedule.
 * The larger of the two wins; negative values (jitter) read as 0.
 */
export function suspendedGapMs(input: { lateByMs: number; divergenceMs: number }): number {
  return Math.max(0, input.lateByMs, input.divergenceMs);
}

/** Whether a run follows a wake, and how long it waits for the network first. */
export function planTick(input: { suspendedGapMs: number; wake: KernelWakePolicy | undefined }): {
  resumed: boolean;
  waitMs: number;
} {
  const resumed = input.wake != null && input.suspendedGapMs >= input.wake.wakeGapMs;
  return { resumed, waitMs: resumed ? input.wake!.networkGraceMs : 0 };
}

/**
 * The retry after a run. Success cancels any pending retry and refills the budget. A failure
 * spends the next delay while the job retries it (every failure, or — `after_wake` — while the run
 * followed a wake or an earlier retry of that sequence is spent, so retry runs chain although they
 * did not follow a wake themselves); once the delays are spent nothing is scheduled until a run
 * succeeds again.
 */
export function planRetry(
  input: { result: KernelRunResult; resumed: boolean; retriesUsed: number },
  policy: KernelRetryPolicy | undefined
): { retryAfterMs: number | null; retriesUsed: number } {
  if (input.result === "ok" || policy == null) return { retryAfterMs: null, retriesUsed: 0 };
  if (input.result === "threw" && !policy.retryThrown) return { retryAfterMs: null, retriesUsed: input.retriesUsed };
  const retrying = policy.when === "always" || input.resumed || input.retriesUsed > 0;
  if (!retrying || input.retriesUsed >= policy.delaysMs.length) {
    return { retryAfterMs: null, retriesUsed: input.retriesUsed };
  }
  return { retryAfterMs: policy.delaysMs[input.retriesUsed] ?? null, retriesUsed: input.retriesUsed + 1 };
}

/** `next` for a job whose first run is at start (boot), then on `then`. */
export function atStartThen(then: (nowMs: number) => number | null): (nowMs: number) => number | null {
  let started = false;
  return (nowMs) => {
    if (!started) {
      started = true;
      return nowMs;
    }
    return then(nowMs);
  };
}

/** The next wall-clock multiple of `ms` strictly after `nowMs`. */
export function nextAlignedMs(nowMs: number, ms: number): number {
  return (Math.floor(nowMs / ms) + 1) * ms;
}

export type ScheduledJobSnapshot = {
  enabled: boolean;
  in_flight: boolean;
  next_at_ms: number | null;
};

export class ScheduledJob {
  private enabled = false;
  private inFlight = false;
  private runAgain = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerAtMs: number | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retriesUsed = 0;
  private grace: { handle: ReturnType<typeof setTimeout>; resolve: (cancelled: boolean) => void } | null = null;
  /** Wall and monotonic clock at the last activity; their divergence measures time spent suspended. */
  private lastActivityWallMs = Date.now();
  private lastActivityMonotonicMs = performance.now();
  /** Suspended time seen by timer fires since the last run consumed it. */
  private observedSuspendedMs = 0;
  private wakeRegistered = false;

  constructor(private readonly spec: ScheduledJobSpec) {}

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Arms the job when it is enabled; returns whether it is. */
  start(): boolean {
    this.enabled = this.spec.enabled();
    if (!this.enabled) return false;
    this.noteActivity();
    this.retriesUsed = 0;
    if (!this.wakeRegistered && this.spec.onWake) {
      this.wakeRegistered = true;
      this.spec.onWake(() => {
        if (this.enabled) this.trigger();
      });
    }
    this.reschedule();
    return true;
  }

  stop(): void {
    this.enabled = false;
    this.clearTimer();
    this.clearRetry();
    if (this.grace) {
      clearTimeout(this.grace.handle);
      this.grace.resolve(true);
      this.grace = null;
    }
    this.retriesUsed = 0;
    this.observedSuspendedMs = 0;
    this.runAgain = false;
  }

  /** Ask `next` again and re-arm the job's timer. */
  reschedule(): void {
    if (!this.enabled) return;
    this.clearTimer();
    let at: number | null;
    try {
      at = this.spec.next(Date.now());
    } catch (e) {
      console.error(`${this.spec.name} — next run error: ${e instanceof Error ? e.message : e}`);
      at = null;
    }
    if (at == null) return;
    this.timerAtMs = at;
    // Due already (a source falling stale, a job's first run): run now, not a macrotask later.
    if (at <= Date.now()) {
      this.timerAtMs = null;
      this.observeFire(at);
      void this.fire({ resumed: false, cause: "timer", scheduledAtMs: at });
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.observeFire(at);
      void this.fire({ resumed: false, cause: "timer", scheduledAtMs: at });
    }, Math.max(0, at - Date.now()));
    this.timer.unref?.();
  }

  /** Run now (a producer enqueued, a source was forced stale, the demo woke). */
  trigger(): void {
    if (!this.enabled) return;
    void this.fire({ resumed: false, cause: "trigger", scheduledAtMs: null });
  }

  snapshot(): ScheduledJobSnapshot {
    return { enabled: this.enabled, in_flight: this.inFlight, next_at_ms: this.timerAtMs };
  }

  private noteActivity(): void {
    this.lastActivityWallMs = Date.now();
    this.lastActivityMonotonicMs = performance.now();
  }

  private observeFire(expectedAtMs: number): void {
    const lateByMs = Date.now() - expectedAtMs;
    const divergenceMs = Date.now() - this.lastActivityWallMs - (performance.now() - this.lastActivityMonotonicMs);
    this.observedSuspendedMs = Math.max(this.observedSuspendedMs, suspendedGapMs({ lateByMs, divergenceMs }));
  }

  private clearTimer(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.timerAtMs = null;
  }

  private clearRetry(): void {
    if (this.retryTimer != null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** Resolves true when cancelled by a stop, false when the wait elapsed. */
  private waitForNetwork(ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const handle = setTimeout(() => {
        this.grace = null;
        resolve(false);
      }, ms);
      this.grace = { handle, resolve };
    });
  }

  private async fire(base: KernelTick): Promise<void> {
    // The run in progress re-arms the job when it ends.
    if (this.inFlight) {
      if (this.spec.whileRunning === "again") this.runAgain = true;
      else if (this.spec.logSkips) console.log(`${this.spec.name} — skip (previous run still in progress).`);
      return;
    }
    // Asleep: the timer is not re-armed; the wake source's trigger runs the job and re-arms it.
    if (this.spec.awake && !this.spec.awake()) return;
    const suspendedMs = this.observedSuspendedMs;
    this.observedSuspendedMs = 0;
    this.noteActivity();
    const plan = planTick({ suspendedGapMs: suspendedMs, wake: this.spec.wake?.() });
    this.inFlight = true;
    let result: KernelRunResult = "ok";
    let cancelled = false;
    try {
      if (plan.resumed) {
        console.log(
          `${this.spec.name} — resumed after ~${Math.round(suspendedMs / 1000)}s suspended; ` +
            `waiting ${Math.round(plan.waitMs / 1000)}s for the network`
        );
        if (await this.waitForNetwork(plan.waitMs)) {
          cancelled = true;
          return;
        }
      }
      try {
        result = await this.spec.run({ ...base, resumed: plan.resumed });
      } catch (e) {
        result = "threw";
        console.error(`${this.spec.name} — error: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
      }
    } finally {
      this.inFlight = false;
      if (this.enabled && !cancelled) {
        this.afterRun(result, plan.resumed);
        this.reschedule();
        if (this.runAgain) {
          this.runAgain = false;
          setImmediate(() => this.trigger());
        }
      }
    }
  }

  private afterRun(result: KernelRunResult, resumed: boolean): void {
    const plan = planRetry({ result, resumed, retriesUsed: this.retriesUsed }, this.spec.retry);
    const spentBefore = this.retriesUsed;
    this.retriesUsed = plan.retriesUsed;
    if (result === "ok") this.clearRetry();
    if (plan.retryAfterMs == null) {
      if (result !== "ok" && this.spec.retry && spentBefore >= this.spec.retry.delaysMs.length) {
        console.warn(`${this.spec.name} — run failed and the retry budget is spent; next attempt at the regular time`);
      }
      return;
    }
    this.clearRetry();
    console.log(
      `${this.spec.name} — retrying in ${Math.round(plan.retryAfterMs / 1000)}s after a failed run ` +
        `(attempt ${plan.retriesUsed}/${this.spec.retry!.delaysMs.length})`
    );
    const expectedAtMs = Date.now() + plan.retryAfterMs;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.observeFire(expectedAtMs);
      void this.fire({ resumed: false, cause: "retry", scheduledAtMs: null });
    }, plan.retryAfterMs);
    this.retryTimer.unref?.();
  }
}
