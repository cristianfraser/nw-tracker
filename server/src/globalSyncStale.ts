/**
 * Stale checks for external sync sources (no Fintual script imports — safe for `tsc` / in-server use).
 */
import { chileWallClockNow, type ChileWallClock } from "./chileDate.js";
import { db } from "./db.js";
import { loadGlobalSyncState, type GlobalSyncStateFile } from "./globalSyncState.js";
import { loadRootDotenv } from "./rootDotenv.js";

export type GlobalSyncSource = "afp_uno" | "fintual" | "sbif_uf" | "sbif_utm" | "sbif_ipc";

function afpUnoAccountId(): number | null {
  const row = db
    .prepare(`SELECT id FROM accounts WHERE notes = 'import:excel|key=afp'`)
    .get() as { id: number } | undefined;
  return row?.id ?? null;
}

export function isAfpUnoSpotStale(
  cl: ChileWallClock,
  state: GlobalSyncStateFile,
  opts?: { force?: boolean }
): boolean {
  if (opts?.force) return afpUnoAccountId() != null;
  if (afpUnoAccountId() == null) return false;
  return state.unoLastSpotYmd !== cl.ymd;
}

/**
 * After 18:00 Chile, Fintual stays stale until evening catch-up is done (yesterday + today rows match API)
 * or we are still polling. A check signature **different** from last applied must stay stale (do not stop
 * polling when the API moved but DB apply was skipped).
 */
export function isFintualSyncStale(cl: ChileWallClock, state: GlobalSyncStateFile): boolean {
  if (cl.hour < 18) return false;
  if (state.fintualEveningSettledYmd === cl.ymd) return false;
  if (state.fintualLastCheckYmd !== cl.ymd) return true;
  if (!state.fintualLastAppliedSig) return true;
  if (!state.fintualLastCheckSig) return true;
  if (state.fintualLastCheckSig !== state.fintualLastAppliedSig) return true;
  return true;
}

export function isSbifMonthlyStale(
  cl: ChileWallClock,
  syncedMonth: string | undefined,
  opts?: { forceSbif?: boolean }
): boolean {
  if (opts?.forceSbif) return true;
  if (cl.day < 9) return false;
  return syncedMonth !== cl.monthKey;
}

export function staleSyncSources(
  cl: ChileWallClock,
  state: GlobalSyncStateFile,
  opts?: { force?: boolean; forceSbif?: boolean; sbifApiKey?: string }
): GlobalSyncSource[] {
  loadRootDotenv();
  const out: GlobalSyncSource[] = [];
  if (isAfpUnoSpotStale(cl, state, opts)) out.push("afp_uno");
  if (isFintualSyncStale(cl, state)) out.push("fintual");
  const apiKey = opts?.sbifApiKey ?? process.env.SBIF_APIKEY?.trim() ?? "";
  if (apiKey && (cl.day >= 9 || opts?.forceSbif)) {
    if (isSbifMonthlyStale(cl, state.sbifUfMonth, opts)) out.push("sbif_uf");
    if (isSbifMonthlyStale(cl, state.sbifUtmMonth, opts)) out.push("sbif_utm");
    if (isSbifMonthlyStale(cl, state.sbifIpcMonth, opts)) out.push("sbif_ipc");
  }
  return out;
}

export function syncStatusPayload(): {
  chile: ChileWallClock;
  state: GlobalSyncStateFile;
  stale: GlobalSyncSource[];
} {
  const cl = chileWallClockNow();
  const state = loadGlobalSyncState();
  return { chile: cl, state, stale: staleSyncSources(cl, state) };
}
