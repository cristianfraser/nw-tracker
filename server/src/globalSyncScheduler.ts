/**
 * In-process scheduler for external syncs.
 *
 * - While any source is stale: poll every `GLOBAL_SYNC_INTERVAL_MS` (default 15 min), sync immediately on start.
 * - When all sources are fresh: stop polling; wake at the earliest source `next_sync` wall time.
 *
 * Env:
 * - `GLOBAL_SYNC_ENABLED` — default on; set `0` to disable.
 * - `GLOBAL_SYNC_INTERVAL_MS` — poll interval while stale (default 15 minutes).
 */
import { chileWallClockNow } from "./chileDate.js";
import { runGlobalSyncAll } from "./globalSyncAll.js";
import { allSyncSourceStatuses, staleSyncSources } from "./globalSyncStale.js";
import { loadGlobalSyncState } from "./globalSyncState.js";
import { loadRootDotenv } from "./rootDotenv.js";
import { syncWallTimeToMs } from "./syncSourceSchedule.js";

let inFlight = false;
let pollIntervalHandle: ReturnType<typeof setInterval> | null = null;
let wakeTimerHandle: ReturnType<typeof setTimeout> | null = null;
let schedulerEnabled = false;
let schedulerIntervalMs = 15 * 60 * 1000;
let pollLoopActive = false;
/** Wall-clock ms for next poll (while stale) or idle wake (when fresh). */
let nextCheckAtMs: number | null = null;

export type GlobalSyncSchedulerSnapshot = {
  enabled: boolean;
  interval_ms: number;
  in_flight: boolean;
  next_check_at: string | null;
};

export function getGlobalSyncSchedulerSnapshot(): GlobalSyncSchedulerSnapshot {
  return {
    enabled: schedulerEnabled,
    interval_ms: schedulerIntervalMs,
    in_flight: inFlight,
    next_check_at:
      nextCheckAtMs != null && Number.isFinite(nextCheckAtMs)
        ? new Date(nextCheckAtMs).toISOString()
        : null,
  };
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
}

function ensurePollInterval(): void {
  if (pollIntervalHandle != null) return;
  pollIntervalHandle = setInterval(() => {
    scheduleNextCheckAt(Date.now() + schedulerIntervalMs);
    void schedulerTick();
  }, schedulerIntervalMs);
}

function earliestNextWakeMs(): number | null {
  loadRootDotenv();
  const cl = chileWallClockNow();
  const state = loadGlobalSyncState();
  const rows = allSyncSourceStatuses(cl, state);
  let min: number | null = null;
  for (const row of rows) {
    if (row.status === "disabled") continue;
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
    void rescheduleGlobalSyncScheduler();
  }, delay);
}

function runGlobalSyncInProcess(): Promise<number> {
  return runGlobalSyncAll({ dryRun: false });
}

async function schedulerTick(): Promise<void> {
  if (inFlight) {
    console.log("sync:scheduler — skip (previous run still in progress).");
    return;
  }
  inFlight = true;
  try {
    loadRootDotenv();
    const cl = chileWallClockNow();
    const state = loadGlobalSyncState();
    const stale = staleSyncSources(cl, state);
    if (stale.length === 0) return;
    console.log(
      `sync:scheduler — stale [${stale.join(", ")}] at Chile ${cl.ymd} ${String(cl.hour).padStart(2, "0")}:${String(cl.minute).padStart(2, "0")}`
    );
    const code = await runGlobalSyncInProcess();
    if (code !== 0) {
      console.warn(`sync:scheduler — global-sync exited with code ${code}`);
    } else {
      console.log("sync:scheduler — global-sync finished ok.");
    }
  } catch (e) {
    console.error(`sync:scheduler — error: ${e instanceof Error ? e.message : e}`);
  } finally {
    inFlight = false;
    if (schedulerEnabled) {
      await rescheduleGlobalSyncScheduler();
    }
  }
}

/** Re-evaluate stale sources: start/stop poll loop or schedule next wake. */
export async function rescheduleGlobalSyncScheduler(): Promise<void> {
  if (!schedulerEnabled) return;
  loadRootDotenv();
  const cl = chileWallClockNow();
  const state = loadGlobalSyncState();
  const stale = staleSyncSources(cl, state);
  if (stale.length > 0) {
    if (!pollLoopActive) {
      pollLoopActive = true;
      clearWakeTimer();
      console.log(
        `sync:scheduler — stale [${stale.join(", ")}]; polling every ${Math.round(schedulerIntervalMs / 1000)}s`
      );
      void schedulerTick();
    } else {
      ensurePollInterval();
    }
    scheduleNextCheckAt(Date.now() + schedulerIntervalMs);
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
  console.log(
    `sync:scheduler — enabled; polls every ${Math.round(schedulerIntervalMs / 1000)}s while any source is stale`
  );
  void rescheduleGlobalSyncScheduler();
}

export function stopGlobalSyncScheduler(): void {
  stopPollLoop();
  clearWakeTimer();
  schedulerEnabled = false;
  nextCheckAtMs = null;
}
