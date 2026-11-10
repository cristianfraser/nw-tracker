/**
 * In-process scheduler for external syncs, on the scheduler kernel (`schedulerKernel.ts`).
 *
 * - While any source is stale: poll on an interval (default 15 min), sync immediately on start.
 * - When `stocks_nyse` is stale after the NYSE close window, `stocks_london` on the evening of the
 *   LSE close, or `stocks_santiago` on the evening of
 *   its Chile close: poll every 3 min until caught up.
 * - While polling, a fresh source falling due before the next poll gets its own run: a stock EOD
 *   due at 16:05 New York does not wait for the next 15-minute poll (2026-10-06: AFP/AFC stale all
 *   afternoon, the NYSE bars landed at the 17:11 Chile tick instead of 17:05).
 * - After a suspend the kernel waits 10 s for the network; a sync that still fails is retried
 *   after 60 s and 180 s — only while recovering from a wake: outside one the next poll comes
 *   anyway, and retrying a genuinely failing source would only hammer it. (The 2026-10-16 evening,
 *   twelve Fintual polls in a row failing with "fetch failed", was NOT a wake: the Mac was awake on
 *   a dead network for three hours; the public-serie placeholder fill covers that case.)
 * - When all sources are fresh: no polling; the next run is the earliest source `next_sync`.
 *
 * Env (`config.ts`): `GLOBAL_SYNC_ENABLED`, `GLOBAL_SYNC_INTERVAL_MS` (poll while stale, default
 * 15 min), `GLOBAL_SYNC_NYSE_STALE_INTERVAL_MS` (default 3 min), `GLOBAL_SYNC_WAKE_GAP_MS`
 * (suspended time that counts as a wake, default 5 min).
 */
import { demoMarketAwake, onDemoMarketWake } from "./demoMarketActivity.js";
import { chileWallClockAt, chileWallClockNow } from "./chileDate.js";
import { serverConfig } from "./config.js";
import { runGlobalSyncAll } from "./globalSyncAll.js";
import { allSyncSourceStatuses, staleSyncSources, type GlobalSyncSource } from "./globalSyncStale.js";
import { equityEodLondonSyncDue, equityEodNyseSyncDue, equityEodSantiagoSyncDue } from "./equityEodSync.js";
import { londonWallClock } from "./londonSession.js";
import { loadGlobalSyncState } from "./globalSyncState.js";
import { loadRootDotenv } from "./rootDotenv.js";
import { ScheduledJob, type KernelRunResult } from "./schedulerKernel.js";
import { syncWallTimeToMs } from "./syncSourceSchedule.js";

/** After a resume, how long to give the network before the first sync. */
export const GLOBAL_SYNC_RESUME_NETWORK_WAIT_MS = 10_000;

/** Retry delays after a failed post-wake sync — the budget refills only when a run succeeds. */
export const GLOBAL_SYNC_RETRY_DELAYS_MS: readonly number[] = [60_000, 180_000];

/** Polling: the sources are stale; the next poll's wall time and its cadence. */
let polling: { nextPollAtMs: number; intervalMs: number } | null = null;

export type GlobalSyncSchedulerSnapshot = {
  enabled: boolean;
  interval_ms: number;
  in_flight: boolean;
  next_check_at: string | null;
};

/** Poll interval while sources remain stale (a stock EOD bar due this session uses a shorter interval). */
export function pollIntervalMsForStaleSources(stale: readonly GlobalSyncSource[]): number {
  const { intervalMs, nyseStaleIntervalMs } = serverConfig().globalSync;
  const now = new Date();
  if (stale.includes("stocks_nyse") && equityEodNyseSyncDue(now) != null) return nyseStaleIntervalMs;
  // Santiago: fast only on the evening of the close. Its due carries over to the last closed
  // session, so an unlisted Chilean holiday would otherwise hit Yahoo every 3 minutes all day.
  if (stale.includes("stocks_santiago") && equityEodSantiagoSyncDue(now) === chileWallClockAt(now).ymd) {
    return nyseStaleIntervalMs;
  }
  // London: the same rule on the LSE's own day — fast on the evening of its close, never all day.
  if (stale.includes("stocks_london") && equityEodLondonSyncDue(now) === londonWallClock(now).ymd) {
    return nyseStaleIntervalMs;
  }
  return intervalMs;
}

function staleNow(): GlobalSyncSource[] {
  loadRootDotenv();
  return staleSyncSources(chileWallClockNow(), loadGlobalSyncState());
}

/**
 * Earliest wall time a source becomes due. `skip` leaves out sources already stale: while the
 * poll runs for them, the fresh sources' due times still need their own run.
 */
function earliestNextWakeMs(skip: ReadonlySet<string> = new Set()): number | null {
  loadRootDotenv();
  const rows = allSyncSourceStatuses(chileWallClockNow(), loadGlobalSyncState());
  let min: number | null = null;
  for (const row of rows) {
    if (row.status === "disabled" || (row.source != null && skip.has(row.source))) continue;
    if (row.next_sync_imminent) return Date.now();
    if (row.next_sync) {
      const ms = syncWallTimeToMs(row.next_sync);
      if (min == null || ms < min) min = ms;
    }
  }
  return min;
}

function startPolling(stale: readonly GlobalSyncSource[], firstPollAtMs: number): void {
  const intervalMs = pollIntervalMsForStaleSources(stale);
  polling = { nextPollAtMs: firstPollAtMs, intervalMs };
  console.log(`sync:scheduler — stale [${stale.join(", ")}]; polling every ${Math.round(intervalMs / 1000)}s`);
}

/** When the sync runs next: now when polling starts, the next poll, or the earliest source due. */
function nextGlobalSyncAtMs(nowMs: number): number | null {
  const stale = staleNow();
  if (stale.length === 0) {
    if (polling) console.log("sync:scheduler — all fresh; polling stops.");
    polling = null;
    const wakeAt = earliestNextWakeMs();
    console.log(
      wakeAt != null ? `sync:scheduler — all fresh; next wake ${new Date(wakeAt).toISOString()}` : "sync:scheduler — all fresh; no scheduled wake."
    );
    return wakeAt;
  }
  if (!polling) {
    startPolling(stale, nowMs);
    return nowMs;
  }
  const intervalMs = pollIntervalMsForStaleSources(stale);
  // A changed cadence restarts the poll from now; a poll whose time came (it ran, or fired while a
  // run was in progress) is next one interval from now.
  if (intervalMs !== polling.intervalMs || polling.nextPollAtMs <= nowMs) {
    polling = { nextPollAtMs: nowMs + intervalMs, intervalMs };
  }
  const freshWakeMs = earliestNextWakeMs(new Set(stale));
  return freshWakeMs != null && freshWakeMs > nowMs && freshWakeMs < polling.nextPollAtMs ? freshWakeMs : polling.nextPollAtMs;
}

async function runGlobalSyncTick(): Promise<KernelRunResult> {
  const cl = chileWallClockNow();
  const stale = staleNow();
  if (stale.length === 0) return "ok";
  // A run that finds stale sources while not polling (a source falling due) starts the poll.
  if (!polling) startPolling(stale, Date.now() + pollIntervalMsForStaleSources(stale));
  console.log(
    `sync:scheduler — stale [${stale.join(", ")}] at Chile ${cl.ymd} ${String(cl.hour).padStart(2, "0")}:${String(cl.minute).padStart(2, "0")}`
  );
  const code = await runGlobalSyncAll({ dryRun: false });
  if (code !== 0) {
    console.warn(`sync:scheduler — global-sync exited with code ${code}`);
    return "failed";
  }
  console.log("sync:scheduler — global-sync finished ok.");
  return "ok";
}

const job = new ScheduledJob({
  name: "sync:scheduler",
  enabled: () => serverConfig().globalSync.enabled,
  // The hosted demo syncs only while someone browses it; its first request runs the sync.
  awake: () => demoMarketAwake(),
  onWake: (listener) => onDemoMarketWake(listener),
  next: nextGlobalSyncAtMs,
  run: runGlobalSyncTick,
  wake: () => ({ wakeGapMs: serverConfig().globalSync.wakeGapMs, networkGraceMs: GLOBAL_SYNC_RESUME_NETWORK_WAIT_MS }),
  retry: { delaysMs: GLOBAL_SYNC_RETRY_DELAYS_MS, when: "after_wake", retryThrown: true },
  logSkips: true,
});

export function getGlobalSyncSchedulerSnapshot(): GlobalSyncSchedulerSnapshot {
  const s = job.snapshot();
  return {
    enabled: s.enabled,
    interval_ms: polling?.intervalMs ?? serverConfig().globalSync.intervalMs,
    in_flight: s.in_flight,
    next_check_at: s.next_at_ms != null && Number.isFinite(s.next_at_ms) ? new Date(s.next_at_ms).toISOString() : null,
  };
}

/** Call after force-stale or other events that may require immediate polling. */
export function notifyGlobalSyncScheduler(): void {
  if (!job.isEnabled) return;
  if (polling) job.trigger();
  else job.reschedule();
}

export function startGlobalSyncScheduler(): void {
  polling = null;
  if (!job.start()) {
    console.log("sync:scheduler — disabled (GLOBAL_SYNC_ENABLED=0).");
    return;
  }
  const c = serverConfig().globalSync;
  console.log(
    `sync:scheduler — enabled; polls every ${Math.round(c.intervalMs / 1000)}s while stale` +
      ` (${Math.round(c.nyseStaleIntervalMs / 1000)}s when NYSE EOD due)`
  );
}

export function stopGlobalSyncScheduler(): void {
  job.stop();
  polling = null;
}
