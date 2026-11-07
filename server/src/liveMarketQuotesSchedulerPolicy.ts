/**
 * Pure decisions for the live-quotes scheduler: when the next poll runs and whether a poll failed
 * wholesale. The wake and retry handling is the scheduler kernel's (`schedulerKernel.ts`).
 *
 * Why the retry: on 2026-09-15 the Mac hibernated at 07:10 and woke at 10:53; the scheduler's
 * catch-up tick fired one second later, before Wi-Fi was back, so all 20 Yahoo requests failed,
 * the fx fell back to yesterday's EOD mirror, and nothing retried for a full interval. For those
 * five minutes every Yahoo-priced account read yesterday's close (day P/L exactly 0) while
 * accounts priced elsewhere moved.
 */
import type { LiveMarketQuotesSyncResult } from "./liveMarketQuotesSync.js";

/**
 * Every equity request failed. Partial failures are Yahoo throttling individual symbols and must
 * not trigger retries (more requests would make that worse). The fx leg is not consulted: its
 * sync falls back to the stored EOD close and reports ok even when the live fetch failed.
 */
export function tickFailedWholesale(result: LiveMarketQuotesSyncResult): boolean {
  return result.equities.length > 0 && result.equities.every((r) => !r.ok);
}

/**
 * Delay after a market's opening minute before its first poll. Yahoo moves `regularMarketTime`
 * to the new session within the first minute of trading (2026-10-27: the 10:31:12 Chile poll
 * read the session that opened at 10:30:00), so a few seconds is enough to read it.
 */
export const OPEN_TICK_DELAY_MS = 20_000;

const MINUTE_MS = 60_000;

/**
 * When the next poll runs. Ticks sit on wall-clock multiples of the cadence — the session
 * cadence while a tracked market is open, the base one otherwise — and the minute a market
 * opens gets its own tick `OPEN_TICK_DELAY_MS` later, so live prices land right after the bell
 * instead of whenever the process happened to start (2026-10-27: polls at :x1:12 / :x6:12 from
 * the last restart, up to five minutes of the session's start read as yesterday's close).
 *
 * `sessionOpenAt` says whether any market the poll prices is in its regular session at an
 * instant; opens land on whole minutes (09:30 New York, 09:30 Chile), so open edges are found
 * by checking the minute boundaries up to the next aligned tick.
 */
export function nextLiveQuotesTickAtMs(
  nowMs: number,
  baseIntervalMs: number,
  sessionIntervalMs: number,
  sessionOpenAt: (at: Date) => boolean
): number {
  const step = sessionOpenAt(new Date(nowMs)) ? sessionIntervalMs : baseIntervalMs;
  const aligned = (Math.floor(nowMs / step) + 1) * step;
  for (let m = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS; m <= aligned; m += MINUTE_MS) {
    const openTick = m + OPEN_TICK_DELAY_MS;
    if (openTick <= nowMs) continue;
    if (openTick >= aligned) break;
    if (sessionOpenAt(new Date(m)) && !sessionOpenAt(new Date(m - MINUTE_MS))) return openTick;
  }
  return aligned;
}
