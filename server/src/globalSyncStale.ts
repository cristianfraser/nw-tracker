/**
 * Stale checks for external sync sources (no Fintual script imports — safe for `tsc` / in-server use).
 */
import { chileWallClockNow, type ChileWallClock } from "./chileDate.js";
import { db } from "./db.js";
import { loadGlobalSyncState, type GlobalSyncStateFile } from "./globalSyncState.js";
import { loadRootDotenv } from "./rootDotenv.js";

import { isAfterNyseRegularClose, nyseSessionYmd, nyseWallClock } from "./nyseSession.js";
import { isChileBusinessDay, isNyseTradingDay, priorChileBusinessDayYmd } from "./marketHolidays.js";
import { utcTodayYmd } from "./nyseSession.js";
import { isBcentralConfigured } from "./bcentralApi.js";
import { maxEurDateOnOrBefore, maxFxDateOnOrBefore } from "./sbifSyncDb.js";

export type GlobalSyncSource =
  | "afp_uno"
  | "fintual"
  | "sbif_usd"
  | "sbif_eur"
  | "sbif_uf"
  | "sbif_utm"
  | "sbif_ipc"
  | "equity_eod";

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
  if (!isChileBusinessDay(cl.ymd)) return false;
  return state.unoLastSpotYmd !== cl.ymd;
}

/**
 * After 18:00 Chile, Fintual is stale until today's poll ran and mapped NAV matches what we last applied.
 * If the check signature differs from last applied, stay stale (API moved but DB was not updated).
 */
export function isFintualSyncStale(cl: ChileWallClock, state: GlobalSyncStateFile): boolean {
  if (cl.hour < 18) return false;
  if (!isChileBusinessDay(cl.ymd)) return false;
  if (state.fintualEveningSettledYmd === cl.ymd) return false;
  if (state.fintualLastCheckYmd !== cl.ymd) return true;
  if (!state.fintualLastAppliedSig) return true;
  if (!state.fintualLastCheckSig) return true;
  if (state.fintualLastCheckSig !== state.fintualLastAppliedSig) return true;
  return false;
}

export function isEquityEodStale(
  state: GlobalSyncStateFile,
  opts?: { force?: boolean; now?: Date }
): boolean {
  if (opts?.force) return true;
  const now = opts?.now ?? new Date();
  const ny = nyseWallClock(now);
  if (isNyseTradingDay(ny.ymd) && isAfterNyseRegularClose(now)) {
    const session = nyseSessionYmd(now);
    if (state.equityEodLastNySessionYmd !== session) return true;
  }
  const utc = utcTodayYmd(now);
  if (state.equityEodLastCryptoUtcYmd !== utc) return true;
  return false;
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

/** Chile hour (inclusive) from which same-calendar-day dólar/euro observado is expected in DB. */
export const BCENTRAL_OBSERVED_FX_STALE_AFTER_HOUR = 18;

/**
 * Banco Central dólar / euro observado: not stale before {@link BCENTRAL_OBSERVED_FX_STALE_AFTER_HOUR}:00 Chile
 * (today's tipo de cambio is published at day close). After that hour, stale until `maxOnOrBeforeToday >= cl.ymd`,
 * or while the last post-18:00 fetch failed.
 */
/** Latest Banco Central dólar/euro observado date we expect in DB for this Chile wall clock. */
export function expectedSbifObservedFxYmd(cl: ChileWallClock): string {
  if (isChileBusinessDay(cl.ymd)) return cl.ymd;
  return priorChileBusinessDayYmd(cl.ymd) ?? cl.ymd;
}

export function isSbifObservedFxStale(
  maxOnOrBeforeToday: string | null,
  cl: ChileWallClock,
  lastErrorAt?: string
): boolean {
  const expected = expectedSbifObservedFxYmd(cl);
  if (!maxOnOrBeforeToday) return true;
  if (cl.hour < BCENTRAL_OBSERVED_FX_STALE_AFTER_HOUR) return false;
  if (maxOnOrBeforeToday >= expected) return false;
  if (lastErrorAt && isChileBusinessDay(cl.ymd)) return true;
  return maxOnOrBeforeToday < expected;
}

/** Whether `runGlobalSyncAll` should run the sync step for this source (matches log `Stale:` list). */
export function shouldRunSyncSource(
  source: GlobalSyncSource,
  stale: readonly GlobalSyncSource[]
): boolean {
  return stale.includes(source);
}

export function staleSyncSources(
  cl: ChileWallClock,
  state: GlobalSyncStateFile,
  opts?: { force?: boolean; forceSbif?: boolean; bcentralConfigured?: boolean }
): GlobalSyncSource[] {
  loadRootDotenv();
  const out: GlobalSyncSource[] = [];
  if (isAfpUnoSpotStale(cl, state, opts)) out.push("afp_uno");
  if (isFintualSyncStale(cl, state)) out.push("fintual");
  const bde = opts?.bcentralConfigured ?? isBcentralConfigured();
  if (bde) {
    if (isSbifObservedFxStale(maxFxDateOnOrBefore(cl.ymd), cl, state.sbifUsdLastErrorAt)) out.push("sbif_usd");
    if (isSbifObservedFxStale(maxEurDateOnOrBefore(cl.ymd), cl, state.sbifEurLastErrorAt)) out.push("sbif_eur");
    if (cl.day >= 9 || opts?.forceSbif) {
      if (isSbifMonthlyStale(cl, state.sbifUfMonth, opts)) out.push("sbif_uf");
      if (isSbifMonthlyStale(cl, state.sbifUtmMonth, opts)) out.push("sbif_utm");
      if (isSbifMonthlyStale(cl, state.sbifIpcMonth, opts)) out.push("sbif_ipc");
    }
  }
  if (isEquityEodStale(state, opts)) out.push("equity_eod");
  return out;
}

export type SyncSourceDisplayStatus = "ok" | "stale" | "disabled";

export type SyncSourceStatusRow = {
  source: GlobalSyncSource;
  status: SyncSourceDisplayStatus;
  stale: boolean;
};

export function allSyncSourceStatuses(
  cl: ChileWallClock,
  state: GlobalSyncStateFile,
  opts?: { force?: boolean; forceSbif?: boolean; bcentralConfigured?: boolean }
): SyncSourceStatusRow[] {
  loadRootDotenv();
  const bde = opts?.bcentralConfigured ?? isBcentralConfigured();
  const force = opts?.force;
  const forceSbif = opts?.forceSbif;

  const rows: SyncSourceStatusRow[] = [];

  const afpId = afpUnoAccountId();
  if (afpId == null) {
    rows.push({ source: "afp_uno", status: "disabled", stale: false });
  } else {
    const stale = isAfpUnoSpotStale(cl, state, { force });
    rows.push({ source: "afp_uno", status: stale ? "stale" : "ok", stale });
  }

  {
    const stale = cl.hour >= 18 && isFintualSyncStale(cl, state);
    rows.push({ source: "fintual", status: stale ? "stale" : "ok", stale });
  }

  const sbifFx = (source: "sbif_usd" | "sbif_eur", maxYmd: string | null, lastErrorAt?: string) => {
    if (!bde) {
      rows.push({ source, status: "disabled", stale: false });
      return;
    }
    const stale = isSbifObservedFxStale(maxYmd, cl, lastErrorAt);
    rows.push({ source, status: stale ? "stale" : "ok", stale });
  };
  sbifFx("sbif_usd", maxFxDateOnOrBefore(cl.ymd), state.sbifUsdLastErrorAt);
  sbifFx("sbif_eur", maxEurDateOnOrBefore(cl.ymd), state.sbifEurLastErrorAt);

  const sbifMonthly = (source: "sbif_uf" | "sbif_utm" | "sbif_ipc", syncedMonth: string | undefined) => {
    if (!bde) {
      rows.push({ source, status: "disabled", stale: false });
      return;
    }
    const stale = cl.day >= 9 || forceSbif ? isSbifMonthlyStale(cl, syncedMonth, { forceSbif }) : false;
    rows.push({ source, status: stale ? "stale" : "ok", stale });
  };
  sbifMonthly("sbif_uf", state.sbifUfMonth);
  sbifMonthly("sbif_utm", state.sbifUtmMonth);
  sbifMonthly("sbif_ipc", state.sbifIpcMonth);

  {
    const stale = isEquityEodStale(state, { force });
    rows.push({ source: "equity_eod", status: stale ? "stale" : "ok", stale });
  }

  return rows;
}

export function syncStatusPayload(): {
  chile: ChileWallClock;
  state: GlobalSyncStateFile;
  stale: GlobalSyncSource[];
  sources: SyncSourceStatusRow[];
} {
  const cl = chileWallClockNow();
  const state = loadGlobalSyncState();
  const stale = staleSyncSources(cl, state);
  return {
    chile: cl,
    state,
    stale,
    sources: allSyncSourceStatuses(cl, state),
  };
}
