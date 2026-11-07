/**
 * Per-source step runner for the global sync orchestrator (`runGlobalSyncAll`).
 * The failure contract lives here: a throwing step records a `SyncStepError` and
 * returns — it never aborts the run, so one broken source (Yahoo down, BCentral
 * credential expiry) cannot block the others. A source's user-forced-stale flag is
 * cleared only after a successful step, unless the source is still naturally stale
 * (e.g. NYSE close not yet published).
 */
import type { ChileWallClock } from "./chileDate.js";
import { clearUserForcedStale, keepUserForcedStaleAfterSuccess, SYNC_SOURCES, type GlobalSyncSource } from "./globalSyncStale.js";
import type { GlobalSyncStateFile } from "./globalSyncState.js";
import type { SyncStepError } from "./syncRunLog.js";

export function syncErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function runSyncStep(
  step: string,
  errors: SyncStepError[],
  fn: () => Promise<void>
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const message = syncErrorMessage(e);
    console.error(`sync: ${step} — error: ${message}`);
    errors.push({ step, message });
  }
}

/** Run `source`'s step when it is in the run's stale list; its label is the source table's (`SYNC_SOURCES`). */
export async function runSyncStepIfStale(
  source: GlobalSyncSource,
  stale: readonly GlobalSyncSource[],
  errors: SyncStepError[],
  state: GlobalSyncStateFile,
  cl: ChileWallClock,
  fn: () => Promise<void>
): Promise<void> {
  const step = SYNC_SOURCES[source].label;
  if (!stale.includes(source)) {
    console.log(`sync: ${step} — skip (not stale).`);
    return;
  }
  const errorsBefore = errors.length;
  await runSyncStep(step, errors, fn);
  if (errors.length === errorsBefore && !keepUserForcedStaleAfterSuccess(source, cl, state)) {
    clearUserForcedStale(state, source);
  }
}
