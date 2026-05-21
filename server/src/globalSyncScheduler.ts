/**
 * In-process scheduler: if any external source is stale, run `runGlobalSyncAll()` directly
 * (no child `npx` process — more reliable under `tsx watch`).
 *
 * Env:
 * - `GLOBAL_SYNC_ENABLED` — default on; set `0` to disable.
 * - `GLOBAL_SYNC_INTERVAL_MS` — poll interval (default 15 minutes).
 * - `GLOBAL_SYNC_STARTUP_DELAY_MS` — first check after server listen (default 30s).
 */
import { chileWallClockNow } from "./chileDate.js";
import { staleSyncSources } from "./globalSyncStale.js";
import { loadGlobalSyncState } from "./globalSyncState.js";
import { loadRootDotenv } from "./rootDotenv.js";

let inFlight = false;
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let schedulerEnabled = false;
let schedulerIntervalMs = 15 * 60 * 1000;
/** Wall-clock ms when the next `schedulerTick` is scheduled (poll; runs sync if stale). */
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

function scheduleNextCheck(delayMs: number): void {
  nextCheckAtMs = Date.now() + delayMs;
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

async function runGlobalSyncInProcess(): Promise<number> {
  // Resolved by tsx to scripts/global-sync.ts (no compiled .js — avoid stale duplicate).
  const { runGlobalSyncAll } = await import("../scripts/global-sync.js");
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
    if (schedulerEnabled && intervalHandle != null) {
      scheduleNextCheck(schedulerIntervalMs);
    }
  }
}

export function startGlobalSyncScheduler(): void {
  schedulerEnabled = envFlag("GLOBAL_SYNC_ENABLED", true);
  if (!schedulerEnabled) {
    console.log("sync:scheduler — disabled (GLOBAL_SYNC_ENABLED=0).");
    nextCheckAtMs = null;
    return;
  }
  schedulerIntervalMs = envMs("GLOBAL_SYNC_INTERVAL_MS", 15 * 60 * 1000);
  const startupDelayMs = envMs("GLOBAL_SYNC_STARTUP_DELAY_MS", 30 * 1000);

  console.log(
    `sync:scheduler — enabled; first check in ${Math.round(startupDelayMs / 1000)}s, then every ${Math.round(schedulerIntervalMs / 1000)}s`
  );

  scheduleNextCheck(startupDelayMs);
  setTimeout(() => {
    void schedulerTick();
    scheduleNextCheck(schedulerIntervalMs);
    intervalHandle = setInterval(() => {
      scheduleNextCheck(schedulerIntervalMs);
      void schedulerTick();
    }, schedulerIntervalMs);
  }, startupDelayMs);
}

export function stopGlobalSyncScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  schedulerEnabled = false;
  nextCheckAtMs = null;
}
