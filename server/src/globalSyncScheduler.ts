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
  }
}

export function startGlobalSyncScheduler(): void {
  if (!envFlag("GLOBAL_SYNC_ENABLED", true)) {
    console.log("sync:scheduler — disabled (GLOBAL_SYNC_ENABLED=0).");
    return;
  }
  const intervalMs = envMs("GLOBAL_SYNC_INTERVAL_MS", 15 * 60 * 1000);
  const startupDelayMs = envMs("GLOBAL_SYNC_STARTUP_DELAY_MS", 30 * 1000);

  console.log(
    `sync:scheduler — enabled; first check in ${Math.round(startupDelayMs / 1000)}s, then every ${Math.round(intervalMs / 1000)}s`
  );

  setTimeout(() => {
    void schedulerTick();
    intervalHandle = setInterval(() => void schedulerTick(), intervalMs);
  }, startupDelayMs);
}

export function stopGlobalSyncScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
