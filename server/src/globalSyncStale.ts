/**
 * Stale checks for external sync sources (no Fintual script imports — safe for `tsc` / in-server use).
 */
import { chileCalendarAddDays, chileWallClockNow, type ChileWallClock } from "./chileDate.js";
import { db } from "./db.js";
import {
  loadGlobalSyncState,
  saveGlobalSyncState,
  type GlobalSyncStateFile,
} from "./globalSyncState.js";
import { loadRootDotenv } from "./rootDotenv.js";

import {
  cryptoEodDueUtcYmd,
  equityCryptoEodCaughtUp,
  equityEodNyseSyncDue,
  equityNyseEodCaughtUp,
} from "./equityEodSync.js";
import { attachSyncSourceSchedule, type SyncSourceDayKind, type SyncWallTime } from "./syncSourceSchedule.js";
import {
  fintualPriorEveningUnresolved,
  fintualPublishLagsPollCalendarDay,
  isFintualFundPublishDay,
} from "./fintualPublishDate.js";
import { fintualCertV2PollReconciled } from "./fintualCertV2Reconcile.js";
import { isChileBusinessDay, priorChileBusinessDayYmd } from "./marketHolidays.js";
import { utcTodayYmd } from "./nyseSession.js";
import { isBcentralConfigured } from "./bcentralApi.js";
import { isYahooFxUsdStale } from "./fxYahooEodSync.js";
import { maxEurDateOnOrBefore, maxFxBcentralDateOnOrBefore, maxUfDate, safeMaxUtmMonthParts } from "./sbifSyncDb.js";
import { isSbifUfStale, isSbifUtmStale } from "./sbifMonthlyPublication.js";

const FINTUAL_RN_COMPOSITION_STALE_DAYS = 30;

export function isFintualRnCompositionStale(cl: ChileWallClock, state: GlobalSyncStateFile): boolean {
  const last = state.fintualRnCompositionLastSyncYmd?.trim();
  if (!last || !/^\d{4}-\d{2}-\d{2}$/.test(last)) return true;
  return cl.ymd >= chileCalendarAddDays(last, FINTUAL_RN_COMPOSITION_STALE_DAYS);
}

export type GlobalSyncSource =
  | "afp_uno"
  | "fintual"
  | "fintual_rn_composition"
  | "sbif_usd"
  | "sbif_eur"
  | "sbif_uf"
  | "sbif_utm"
  | "sbif_ipc"
  | "stocks_nyse"
  | "yahoo_fx_usd"
  | "crypto_eod";

export const GLOBAL_SYNC_SOURCES: readonly GlobalSyncSource[] = [
  "afp_uno",
  "fintual",
  "fintual_rn_composition",
  "sbif_usd",
  "sbif_eur",
  "sbif_uf",
  "sbif_utm",
  "sbif_ipc",
  "stocks_nyse",
  "yahoo_fx_usd",
  "crypto_eod",
] as const;

const LEGACY_EQUITY_EOD_SOURCE = "equity_eod";

export function isGlobalSyncSource(value: string): value is GlobalSyncSource {
  return (GLOBAL_SYNC_SOURCES as readonly string[]).includes(value);
}

/** @deprecated UI/API used `equity_eod` before stocks/crypto split. */
export function isLegacyEquityEodSyncSource(value: string): boolean {
  return value === LEGACY_EQUITY_EOD_SOURCE;
}

function userForcedStaleSet(state: GlobalSyncStateFile): Set<GlobalSyncSource> {
  const out = new Set<GlobalSyncSource>();
  for (const s of state.userForcedStale ?? []) {
    if (isGlobalSyncSource(s)) out.add(s);
  }
  return out;
}

export function clearUserForcedStale(state: GlobalSyncStateFile, source: GlobalSyncSource): void {
  const list = state.userForcedStale;
  if (!list?.length) return;
  const next = list.filter((s) => s !== source);
  if (next.length === list.length) return;
  if (next.length === 0) delete state.userForcedStale;
  else state.userForcedStale = next;
}

/** Mark a source stale from the UI until the next successful sync for that source. */
export function forceSyncSourceStale(source: GlobalSyncSource): GlobalSyncStateFile {
  const state = loadGlobalSyncState();
  const list = state.userForcedStale ?? [];
  if (!list.includes(source)) {
    state.userForcedStale = [...list, source];
    saveGlobalSyncState(state);
  }
  return state;
}

function applyUserForcedStaleToRows(
  rows: SyncSourceStatusRow[],
  state: GlobalSyncStateFile
): SyncSourceStatusRow[] {
  const forced = userForcedStaleSet(state);
  if (forced.size === 0) return rows;
  return rows.map((row) => {
    if (!forced.has(row.source) || row.status === "disabled") return row;
    return { ...row, status: "stale", stale: true };
  });
}

function disabledSyncSources(
  cl: ChileWallClock,
  opts?: { bcentralConfigured?: boolean }
): Set<GlobalSyncSource> {
  const disabled = new Set<GlobalSyncSource>();
  if (afpUnoAccountId() == null) disabled.add("afp_uno");
  const bde = opts?.bcentralConfigured ?? isBcentralConfigured();
  if (!bde) {
    disabled.add("sbif_usd");
    disabled.add("sbif_eur");
    disabled.add("sbif_uf");
    disabled.add("sbif_utm");
    disabled.add("sbif_ipc");
  }
  return disabled;
}

function mergeUserForcedIntoStaleList(
  stale: GlobalSyncSource[],
  state: GlobalSyncStateFile,
  disabled: Set<GlobalSyncSource>
): GlobalSyncSource[] {
  const forced = userForcedStaleSet(state);
  if (forced.size === 0) return stale;
  const out = new Set(stale);
  for (const s of forced) {
    if (!disabled.has(s)) out.add(s);
  }
  return [...out];
}

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
  if (fintualPriorEveningUnresolved(cl, state)) return true;
  if (cl.hour < 18) return false;
  if (!isChileBusinessDay(cl.ymd) && !isFintualFundPublishDay(cl.ymd)) return false;
  if (
    state.fintualLastPublishYmd != null &&
    fintualPublishLagsPollCalendarDay(cl, state.fintualLastPublishYmd)
  ) {
    return true;
  }
  if (
    state.fintualEveningSettledYmd === cl.ymd &&
    state.fintualLastCheckYmd === cl.ymd &&
    state.fintualLastPublishYmd != null &&
    state.fintualLastPublishYmd === state.fintualLastAppliedPublishYmd &&
    state.fintualLastCheckSig != null &&
    state.fintualLastCheckSig === state.fintualLastAppliedSig
  ) {
    const publishYmd = state.fintualLastAppliedPublishYmd ?? cl.ymd;
    if (!fintualCertV2PollReconciled(publishYmd, state)) return true;
    return false;
  }
  if (state.fintualLastCheckYmd !== cl.ymd) return true;
  if (!state.fintualLastAppliedSig) return true;
  if (!state.fintualLastCheckSig) return true;
  if (state.fintualLastCheckSig !== state.fintualLastAppliedSig) return true;
  if (
    state.fintualLastPublishYmd != null &&
    state.fintualLastAppliedPublishYmd != null &&
    state.fintualLastPublishYmd !== state.fintualLastAppliedPublishYmd
  ) {
    return true;
  }
  const publishYmd = state.fintualLastAppliedPublishYmd ?? state.fintualLastPublishYmd ?? cl.ymd;
  if (
    cl.hour >= 18 &&
    state.fintualLastCheckYmd === cl.ymd &&
    state.fintualLastCheckSig != null &&
    state.fintualLastCheckSig === state.fintualLastAppliedSig &&
    !fintualCertV2PollReconciled(publishYmd, state)
  ) {
    return true;
  }
  return false;
}

/** NYSE session EOD missing from `equity_daily` (after 16:05 ET on trading days). */
export function isStocksNyseStale(
  _state: GlobalSyncStateFile,
  opts?: { force?: boolean; now?: Date }
): boolean {
  if (opts?.force) return true;
  const now = opts?.now ?? new Date();
  const nyseDue = equityEodNyseSyncDue(now);
  if (nyseDue != null && !equityNyseEodCaughtUp(nyseDue)) return true;
  return false;
}

/** Crypto daily EOD missing for the UTC day due at 23:55 Chile (carries over until caught up). */
export function isCryptoEodStale(
  cl: ChileWallClock,
  _state: GlobalSyncStateFile,
  opts?: { force?: boolean; now?: Date }
): boolean {
  if (opts?.force) return true;
  const now = opts?.now ?? new Date();
  const due = cryptoEodDueUtcYmd(cl, now);
  return due != null && !equityCryptoEodCaughtUp(due);
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

function naturalStaleSyncSources(
  cl: ChileWallClock,
  state: GlobalSyncStateFile,
  opts?: { force?: boolean; forceSbif?: boolean; bcentralConfigured?: boolean }
): GlobalSyncSource[] {
  const out: GlobalSyncSource[] = [];
  if (isAfpUnoSpotStale(cl, state, opts)) out.push("afp_uno");
  if (isFintualSyncStale(cl, state)) out.push("fintual");
  if (isFintualRnCompositionStale(cl, state)) out.push("fintual_rn_composition");
  const bde = opts?.bcentralConfigured ?? isBcentralConfigured();
  if (bde) {
    if (isSbifObservedFxStale(maxFxBcentralDateOnOrBefore(cl.ymd), cl, state.sbifUsdLastErrorAt)) out.push("sbif_usd");
    if (isSbifObservedFxStale(maxEurDateOnOrBefore(cl.ymd), cl, state.sbifEurLastErrorAt)) out.push("sbif_eur");
    if (cl.day >= 9 || opts?.forceSbif) {
      if (isSbifUfStale(cl, {
        forceSbif: opts?.forceSbif,
        maxUfDate: maxUfDate(),
        lastSyncYmd: state.sbifUfLastSyncYmd,
      })) out.push("sbif_uf");
      if (isSbifUtmStale(cl, { forceSbif: opts?.forceSbif, maxUtm: safeMaxUtmMonthParts() })) {
        out.push("sbif_utm");
      }
      if (isSbifMonthlyStale(cl, state.sbifIpcMonth, opts)) out.push("sbif_ipc");
    }
  }
  if (isStocksNyseStale(state, opts)) out.push("stocks_nyse");
  if (isYahooFxUsdStale(opts)) out.push("yahoo_fx_usd");
  if (isCryptoEodStale(cl, state, opts)) out.push("crypto_eod");
  return out;
}

export function staleSyncSources(
  cl: ChileWallClock,
  state: GlobalSyncStateFile,
  opts?: { force?: boolean; forceSbif?: boolean; bcentralConfigured?: boolean }
): GlobalSyncSource[] {
  loadRootDotenv();
  const natural = naturalStaleSyncSources(cl, state, opts);
  return mergeUserForcedIntoStaleList(natural, state, disabledSyncSources(cl, opts));
}

export type SyncSourceDisplayStatus = "ok" | "stale" | "disabled";

export type SyncSourceStatusRow = {
  source: GlobalSyncSource;
  status: SyncSourceDisplayStatus;
  stale: boolean;
  next_sync: SyncWallTime | null;
  next_sync_imminent: boolean;
  today_day_kind: SyncSourceDayKind;
};

function syncSourceRow(
  source: GlobalSyncSource,
  cl: ChileWallClock,
  status: SyncSourceDisplayStatus,
  stale: boolean
): SyncSourceStatusRow {
  const sched = attachSyncSourceSchedule(source, cl, stale, status === "disabled");
  return {
    source,
    status,
    stale,
    next_sync: sched.next_sync,
    next_sync_imminent: sched.next_sync_imminent,
    today_day_kind: sched.today_day_kind,
  };
}

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
    rows.push(syncSourceRow("afp_uno", cl, "disabled", false));
  } else {
    const stale = isAfpUnoSpotStale(cl, state, { force });
    rows.push(syncSourceRow("afp_uno", cl, stale ? "stale" : "ok", stale));
  }

  {
    const stale = isFintualSyncStale(cl, state);
    rows.push(syncSourceRow("fintual", cl, stale ? "stale" : "ok", stale));
  }

  {
    const stale = isFintualRnCompositionStale(cl, state);
    rows.push(syncSourceRow("fintual_rn_composition", cl, stale ? "stale" : "ok", stale));
  }

  const sbifFx = (source: "sbif_usd" | "sbif_eur", maxYmd: string | null, lastErrorAt?: string) => {
    if (!bde) {
      rows.push(syncSourceRow(source, cl, "disabled", false));
      return;
    }
    const stale = isSbifObservedFxStale(maxYmd, cl, lastErrorAt);
    rows.push(syncSourceRow(source, cl, stale ? "stale" : "ok", stale));
  };
  sbifFx("sbif_usd", maxFxBcentralDateOnOrBefore(cl.ymd), state.sbifUsdLastErrorAt);
  sbifFx("sbif_eur", maxEurDateOnOrBefore(cl.ymd), state.sbifEurLastErrorAt);

  const sbifUfRow = (source: "sbif_uf") => {
    if (!bde) {
      rows.push(syncSourceRow(source, cl, "disabled", false));
      return;
    }
    const stale =
      cl.day >= 9 || forceSbif
        ? isSbifUfStale(cl, {
            forceSbif,
            maxUfDate: maxUfDate(),
            lastSyncYmd: state.sbifUfLastSyncYmd,
          })
        : false;
    rows.push(syncSourceRow(source, cl, stale ? "stale" : "ok", stale));
  };
  sbifUfRow("sbif_uf");

  const sbifUtmRow = (source: "sbif_utm") => {
    if (!bde) {
      rows.push(syncSourceRow(source, cl, "disabled", false));
      return;
    }
    const stale =
      cl.day >= 9 || forceSbif
        ? isSbifUtmStale(cl, { forceSbif, maxUtm: safeMaxUtmMonthParts() })
        : false;
    rows.push(syncSourceRow(source, cl, stale ? "stale" : "ok", stale));
  };
  sbifUtmRow("sbif_utm");

  const sbifMonthly = (source: "sbif_ipc", syncedMonth: string | undefined) => {
    if (!bde) {
      rows.push(syncSourceRow(source, cl, "disabled", false));
      return;
    }
    const stale = cl.day >= 9 || forceSbif ? isSbifMonthlyStale(cl, syncedMonth, { forceSbif }) : false;
    rows.push(syncSourceRow(source, cl, stale ? "stale" : "ok", stale));
  };
  sbifMonthly("sbif_ipc", state.sbifIpcMonth);

  {
    const stale = isStocksNyseStale(state, { force });
    rows.push(syncSourceRow("stocks_nyse", cl, stale ? "stale" : "ok", stale));
  }

  {
    const stale = isYahooFxUsdStale({ force });
    rows.push(syncSourceRow("yahoo_fx_usd", cl, stale ? "stale" : "ok", stale));
  }

  {
    const stale = isCryptoEodStale(cl, state, { force });
    rows.push(syncSourceRow("crypto_eod", cl, stale ? "stale" : "ok", stale));
  }

  return applyUserForcedStaleToRows(rows, state);
}

export function syncStatusPayload(): {
  chile: ChileWallClock;
  state: GlobalSyncStateFile;
  stale: GlobalSyncSource[];
  sources: SyncSourceStatusRow[];
} {
  const cl = chileWallClockNow();
  const state = loadGlobalSyncState();
  const sources = allSyncSourceStatuses(cl, state);
  const stale = sources.filter((r) => r.stale).map((r) => r.source);
  return {
    chile: cl,
    state,
    stale,
    sources,
  };
}
