/**
 * Pure decisions for the live-quotes scheduler: when a tick is the first after the process was
 * suspended, whether a tick failed wholesale, and how the bounded retry budget evolves.
 *
 * Why: on 2026-09-15 the Mac hibernated at 07:10 and woke at 10:53; the scheduler's catch-up tick
 * fired one second later, before Wi-Fi was back, so all 20 Yahoo requests failed, the fx fell back
 * to yesterday's EOD mirror, and nothing retried for a full interval. For those five minutes every
 * Yahoo-priced account read yesterday's close (day P/L exactly 0) while accounts priced elsewhere
 * moved. Kept pure so the timer wiring in the scheduler stays trivial and this is unit-testable.
 */
import type { LiveMarketQuotesSyncResult } from "./liveMarketQuotesSync.js";

/** After a resume, how long to give the network before the first fetch. */
export const RESUME_NETWORK_WAIT_MS = 10_000;

/** Retry delays after a wholesale failure — the budget refills only when a tick succeeds. */
export const RETRY_DELAYS_MS: readonly number[] = [15_000, 45_000];

/**
 * A tick that fires far later than scheduled means the timer was suspended (sleep). Two intervals
 * of drift is well beyond any ordinary scheduling jitter.
 */
export function resumedAfterSuspend(
  lastTickStartedAtMs: number | null,
  nowMs: number,
  intervalMs: number
): boolean {
  if (lastTickStartedAtMs == null) return false;
  return nowMs - lastTickStartedAtMs > 2 * intervalMs;
}

/**
 * Every equity request failed. Partial failures are Yahoo throttling individual symbols and must
 * not trigger retries (more requests would make that worse). The fx leg is not consulted: its
 * sync falls back to the stored EOD close and reports ok even when the live fetch failed.
 */
export function tickFailedWholesale(result: LiveMarketQuotesSyncResult): boolean {
  return result.equities.length > 0 && result.equities.every((r) => !r.ok);
}

export type RetryPlan = {
  /** Delay before the next attempt, or null when nothing is scheduled. */
  delayMs: number | null;
  /** Retries still available before a tick succeeds again. */
  budgetRemaining: number;
};

/**
 * Bounded retries: a wholesale failure spends one retry per attempt, in order, and a success
 * refills the budget. A continuous outage therefore costs `RETRY_DELAYS_MS.length` extra
 * attempts in total, not per interval.
 */
export function planAfterTick(budgetRemaining: number, failedWholesale: boolean): RetryPlan {
  if (!failedWholesale) return { delayMs: null, budgetRemaining: RETRY_DELAYS_MS.length };
  if (budgetRemaining <= 0) return { delayMs: null, budgetRemaining: 0 };
  const attempt = RETRY_DELAYS_MS.length - budgetRemaining;
  return { delayMs: RETRY_DELAYS_MS[attempt] ?? null, budgetRemaining: budgetRemaining - 1 };
}
