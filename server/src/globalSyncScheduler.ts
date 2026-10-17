/**
 * In-process scheduler for external syncs.
 *
 * - While any source is stale: poll on an interval (default 15 min), sync immediately on start.
 * - When `stocks_nyse` is stale after the NYSE close window, or `stocks_santiago` on the evening of
 *   its Chile close: poll every 3 min until caught up.
 * - After a suspend (sleep/wake, detected by a late timer or wall-vs-monotonic clock divergence):
 *   wait 10 s for the network, then sync; a sync that still fails is retried after 60 s and 180 s
 *   (`globalSyncSchedulerPolicy.ts`). Covers the poll loop and the fresh-source wake timer alike.
 * - When all sources are fresh: stop polling; wake at the earliest source `next_sync` wall time.
 *
 * Env:
 * - `GLOBAL_SYNC_ENABLED` — default on; set `0` to disable.
 * - `GLOBAL_SYNC_INTERVAL_MS` — poll interval while stale (default 15 minutes).
 * - `GLOBAL_SYNC_NYSE_STALE_INTERVAL_MS` — faster poll when a stock EOD bar is due but missing (default 3 minutes).
 * - `GLOBAL_SYNC_WAKE_GAP_MS` — suspended time that counts as a wake (default 5 minutes).
 */
import { chileWallClockAt, chileWallClockNow } from "./chileDate.js";
import { runGlobalSyncAll } from "./globalSyncAll.js";
import { allSyncSourceStatuses, staleSyncSources, type GlobalSyncSource } from "./globalSyncStale.js";
import { equityEodNyseSyncDue, equityEodSantiagoSyncDue } from "./equityEodSync.js";
import { loadGlobalSyncState } from "./globalSyncState.js";
import {
  GLOBAL_SYNC_RETRY_DELAYS_MS,
  planAfterGlobalSync,
  planGlobalSyncTick,
  suspendedGapMs,
} from "./globalSyncSchedulerPolicy.js";
import { loadRootDotenv } from "./rootDotenv.js";
import { syncWallTimeToMs } from "./syncSourceSchedule.js";

let inFlight = false;
let pollIntervalHandle: ReturnType<typeof setInterval> | null = null;
let wakeTimerHandle: ReturnType<typeof setTimeout> | null = null;
let schedulerEnabled = false;
let schedulerIntervalMs = 15 * 60 * 1000;
let nyseStalePollIntervalMs = 3 * 60 * 1000;
let wakeGapMs = 5 * 60 * 1000;
let pollLoopActive = false;
let activePollIntervalMs: number | null = null;
/** Wall-clock ms for next poll (while stale) or idle wake (when fresh). */
let nextCheckAtMs: number | null = null;
/** Wall and monotonic clock at the last activity; their divergence measures time spent suspended. */
let lastActivityWallMs = Date.now();
let lastActivityMonotonicMs = performance.now();
/** Suspended time seen by timer callbacks since the last tick consumed it. */
let observedSuspendedMs = 0;
/** Wall time the poll interval is next expected to fire. */
let pollExpectedAtMs: number | null = null;
/** Post-wake retries spent; refilled by a tick that finishes with exit code 0. */
let retriesUsed = 0;
let retryTimerHandle: ReturnType<typeof setTimeout> | null = null;
/** The network grace period before a post-wake sync; cancellable so a stop never strands `inFlight`. */
let resumeWait: { handle: ReturnType<typeof setTimeout>; resolve: (cancelled: boolean) => void } | null = null;

export type GlobalSyncSchedulerSnapshot = {
  enabled: boolean;
  interval_ms: number;
  in_flight: boolean;
  next_check_at: string | null;
};

export function getGlobalSyncSchedulerSnapshot(): GlobalSyncSchedulerSnapshot {
  return {
    enabled: schedulerEnabled,
    interval_ms: activePollIntervalMs ?? schedulerIntervalMs,
    in_flight: inFlight,
    next_check_at:
      nextCheckAtMs != null && Number.isFinite(nextCheckAtMs)
        ? new Date(nextCheckAtMs).toISOString()
        : null,
  };
}

/** Poll interval while sources remain stale (a stock EOD bar due this session uses a shorter interval). */
export function pollIntervalMsForStaleSources(stale: readonly GlobalSyncSource[]): number {
  const now = new Date();
  if (stale.includes("stocks_nyse") && equityEodNyseSyncDue(now) != null) {
    return nyseStalePollIntervalMs;
  }
  // Santiago: fast only on the evening of the close. Its due carries over to the last closed
  // session, so an unlisted Chilean holiday would otherwise hit Yahoo every 3 minutes all day.
  if (stale.includes("stocks_santiago") && equityEodSantiagoSyncDue(now) === chileWallClockAt(now).ymd) {
    return nyseStalePollIntervalMs;
  }
  return schedulerIntervalMs;
}

function scheduleNextCheckAt(atMs: number): void {
  nextCheckAtMs = atMs;
}

function envFlag(name: string, defaultOn: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no") return false;
  if (v === "1" || v === "true" || v === "yes") return true;
  return defaultOn;
}

function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clearWakeTimer(): void {
  if (wakeTimerHandle != null) {
    clearTimeout(wakeTimerHandle);
    wakeTimerHandle = null;
  }
}

function stopPollLoop(): void {
  if (pollIntervalHandle != null) {
    clearInterval(pollIntervalHandle);
    pollIntervalHandle = null;
  }
  pollLoopActive = false;
  activePollIntervalMs = null;
  pollExpectedAtMs = null;
}

function restartPollInterval(intervalMs: number): void {
  if (pollIntervalHandle != null) {
    clearInterval(pollIntervalHandle);
    pollIntervalHandle = null;
  }
  activePollIntervalMs = intervalMs;
  pollExpectedAtMs = Date.now() + intervalMs;
  pollIntervalHandle = setInterval(() => {
    observeTimerFire(pollExpectedAtMs);
    pollExpectedAtMs = Date.now() + intervalMs;
    scheduleNextCheckAt(Date.now() + intervalMs);
    void schedulerTick();
  }, intervalMs);
}

function ensurePollInterval(intervalMs: number): void {
  if (pollIntervalHandle != null && activePollIntervalMs === intervalMs) return;
  restartPollInterval(intervalMs);
}

function noteSchedulerActivity(): void {
  lastActivityWallMs = Date.now();
  lastActivityMonotonicMs = performance.now();
}

/**
 * Call first thing in every timer callback. Records how long the process was suspended before the
 * timer fired, so the tick it triggers (directly, or through `rescheduleGlobalSyncScheduler` for
 * the fresh-source wake timer) knows it follows a wake. Two signals, see `suspendedGapMs`.
 */
function observeTimerFire(expectedAtMs: number | null): void {
  const lateByMs = expectedAtMs == null ? 0 : Date.now() - expectedAtMs;
  const divergenceMs =
    Date.now() - lastActivityWallMs - (performance.now() - lastActivityMonotonicMs);
  observedSuspendedMs = Math.max(observedSuspendedMs, suspendedGapMs({ lateByMs, divergenceMs }));
}

function clearRetryTimer(): void {
  if (retryTimerHandle != null) {
    clearTimeout(retryTimerHandle);
    retryTimerHandle = null;
  }
}

function cancelResumeWait(): void {
  if (resumeWait != null) {
    clearTimeout(resumeWait.handle);
    resumeWait.resolve(true);
    resumeWait = null;
  }
}

/** Resolves true when cancelled by a scheduler stop, false when the wait elapsed. */
function waitForNetwork(ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const handle = setTimeout(() => {
      resumeWait = null;
      resolve(false);
    }, ms);
    resumeWait = { handle, resolve };
  });
}

/**
 * Earliest wall time a source becomes due. `skip` leaves out sources already stale: while the
 * poll loop runs for them, the fresh sources' due times still need their own wake, or a stock
 * EOD due at 16:05 New York waits for the next 15-minute poll (2026-10-06: AFP/AFC stale all
 * afternoon, the NYSE bars landed at the 17:11 Chile tick instead of 17:05).
 */
function earliestNextWakeMs(skip: ReadonlySet<string> = new Set()): number | null {
  loadRootDotenv();
  const cl = chileWallClockNow();
  const state = loadGlobalSyncState();
  const rows = allSyncSourceStatuses(cl, state);
  let min: number | null = null;
  for (const row of rows) {
    if (row.status === "disabled" || skip.has(row.source)) continue;
    if (row.next_sync_imminent) return Date.now();
    if (row.next_sync) {
      const ms = syncWallTimeToMs(row.next_sync);
      if (min == null || ms < min) min = ms;
    }
  }
  return min;
}

function scheduleWakeTimer(atMs: number | null): void {
  clearWakeTimer();
  if (!schedulerEnabled || atMs == null) {
    if (!pollLoopActive) nextCheckAtMs = null;
    return;
  }
  const delay = Math.max(0, atMs - Date.now());
  scheduleNextCheckAt(atMs);
  wakeTimerHandle = setTimeout(() => {
    wakeTimerHandle = null;
    observeTimerFire(atMs);
    void rescheduleGlobalSyncScheduler();
  }, delay);
}

/** While polling for stale sources: tick when a fresh source falls due before the next poll. */
function scheduleFreshSourceWake(atMs: number): void {
  clearWakeTimer();
  scheduleNextCheckAt(atMs);
  wakeTimerHandle = setTimeout(() => {
    wakeTimerHandle = null;
    observeTimerFire(atMs);
    void schedulerTick();
  }, Math.max(0, atMs - Date.now()));
}

function runGlobalSyncInProcess(): Promise<number> {
  return runGlobalSyncAll({ dryRun: false });
}

async function schedulerTick(): Promise<void> {
  if (inFlight) {
    console.log("sync:scheduler — skip (previous run still in progress).");
    return;
  }
  const suspendedMs = observedSuspendedMs;
  observedSuspendedMs = 0;
  noteSchedulerActivity();
  const tickPlan = planGlobalSyncTick({ suspendedGapMs: suspendedMs, wakeGapMs });
  inFlight = true;
  /** 0 = ok (or nothing stale), n = failed steps, null = threw. */
  let exitCode: number | null = 0;
  let cancelled = false;
  try {
    if (tickPlan.resumed) {
      console.log(
        `sync:scheduler — resumed after ~${Math.round(suspendedMs / 1000)}s suspended; ` +
          `waiting ${Math.round(tickPlan.waitBeforeSyncMs / 1000)}s for the network`
      );
      if (await waitForNetwork(tickPlan.waitBeforeSyncMs)) {
        cancelled = true;
        return;
      }
    }
    loadRootDotenv();
    const cl = chileWallClockNow();
    const state = loadGlobalSyncState();
    const stale = staleSyncSources(cl, state);
    if (stale.length === 0) return;
    console.log(
      `sync:scheduler — stale [${stale.join(", ")}] at Chile ${cl.ymd} ${String(cl.hour).padStart(2, "0")}:${String(cl.minute).padStart(2, "0")}`
    );
    const code = await runGlobalSyncInProcess();
    exitCode = code;
    if (code !== 0) {
      console.warn(`sync:scheduler — global-sync exited with code ${code}`);
    } else {
      console.log("sync:scheduler — global-sync finished ok.");
    }
  } catch (e) {
    exitCode = null;
    console.error(`sync:scheduler — error: ${e instanceof Error ? e.message : e}`);
  } finally {
    inFlight = false;
    if (schedulerEnabled && !cancelled) {
      scheduleRetryAfterTick(tickPlan.resumed, exitCode);
      await rescheduleGlobalSyncScheduler();
    }
  }
}

/** A sync that failed right after a wake is retried soon, not a full poll interval later. */
function scheduleRetryAfterTick(resumed: boolean, exitCode: number | null): void {
  const plan = planAfterGlobalSync({ resumedAfterSuspend: resumed, exitCode, retriesUsed });
  retriesUsed = plan.retriesUsed;
  if (exitCode === 0) clearRetryTimer();
  if (plan.retryAfterMs == null) return;
  clearRetryTimer();
  const attempt = plan.retriesUsed;
  console.log(
    `sync:scheduler — retrying in ${Math.round(plan.retryAfterMs / 1000)}s after a failed post-wake sync ` +
      `(attempt ${attempt}/${GLOBAL_SYNC_RETRY_DELAYS_MS.length})`
  );
  const expectedAtMs = Date.now() + plan.retryAfterMs;
  retryTimerHandle = setTimeout(() => {
    retryTimerHandle = null;
    observeTimerFire(expectedAtMs);
    void schedulerTick();
  }, plan.retryAfterMs);
}

/** Re-evaluate stale sources: start/stop poll loop or schedule next wake. */
export async function rescheduleGlobalSyncScheduler(): Promise<void> {
  if (!schedulerEnabled) return;
  noteSchedulerActivity();
  loadRootDotenv();
  const cl = chileWallClockNow();
  const state = loadGlobalSyncState();
  const stale = staleSyncSources(cl, state);
  if (stale.length > 0) {
    const intervalMs = pollIntervalMsForStaleSources(stale);
    if (!pollLoopActive) {
      pollLoopActive = true;
      clearWakeTimer();
      console.log(
        `sync:scheduler — stale [${stale.join(", ")}]; polling every ${Math.round(intervalMs / 1000)}s`
      );
      void schedulerTick();
    } else {
      ensurePollInterval(intervalMs);
    }
    const nextPollMs = Date.now() + intervalMs;
    const freshWakeMs = earliestNextWakeMs(new Set(stale));
    if (freshWakeMs != null && freshWakeMs > Date.now() && freshWakeMs < nextPollMs) {
      scheduleFreshSourceWake(freshWakeMs);
    } else {
      clearWakeTimer();
      scheduleNextCheckAt(nextPollMs);
    }
    return;
  }
  stopPollLoop();
  const wakeAt = earliestNextWakeMs();
  if (wakeAt != null) {
    console.log(`sync:scheduler — all fresh; next wake ${new Date(wakeAt).toISOString()}`);
  } else {
    console.log("sync:scheduler — all fresh; no scheduled wake.");
  }
  scheduleWakeTimer(wakeAt);
}

/** Call after force-stale or other events that may require immediate polling. */
export function notifyGlobalSyncScheduler(): void {
  if (!schedulerEnabled) return;
  if (pollLoopActive) {
    scheduleNextCheckAt(Date.now());
    void schedulerTick();
    return;
  }
  void rescheduleGlobalSyncScheduler();
}

export function startGlobalSyncScheduler(): void {
  schedulerEnabled = envFlag("GLOBAL_SYNC_ENABLED", true);
  if (!schedulerEnabled) {
    console.log("sync:scheduler — disabled (GLOBAL_SYNC_ENABLED=0).");
    nextCheckAtMs = null;
    return;
  }
  schedulerIntervalMs = envMs("GLOBAL_SYNC_INTERVAL_MS", 15 * 60 * 1000);
  nyseStalePollIntervalMs = envMs("GLOBAL_SYNC_NYSE_STALE_INTERVAL_MS", 3 * 60 * 1000);
  wakeGapMs = envMs("GLOBAL_SYNC_WAKE_GAP_MS", 5 * 60 * 1000);
  noteSchedulerActivity();
  retriesUsed = 0;
  console.log(
    `sync:scheduler — enabled; polls every ${Math.round(schedulerIntervalMs / 1000)}s while stale` +
      ` (${Math.round(nyseStalePollIntervalMs / 1000)}s when NYSE EOD due)`
  );
  void rescheduleGlobalSyncScheduler();
}

export function stopGlobalSyncScheduler(): void {
  stopPollLoop();
  clearWakeTimer();
  clearRetryTimer();
  cancelResumeWait();
  retriesUsed = 0;
  observedSuspendedMs = 0;
  schedulerEnabled = false;
  nextCheckAtMs = null;
}
