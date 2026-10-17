/**
 * Pure decisions for the global-sync scheduler: whether a tick follows a machine suspend, how long
 * to wait for the network before syncing, and how the bounded post-wake retry budget evolves.
 *
 * Why: a slept-through due time fires its timer the moment the Mac wakes, before the network is
 * back (2026-09-15 07:10 → 10:53 hibernation, 2026-09-25 04:21 wake), so the first sync after a
 * wake fails on every source and nothing retries for a full poll interval. The live-quotes
 * scheduler already handles this shape (`liveMarketQuotesSchedulerPolicy.ts`); this mirrors it
 * for the global sync. (The 2026-10-16 evening, where twelve Fintual polls in a row failed with
 * "fetch failed", was NOT this: the Mac was awake on a dead network for three hours — every Yahoo
 * request failed too — and no retry cadence could have caught the cuota Fintual published in the
 * gap. That case is covered by the public-serie placeholder fill, `fintual_official_serie`.) Kept pure so the
 * timer wiring in `globalSyncScheduler.ts` stays trivial and this is unit-testable.
 */

/** After a resume, how long to give the network before the first sync. */
export const GLOBAL_SYNC_RESUME_NETWORK_WAIT_MS = 10_000;

/** Retry delays after a failed post-wake sync — the budget refills only when a tick succeeds. */
export const GLOBAL_SYNC_RETRY_DELAYS_MS: readonly number[] = [60_000, 180_000];

/**
 * Estimated time the process was suspended before a timer fired, from two independent signals:
 * - `lateByMs`: how much later than scheduled (wall clock) the timer fired;
 * - `divergenceMs`: wall-clock elapsed minus monotonic elapsed since the last activity. The
 *   monotonic clock stops during sleep, so this catches a wake that lands exactly on schedule
 *   (e.g. a maintenance wake aligned with the poll interval), where lateness alone reads 0.
 * The larger of the two wins; negative values (jitter) read as 0.
 */
export function suspendedGapMs(input: { lateByMs: number; divergenceMs: number }): number {
  return Math.max(0, input.lateByMs, input.divergenceMs);
}

export type GlobalSyncTickPlan = {
  /** The tick follows a suspend long enough to count as a wake. */
  resumed: boolean;
  /** Network grace period before syncing: 0 unless `resumed`. */
  waitBeforeSyncMs: number;
};

export function planGlobalSyncTick(input: { suspendedGapMs: number; wakeGapMs: number }): GlobalSyncTickPlan {
  const resumed = input.suspendedGapMs >= input.wakeGapMs;
  return { resumed, waitBeforeSyncMs: resumed ? GLOBAL_SYNC_RESUME_NETWORK_WAIT_MS : 0 };
}

export type GlobalSyncRetryPlan = {
  /** Delay before the next attempt, or null when nothing is scheduled. */
  retryAfterMs: number | null;
  /** Retries spent so far; feed back into the next call. 0 after a success. */
  retriesUsed: number;
};

/**
 * Bounded retries after a failed sync that followed a wake. `exitCode` is `runGlobalSyncAll`'s
 * (non-zero = a step errored, e.g. the Fintual auth failure), or `null` when the tick threw.
 *
 * - success (exit 0) cancels any pending retry and refills the budget;
 * - a failure retries only while recovering from a wake: the tick itself followed a suspend, or
 *   an earlier retry of that sequence is already spent (`retriesUsed > 0`, so retry ticks chain
 *   even though they did not follow a suspend themselves);
 * - a failure outside a wake never retries — the next poll comes anyway and retrying a
 *   genuinely failing source would only hammer it;
 * - once the delays are spent, nothing is scheduled until a tick succeeds again.
 */
export function planAfterGlobalSync(input: {
  resumedAfterSuspend: boolean;
  exitCode: number | null;
  retriesUsed: number;
}): GlobalSyncRetryPlan {
  if (input.exitCode === 0) return { retryAfterMs: null, retriesUsed: 0 };
  const recovering = input.resumedAfterSuspend || input.retriesUsed > 0;
  if (!recovering || input.retriesUsed >= GLOBAL_SYNC_RETRY_DELAYS_MS.length) {
    return { retryAfterMs: null, retriesUsed: input.retriesUsed };
  }
  return {
    retryAfterMs: GLOBAL_SYNC_RETRY_DELAYS_MS[input.retriesUsed] ?? null,
    retriesUsed: input.retriesUsed + 1,
  };
}
