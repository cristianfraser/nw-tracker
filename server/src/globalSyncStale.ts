/**
 * Stale checks for external sync sources (no Fintual script imports — safe for `tsc` / in-server use).
 */
import { type ChileWallClock, chileCalendarAddDays, chileWallClockNow } from "./chileDate.js";
import { db } from "./db.js";
import {
  loadGlobalSyncState,
  saveGlobalSyncState,
  type GlobalSyncStateFile,
} from "./globalSyncState.js";
import { loadRootDotenv } from "./rootDotenv.js";
import {
  AFC_CIC_PUBLISH_HOUR_CHILE,
  afcCicAccountIds,
  afcCicExpectedYmd,
  isAfcCicStale,
  latestAfcCicRow,
} from "./afcCicSeries.js";

import {
  cryptoEodDueUtcYmd,
  equityCryptoEodCaughtUp,
  equityEodNyseSyncDue,
  equityEodSantiagoSyncDue,
  equityNyseEodCaughtUp,
  equitySantiagoEodCaughtUp,
} from "./equityEodSync.js";
import {
  attachSyncSourceSchedule,
  FINTUAL_RN_COMPOSITION_SYNC_HOUR_CHILE,
  FINTUAL_RN_COMPOSITION_SYNC_MINUTE_CHILE,
  isFintualRnCompositionDueDay,
  type SyncSourceDayKind,
  type SyncWallTime,
} from "./syncSourceSchedule.js";
import {
  FINTUAL_PUBLISH_HOUR_CHILE,
  fintualPriorEveningUnresolved,
  fintualPublishLagsPollCalendarDay,
  isFintualFundPublishDay,
} from "./fintualPublishDate.js";
import {
  fintualCertV2AnyHeldFundMissingDayRow,
  fintualCertV2PollReconciled,
  fintualMorningCarryPerFundUnresolved,
} from "./fintualCertV2Reconcile.js";
import fs from "node:fs";
import { fintualGoalsSnapshotPath } from "../scripts/fintualApiLib.js";
import { isChileBusinessDay, priorChileBusinessDayYmd } from "./marketHolidays.js";
import { isBcentralConfigured } from "./bcentralApi.js";
import { isYahooFxUsdStale } from "./fxYahooEodSync.js";
import {
  maxEurDateOnOrBefore,
  maxFxBcentralDateOnOrBefore,
  maxUfDate,
  safeMaxUtmMonthParts,
} from "./sbifSyncDb.js";
import { isSbifUfStale, isSbifUtmStale } from "./sbifMonthlyPublication.js";

/**
 * Due once per due day (`isFintualRnCompositionDueDay`: a Chile business day or the day after one)
 * from 18:30: stale until that day's composition sync ran. A Sunday or a holiday after a weekend
 * is never stale (nothing newly published to anchor on), and re-running when the composition is
 * unchanged is fine — the sync re-anchors on the same day and re-stamps `fintualRnCompositionLastSyncYmd`.
 */
export function isFintualRnCompositionStale(cl: ChileWallClock, state: GlobalSyncStateFile): boolean {
  if (!isFintualRnCompositionDueDay(cl.ymd)) return false;
  const dueMins = FINTUAL_RN_COMPOSITION_SYNC_HOUR_CHILE * 60 + FINTUAL_RN_COMPOSITION_SYNC_MINUTE_CHILE;
  if (cl.hour * 60 + cl.minute < dueMins) return false;
  return state.fintualRnCompositionLastSyncYmd?.trim() !== cl.ymd;
}

export type GlobalSyncSource =
  | "afp_uno"
  | "afc_cic"
  | "fintual"
  | "fintual_rn_composition"
  | "sbif_usd"
  | "sbif_eur"
  | "sbif_uf"
  | "sbif_utm"
  | "sbif_ipc"
  | "stocks_nyse"
  | "stocks_santiago"
  | "yahoo_fx_usd"
  | "crypto_eod";

export const GLOBAL_SYNC_SOURCES: readonly GlobalSyncSource[] = [
  "afp_uno",
  "afc_cic",
  "fintual",
  "fintual_rn_composition",
  "sbif_usd",
  "sbif_eur",
  "sbif_uf",
  "sbif_utm",
  "sbif_ipc",
  "stocks_nyse",
  "stocks_santiago",
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

/** User marked this source stale from the UI (flag not yet cleared by a successful sync). */
export function isUserForcedSyncSourceStale(
  state: GlobalSyncStateFile,
  source: GlobalSyncSource
): boolean {
  return userForcedStaleSet(state).has(source);
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
  if (afcCicAccountIds().length === 0) disabled.add("afc_cic");
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
    .prepare(`SELECT id FROM accounts WHERE import_key = 'import:excel|key=afp'`)
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
  // Sig/publish-date "caught up" is blind to a single late-publishing fund (global hints are the
  // max across funds): a held v2 fund whose publish-day bar is still missing keeps the source
  // stale so the morning carry lands the value the fund published overnight.
  if (fintualMorningCarryPerFundUnresolved(cl, state)) return true;
  if (cl.hour < FINTUAL_PUBLISH_HOUR_CHILE) return false;
  if (!isChileBusinessDay(cl.ymd) && !isFintualFundPublishDay(cl.ymd)) return false;
  if (
    state.fintualLastPublishYmd != null &&
    fintualPublishLagsPollCalendarDay(cl, state.fintualLastPublishYmd)
  ) {
    return true;
  }
  // A cuota for today that is already applied — Fintual forward-publishes a holiday block's
  // flat carries days early (2026-09-17 published through Sunday 09-20) — leaves nothing for a
  // same-day poll to fetch: the source is fresh while the last poll's signature is what we
  // applied and the positions reconcile. Demanding the poll anyway dimmed every Fintual account
  // from Sunday 18:00 on, with no wake even scheduled (see `syncSourceSchedule` «fintual»).
  if (
    state.fintualLastAppliedPublishYmd != null &&
    state.fintualLastAppliedPublishYmd >= cl.ymd &&
    state.fintualLastPublishYmd === state.fintualLastAppliedPublishYmd &&
    state.fintualLastCheckSig != null &&
    state.fintualLastCheckSig === state.fintualLastAppliedSig
  ) {
    return !fintualCertV2PollReconciled(state.fintualLastAppliedPublishYmd, state);
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
    cl.hour >= FINTUAL_PUBLISH_HOUR_CHILE &&
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

/**
 * Bolsa de Santiago EOD missing for the due Chile session (`equityEodSantiagoSyncDue`: today from
 * 17:10 Chile, else the last closed Chile session — carries over until the bar lands).
 */
export function isStocksSantiagoStale(
  _state: GlobalSyncStateFile,
  opts?: { force?: boolean; now?: Date }
): boolean {
  if (opts?.force) return true;
  const now = opts?.now ?? new Date();
  const due = equityEodSantiagoSyncDue(now);
  return due != null && !equitySantiagoEodCaughtUp(due);
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
  if (isAfcCicStale(cl, state, opts)) out.push("afc_cic");
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
  if (isStocksSantiagoStale(state, opts)) out.push("stocks_santiago");
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

/**
 * A stale source whose only missing piece is the PUBLISHER's next day: our poll ran recently and
 * holds everything the API offers, the API just has not published the expected cuota yet.
 */
export type SyncPublisherLag = {
  /** The first publish day the source is waiting for. */
  expected_ymd: string;
  /** The publisher's latest cuota day as of the last poll. */
  published_ymd: string;
  /** When the last poll ran (ISO). */
  last_checked_at: string;
};

export type SyncSourceStatusRow = {
  source: GlobalSyncSource;
  status: SyncSourceDisplayStatus;
  stale: boolean;
  /** Set when `stale` is the publisher's lag, not ours (see `fintualPublisherLag`). */
  publisher_lag: SyncPublisherLag | null;
  next_sync: SyncWallTime | null;
  next_sync_imminent: boolean;
  today_day_kind: SyncSourceDayKind;
};

function syncSourceRow(
  source: GlobalSyncSource,
  cl: ChileWallClock,
  status: SyncSourceDisplayStatus,
  stale: boolean,
  state: GlobalSyncStateFile
): SyncSourceStatusRow {
  const sched = attachSyncSourceSchedule(source, cl, stale, status === "disabled", {
    fintualAppliedPublishYmd: state.fintualLastAppliedPublishYmd ?? null,
    afcCicLatestDay: source === "afc_cic" ? (latestAfcCicRow()?.day ?? null) : null,
  });
  return {
    source,
    status,
    stale,
    publisher_lag: null,
    next_sync: sched.next_sync,
    next_sync_imminent: sched.next_sync_imminent,
    today_day_kind: sched.today_day_kind,
  };
}

/**
 * How old a source's last poll may be for its staleness to still count as the publisher's lag.
 * The scheduler polls every 15 minutes while any source is stale; two intervals is one missed
 * tick of slack. Older than that, the poll itself is what is missing and we are the ones behind.
 */
export const PUBLISHER_LAG_MAX_POLL_AGE_MS = 30 * 60 * 1000;

/** `fetchedAt` of the goals snapshot `runFintual` writes on every poll — null when none exists. */
export function readFintualLastCheckedAt(): string | null {
  const file = fintualGoalsSnapshotPath();
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { fetchedAt?: unknown };
    return typeof parsed.fetchedAt === "string" && Number.isFinite(Date.parse(parsed.fetchedAt))
      ? parsed.fetchedAt
      : null;
  } catch {
    return null;
  }
}

/**
 * Classify a stale Fintual source as the PUBLISHER's lag — or null when we are the ones behind.
 *
 * `isFintualSyncStale` deliberately keeps the source stale (and the scheduler polling) while the
 * cuota expected for a publish day has not appeared, so that the morning carry lands whatever the
 * fund publishes overnight (2026-08-24). But every consumer read that flag as "the app failed to
 * sync": the notifications panel badged it and the dashboard dimmed every Fintual account at 38%
 * opacity — on 2026-09-15 with Monday's cuota simply not published by Fintual yet, the poll running
 * every 15 minutes, and the APV cards showing the live proxy. This is lag on the publisher's side
 * when: the last poll is recent (`PUBLISHER_LAG_MAX_POLL_AGE_MS`), nobody forced a run by
 * hand, the API's latest published day is behind the first publish day we expect, and every held
 * fund's bar for that published day is in the DB (a missing bar means our write is what failed).
 * Anything else — sig mismatch, unreconciled positions, a missed poll — stays plain stale.
 */
export function fintualPublisherLag(
  cl: ChileWallClock,
  state: GlobalSyncStateFile,
  opts: { lastCheckedAt: string | null; nowMs: number }
): SyncPublisherLag | null {
  if (!isFintualSyncStale(cl, state)) return null;
  if (isUserForcedSyncSourceStale(state, "fintual")) return null;
  const published = state.fintualLastPublishYmd?.trim();
  if (!published || !/^\d{4}-\d{2}-\d{2}$/.test(published)) return null;
  // The first publish day after the published one, capped at the day the source is waiting on
  // (the carried poll day before 18:00, today after).
  const cap = cl.hour < FINTUAL_PUBLISH_HOUR_CHILE ? state.fintualLastCheckYmd : cl.ymd;
  if (!cap) return null;
  let expected = chileCalendarAddDays(published, 1);
  for (let i = 0; i < 14 && expected <= cap && !isFintualFundPublishDay(expected); i++) {
    expected = chileCalendarAddDays(expected, 1);
  }
  if (expected > cap) return null;
  if (fintualCertV2AnyHeldFundMissingDayRow(published, state)) return null;
  const checkedMs = opts.lastCheckedAt ? Date.parse(opts.lastCheckedAt) : NaN;
  if (!Number.isFinite(checkedMs) || opts.nowMs - checkedMs > PUBLISHER_LAG_MAX_POLL_AGE_MS) {
    return null;
  }
  return { expected_ymd: expected, published_ymd: published, last_checked_at: opts.lastCheckedAt as string };
}

/**
 * Classify a stale AFC CIC source as the PUBLISHER's lag — or null when we are the ones behind.
 *
 * `isAfcCicStale` waits on the last Chile business day's valor cuota from noon the day after, and
 * the Superintendencia de Pensiones is sometimes days late printing it: on 2026-10-05 its CSV still
 * ended at Thursday 10-01 while every 15-minute poll since Saturday noon read the whole year
 * unchanged, and the sync panel called that «stale» like a failed fetch. This is lag on the
 * publisher's side when: nobody forced a run, the last fetch is recent
 * (`PUBLISHER_LAG_MAX_POLL_AGE_MS`), the DB holds the last day the CSV printed (else our write is
 * what failed), and that day is still before the expected one.
 */
export function afcCicPublisherLag(
  cl: ChileWallClock,
  state: GlobalSyncStateFile,
  opts: { latestDbDay: string | null; nowMs: number }
): SyncPublisherLag | null {
  if (isUserForcedSyncSourceStale(state, "afc_cic")) return null;
  const published = state.afcCicLastPublishedYmd?.trim();
  if (!published || !/^\d{4}-\d{2}-\d{2}$/.test(published)) return null;
  if (opts.latestDbDay == null || opts.latestDbDay < published) return null;
  const expected = afcCicExpectedYmd(cl.ymd);
  if (published >= expected) return null;
  const checkedAt = state.afcCicLastCheckedAt ?? null;
  const checkedMs = checkedAt ? Date.parse(checkedAt) : NaN;
  if (!Number.isFinite(checkedMs) || opts.nowMs - checkedMs > PUBLISHER_LAG_MAX_POLL_AGE_MS) return null;
  return { expected_ymd: expected, published_ymd: published, last_checked_at: checkedAt as string };
}

/** The Chile hour from which a source's publisher lag counts as overdue (see `staleDimmingSources`). */
function publisherLagOverdueHourChile(source: GlobalSyncSource): number {
  return source === "afc_cic" ? AFC_CIC_PUBLISH_HOUR_CHILE : FINTUAL_PUBLISH_HOUR_CHILE;
}

/**
 * Sources whose accounts dim at `cl`. Our own staleness (a missed or failed poll, a due sync not
 * yet run, a signature mismatch, a forced run) always dims. A publisher's lag dims only once the
 * cuota is OVERDUE — from the source's publish hour (Fintual 18:00, AFC 12:00) until it lands;
 * before that the display holds everything the publisher has (pre-open, the live proxy, the
 * post-close hold), so nothing is behind (2026-09-21). The window is wall-clock: a cuota still
 * missing at midnight reads normal again from 00:00 and dims from the publish hour the next day,
 * until it is applied.
 */
export function staleDimmingSources(rows: SyncSourceStatusRow[], cl: ChileWallClock): GlobalSyncSource[] {
  return rows
    .filter((r) => r.stale && (r.publisher_lag == null || cl.hour >= publisherLagOverdueHourChile(r.source)))
    .map((r) => r.source);
}

export function allSyncSourceStatuses(
  cl: ChileWallClock,
  state: GlobalSyncStateFile,
  opts?: {
    force?: boolean;
    forceSbif?: boolean;
    bcentralConfigured?: boolean;
    /** Last Fintual poll (ISO); undefined reads the goals snapshot, null means "never". */
    fintualLastCheckedAt?: string | null;
    nowMs?: number;
  }
): SyncSourceStatusRow[] {
  loadRootDotenv();
  const bde = opts?.bcentralConfigured ?? isBcentralConfigured();
  const force = opts?.force;
  const forceSbif = opts?.forceSbif;

  const rows: SyncSourceStatusRow[] = [];

  const afpId = afpUnoAccountId();
  if (afpId == null) {
    rows.push(syncSourceRow("afp_uno", cl, "disabled", false, state));
  } else {
    const stale = isAfpUnoSpotStale(cl, state, { force });
    rows.push(syncSourceRow("afp_uno", cl, stale ? "stale" : "ok", stale, state));
  }

  if (afcCicAccountIds().length === 0) {
    rows.push(syncSourceRow("afc_cic", cl, "disabled", false, state));
  } else {
    const stale = isAfcCicStale(cl, state, { force });
    const row = syncSourceRow("afc_cic", cl, stale ? "stale" : "ok", stale, state);
    if (stale && !force) {
      row.publisher_lag = afcCicPublisherLag(cl, state, {
        latestDbDay: latestAfcCicRow()?.day ?? null,
        nowMs: opts?.nowMs ?? Date.now(),
      });
    }
    rows.push(row);
  }

  {
    const stale = isFintualSyncStale(cl, state);
    const row = syncSourceRow("fintual", cl, stale ? "stale" : "ok", stale, state);
    if (stale) {
      row.publisher_lag = fintualPublisherLag(cl, state, {
        lastCheckedAt:
          opts?.fintualLastCheckedAt === undefined ? readFintualLastCheckedAt() : opts.fintualLastCheckedAt,
        nowMs: opts?.nowMs ?? Date.now(),
      });
    }
    rows.push(row);
  }

  {
    const stale = isFintualRnCompositionStale(cl, state);
    rows.push(syncSourceRow("fintual_rn_composition", cl, stale ? "stale" : "ok", stale, state));
  }

  const sbifFx = (source: "sbif_usd" | "sbif_eur", maxYmd: string | null, lastErrorAt?: string) => {
    if (!bde) {
      rows.push(syncSourceRow(source, cl, "disabled", false, state));
      return;
    }
    const stale = isSbifObservedFxStale(maxYmd, cl, lastErrorAt);
    rows.push(syncSourceRow(source, cl, stale ? "stale" : "ok", stale, state));
  };
  sbifFx("sbif_usd", maxFxBcentralDateOnOrBefore(cl.ymd), state.sbifUsdLastErrorAt);
  sbifFx("sbif_eur", maxEurDateOnOrBefore(cl.ymd), state.sbifEurLastErrorAt);

  const sbifUfRow = (source: "sbif_uf") => {
    if (!bde) {
      rows.push(syncSourceRow(source, cl, "disabled", false, state));
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
    rows.push(syncSourceRow(source, cl, stale ? "stale" : "ok", stale, state));
  };
  sbifUfRow("sbif_uf");

  const sbifUtmRow = (source: "sbif_utm") => {
    if (!bde) {
      rows.push(syncSourceRow(source, cl, "disabled", false, state));
      return;
    }
    const stale =
      cl.day >= 9 || forceSbif
        ? isSbifUtmStale(cl, { forceSbif, maxUtm: safeMaxUtmMonthParts() })
        : false;
    rows.push(syncSourceRow(source, cl, stale ? "stale" : "ok", stale, state));
  };
  sbifUtmRow("sbif_utm");

  const sbifMonthly = (source: "sbif_ipc", syncedMonth: string | undefined) => {
    if (!bde) {
      rows.push(syncSourceRow(source, cl, "disabled", false, state));
      return;
    }
    const stale = cl.day >= 9 || forceSbif ? isSbifMonthlyStale(cl, syncedMonth, { forceSbif }) : false;
    rows.push(syncSourceRow(source, cl, stale ? "stale" : "ok", stale, state));
  };
  sbifMonthly("sbif_ipc", state.sbifIpcMonth);

  {
    const stale = isStocksNyseStale(state, { force });
    rows.push(syncSourceRow("stocks_nyse", cl, stale ? "stale" : "ok", stale, state));
  }

  {
    const stale = isStocksSantiagoStale(state, { force });
    rows.push(syncSourceRow("stocks_santiago", cl, stale ? "stale" : "ok", stale, state));
  }

  {
    const stale = isYahooFxUsdStale({ force });
    rows.push(syncSourceRow("yahoo_fx_usd", cl, stale ? "stale" : "ok", stale, state));
  }

  {
    const stale = isCryptoEodStale(cl, state, { force });
    rows.push(syncSourceRow("crypto_eod", cl, stale ? "stale" : "ok", stale, state));
  }

  return applyUserForcedStaleToRows(rows, state);
}

export function syncStatusPayload(): {
  chile: ChileWallClock;
  state: GlobalSyncStateFile;
  /** Every stale source — what the scheduler keeps polling. */
  stale: GlobalSyncSource[];
  /**
   * The sources whose accounts the dashboard dims right now (`staleDimmingSources`): every stale
   * source whose staleness is ours, plus a source waiting on its publisher once the cuota is
   * overdue (from its publish hour: Fintual 18:00, AFC 12:00). Before that hour a publisher-lag source holds
   * everything the publisher has, so its accounts are not behind anything.
   */
  stale_dimming: GlobalSyncSource[];
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
    stale_dimming: staleDimmingSources(sources, cl),
    sources,
  };
}
