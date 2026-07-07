/**
 * Per-source step runner for the global sync orchestrator (`runGlobalSyncAll`).
 * The failure contract lives here: a throwing step records a `SyncStepError` and
 * returns — it never aborts the run, so one broken source (Yahoo down, BCentral
 * credential expiry) cannot block the others. A source's user-forced-stale flag is
 * cleared only after a successful step, unless the source is still naturally stale
 * (e.g. NYSE close not yet published).
 */
import { chileWallClockNow } from "./chileDate.js";
import {
  clearUserForcedStale,
  isCryptoEodStale,
  isFintualSyncStale,
  isStocksNyseStale,
  shouldRunSyncSource,
  type GlobalSyncSource,
} from "./globalSyncStale.js";
import type { GlobalSyncStateFile } from "./globalSyncState.js";
import { isYahooFxUsdStale } from "./fxYahooEodSync.js";
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

export async function runSyncStepIfStale(
  source: GlobalSyncSource,
  stale: readonly GlobalSyncSource[],
  step: string,
  errors: SyncStepError[],
  state: GlobalSyncStateFile,
  cl: ReturnType<typeof chileWallClockNow>,
  fn: () => Promise<void>
): Promise<void> {
  if (!shouldRunSyncSource(source, stale)) {
    console.log(`sync: ${step} — skip (not stale).`);
    return;
  }
  const errorsBefore = errors.length;
  await runSyncStep(step, errors, fn);
  if (errors.length === errorsBefore) {
    const now = new Date();
    const keepForcedStale =
      (source === "fintual" && isFintualSyncStale(cl, state)) ||
      (source === "stocks_nyse" && isStocksNyseStale(state, { now })) ||
      (source === "yahoo_fx_usd" && isYahooFxUsdStale({ now })) ||
      (source === "crypto_eod" && isCryptoEodStale(cl, state, { now }));
    if (!keepForcedStale) clearUserForcedStale(state, source);
  }
}
