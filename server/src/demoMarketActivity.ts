import { demoModeEnabled } from "./demoModeFlag.js";

/**
 * The hosted demo's market syncs run only while someone is browsing it (2026-10-31): the global
 * sync and the live quotes skip their ticks while the demo is asleep, and the first request of
 * a visitor wakes them (each runs at once on wake, catching up whatever went stale meanwhile).
 * Any request a real visitor makes counts — the open tab's background polling included — so it
 * stays awake while a tab is open and visible, and sleeps {@link DEMO_MARKET_IDLE_MS} after the
 * last request (the app polls only while its tab is visible). The personal instance is always
 * awake.
 */
export const DEMO_MARKET_IDLE_MS = 30 * 60 * 1000;

let lastActivityAtMs: number | null = null;
const wakeListeners: (() => void)[] = [];

export function demoMarketAwake(nowMs: number = Date.now()): boolean {
  if (!demoModeEnabled()) return true;
  return lastActivityAtMs != null && nowMs - lastActivityAtMs < DEMO_MARKET_IDLE_MS;
}

/** A real visitor's request (demo visit log). Wakes the syncs when they were asleep. */
export function noteDemoMarketActivity(nowMs: number = Date.now()): void {
  const wasAwake = demoMarketAwake(nowMs);
  lastActivityAtMs = nowMs;
  if (wasAwake) return;
  console.log("demo market: a visitor arrived — waking the market syncs");
  for (const listener of wakeListeners) {
    try {
      listener();
    } catch (e) {
      console.error(`demo market: wake listener failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}

/** Run `listener` each time the demo wakes (a scheduler registers its immediate tick). */
export function onDemoMarketWake(listener: () => void): void {
  wakeListeners.push(listener);
}

/** Tests: forget the last activity and the listeners. */
export function resetDemoMarketActivityForTest(): void {
  lastActivityAtMs = null;
  wakeListeners.length = 0;
}
