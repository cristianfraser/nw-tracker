/**
 * The global sync's sources as one table (`SYNC_SOURCES`, 2026-11-07, docs/untangle-plan.md F14):
 * for each source, whether it is configured, its stale rule, its publisher's lag, when it is due
 * next and how a forced run is cleared. The status rows, the scheduler's stale list, the dimming
 * list and the schedule are all read from it. The ids live in `syncSourceIds.ts`, the per-source
 * stale predicates below and in each source's module, the wake times in `syncSourceSchedule.ts`.
 * No Fintual script imports — safe for `tsc` / in-server use.
 */
import { deploymentProfile } from "./config.js";
import { afpUnoPublisher, isAfpUnoOfficialStale, latestOfficialUnoDay } from "./afpUnoOfficialSync.js";
import { type ChileWallClock, chileCalendarAddDays, chileWallClockNow } from "./chileDate.js";
import { afpUnoAccountIds, liveAfpUnoAccountId } from "./afpAccounts.js";
import { isCmfRnPortfolioStale } from "./cmfRnPortfolioSync.js";
import { isFintualOfficialSerieStale } from "./fintualPublicSeriePrice.js";
import {
  loadGlobalSyncState,
  saveGlobalSyncState,
  type GlobalSyncStateFile,
} from "./globalSyncState.js";
import { loadRootDotenv } from "./rootDotenv.js";
import { AFC_CIC_PUBLISHER, afcCicAccountIds, isAfcCicStale, latestAfcCicRow } from "./afcCicSeries.js";
import {
  cryptoEodDueUtcYmd,
  equityCryptoEodCaughtUp,
  equityEodLondonSyncDue,
  equityEodNyseSyncDue,
  equityEodSantiagoSyncDue,
  equityLondonEodCaughtUp,
  equityNyseEodCaughtUp,
  equitySantiagoEodCaughtUp,
} from "./equityEodSync.js";
import {
  FINTUAL_RN_COMPOSITION_SYNC_HOUR_CHILE,
  FINTUAL_RN_COMPOSITION_SYNC_MINUTE_CHILE,
  chileDayKind,
  cmfNextSync,
  cryptoNextSync,
  fintualNextSync,
  forexDayKind,
  isFintualRnCompositionDueDay,
  londonDayKindAt,
  nyseDayKindAt,
  officialSerieNextSync,
  publisherNextSync,
  rnCompositionNextSync,
  sbifMonthlyNextSync,
  sbifObservedNextSync,
  stocksLondonNextSync,
  stocksNyseNextSync,
  stocksSantiagoNextSync,
  yahooFxNextSync,
  type SyncSourceDayKind,
  type SyncSourceScheduleMeta,
  type SyncWallTime,
} from "./syncSourceSchedule.js";
import {
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
import { fintualGoalsSnapshotPath } from "./fintualApiLib.js";
import { isChileBusinessDay, priorChileBusinessDayYmd } from "./marketHolidays.js";
import { isBcentralConfigured } from "./bcentralApi.js";
import { isYahooFxUsdStale } from "./fxYahooEodSync.js";
import { fxPairsNextSync, isFxPairsStale } from "./fxPairsSync.js";
import {
  maxEurDateOnOrBefore,
  maxFxBcentralDateOnOrBefore,
  maxUfDate,
  maxUtmMonthParts,
} from "./sbifSyncDb.js";
import { isSbifUfStale, isSbifUtmStale } from "./sbifMonthlyPublication.js";
import {
  EVENING_PUBLISH_HOUR_CHILE,
  expectedPublishedDay,
  publisherLagFromPoll,
  recentPollLag,
  type SyncPublisherLag,
} from "./publisherSchedule.js";
import { GLOBAL_SYNC_SOURCES, isGlobalSyncSource, type GlobalSyncSource } from "./syncSourceIds.js";

export {
  GLOBAL_SYNC_SOURCES,
  isGlobalSyncSource,
  isLegacyEquityEodSyncSource,
  type GlobalSyncSource,
} from "./syncSourceIds.js";
export { PUBLISHER_LAG_MAX_POLL_AGE_MS, type SyncPublisherLag } from "./publisherSchedule.js";

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

/** The afp account on the live UNO series, or null when none declares it (the source is then disabled). */
function afpUnoAccountId(): number | null {
  const ids = afpUnoAccountIds();
  return ids.length === 0 ? null : liveAfpUnoAccountId();
}

/**
 * Stale = the official value due by now (`expectedPublishedDay`: the business day before the
 * latest business day whose 18:00 has passed) is not stored. Never stale without the account.
 */
export function isAfpUnoSpotStale(
  cl: ChileWallClock,
  _state: GlobalSyncStateFile,
  opts?: { force?: boolean }
): boolean {
  if (afpUnoAccountId() == null) return false;
  if (opts?.force) return true;
  return isAfpUnoOfficialStale(cl, latestOfficialUnoDay());
}

/** A stale AFP UNO source as the Superintendencia's lag, or null when we are behind (`publisherLagFromPoll`). */
export function afpUnoPublisherLag(
  cl: ChileWallClock,
  state: GlobalSyncStateFile,
  opts: { latestDbDay: string | null; nowMs: number }
): SyncPublisherLag | null {
  return publisherLagFromPoll({
    forced: isUserForcedSyncSourceStale(state, "afp_uno"),
    publishedYmd: state.afpUnoLastPublishedYmd,
    latestDbDay: opts.latestDbDay,
    expectedYmd: expectedPublishedDay(cl, afpUnoPublisher()),
    lastCheckedAt: state.afpUnoLastCheckedAt,
    nowMs: opts.nowMs,
  });
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
  if (cl.hour < EVENING_PUBLISH_HOUR_CHILE) return false;
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
    cl.hour >= EVENING_PUBLISH_HOUR_CHILE &&
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

/**
 * London Stock Exchange EOD missing for the due LSE session (`equityEodLondonSyncDue`: today
 * from 16:40 London, else the last closed LSE session — carries over until the bar lands).
 */
export function isStocksLondonStale(
  _state: GlobalSyncStateFile,
  opts?: { force?: boolean; now?: Date }
): boolean {
  if (opts?.force) return true;
  const now = opts?.now ?? new Date();
  const due = equityEodLondonSyncDue(now);
  return due != null && !equityLondonEodCaughtUp(due);
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
  const cap = cl.hour < EVENING_PUBLISH_HOUR_CHILE ? state.fintualLastCheckYmd : cl.ymd;
  if (!cap) return null;
  let expected = chileCalendarAddDays(published, 1);
  for (let i = 0; i < 14 && expected <= cap && !isFintualFundPublishDay(expected); i++) {
    expected = chileCalendarAddDays(expected, 1);
  }
  if (expected > cap) return null;
  if (fintualCertV2AnyHeldFundMissingDayRow(published, state)) return null;
  return recentPollLag(expected, published, opts.lastCheckedAt, opts.nowMs);
}

/**
 * A stale AFC CIC source as the PUBLISHER's lag, or null when we are behind
 * (`publisherLagFromPoll`). The SP is sometimes late printing: on 2026-10-05 its CSV still ended
 * at Thursday 10-01 while every 15-minute poll since Saturday noon read the whole year unchanged,
 * and the sync panel called that «stale» like a failed fetch.
 */
export function afcCicPublisherLag(
  cl: ChileWallClock,
  state: GlobalSyncStateFile,
  opts: { latestDbDay: string | null; nowMs: number }
): SyncPublisherLag | null {
  return publisherLagFromPoll({
    forced: isUserForcedSyncSourceStale(state, "afc_cic"),
    publishedYmd: state.afcCicLastPublishedYmd,
    latestDbDay: opts.latestDbDay,
    expectedYmd: expectedPublishedDay(cl, AFC_CIC_PUBLISHER),
    lastCheckedAt: state.afcCicLastCheckedAt,
    nowMs: opts.nowMs,
  });
}

/** What a source's rules read: the clock, the sync state and how the run was asked for. */
export type SyncSourceContext = {
  cl: ChileWallClock;
  state: GlobalSyncStateFile;
  nowMs: number;
  /** `--force`: every configured source is stale. */
  force: boolean;
  /** `--force-sbif`: the monthly Banco Central sources are stale from day 1. */
  forceSbif: boolean;
  bcentralConfigured: boolean;
  /** Last Fintual poll (ISO); undefined reads the goals snapshot, null means "never". */
  fintualLastCheckedAt?: string | null;
};

export type SyncSourceDefinition = {
  /** The step's name in the sync log. */
  label: string;
  /** Configured on this instance (an account on the series, credentials); the deployment profile is applied apart. */
  configured: (ctx: SyncSourceContext) => boolean;
  stale: (ctx: SyncSourceContext) => boolean;
  /** A stale source waiting on its publisher (`publisherSchedule.ts`), and the Chile hour from which that lag dims. */
  publisherLag?: { overdueHourChile: number; classify: (ctx: SyncSourceContext) => SyncPublisherLag | null };
  /**
   * A run asked for by hand (`userForcedStale`) stays asked for while the source is still stale
   * after a successful step — the NYSE close not published yet — instead of being cleared.
   */
  keepsForcedWhileStale: boolean;
  /** The calendar today's day kind is read on (a stale source reads the Chile one, `stocks_nyse` the NYSE one). */
  dayKind: (cl: ChileWallClock) => SyncSourceDayKind;
  nextSync: (ctx: SyncSourceContext) => SyncWallTime | null;
};

const bcentral = (ctx: SyncSourceContext) => ctx.bcentralConfigured;
const always = () => true;
/** The monthly Banco Central series are published on the 9th. */
const monthlyPublished = (ctx: SyncSourceContext) => ctx.cl.day >= 9 || ctx.forceSbif;

/** The sources, in the order the status rows list them. */
export const SYNC_SOURCES: { readonly [S in GlobalSyncSource]: SyncSourceDefinition } = {
  afp_uno: {
    label: "AFP UNO",
    configured: () => afpUnoAccountId() != null,
    stale: (c) => isAfpUnoSpotStale(c.cl, c.state, { force: c.force }),
    publisherLag: {
      overdueHourChile: EVENING_PUBLISH_HOUR_CHILE,
      classify: (c) => (c.force ? null : afpUnoPublisherLag(c.cl, c.state, { latestDbDay: latestOfficialUnoDay(), nowMs: c.nowMs })),
    },
    keepsForcedWhileStale: false,
    dayKind: (cl) => chileDayKind(cl.ymd),
    nextSync: (c) => publisherNextSync(c.cl, latestOfficialUnoDay(), afpUnoPublisher()),
  },
  afc_cic: {
    label: "AFC CIC",
    configured: () => afcCicAccountIds().length > 0,
    stale: (c) => isAfcCicStale(c.cl, c.state, { force: c.force }),
    publisherLag: {
      overdueHourChile: AFC_CIC_PUBLISHER.publishHour,
      classify: (c) =>
        c.force ? null : afcCicPublisherLag(c.cl, c.state, { latestDbDay: latestAfcCicRow()?.day ?? null, nowMs: c.nowMs }),
    },
    keepsForcedWhileStale: true,
    dayKind: (cl) => chileDayKind(cl.ymd),
    nextSync: (c) => publisherNextSync(c.cl, latestAfcCicRow()?.day ?? null, AFC_CIC_PUBLISHER),
  },
  fintual: {
    label: "Fintual",
    configured: always,
    stale: (c) => isFintualSyncStale(c.cl, c.state),
    publisherLag: {
      overdueHourChile: EVENING_PUBLISH_HOUR_CHILE,
      classify: (c) =>
        fintualPublisherLag(c.cl, c.state, {
          lastCheckedAt: c.fintualLastCheckedAt === undefined ? readFintualLastCheckedAt() : c.fintualLastCheckedAt,
          nowMs: c.nowMs,
        }),
    },
    keepsForcedWhileStale: true,
    dayKind: (cl) => chileDayKind(cl.ymd),
    nextSync: (c) => fintualNextSync(c.cl, c.state.fintualLastAppliedPublishYmd),
  },
  fintual_official_serie: {
    label: "Fintual official serie",
    configured: always,
    stale: (c) => isFintualOfficialSerieStale(c.cl, c.state, { nowMs: c.nowMs }),
    keepsForcedWhileStale: false,
    dayKind: (cl) => chileDayKind(cl.ymd),
    nextSync: (c) => officialSerieNextSync(c.cl, c.state),
  },
  fintual_rn_composition: {
    label: "Risky Norris composition",
    configured: always,
    stale: (c) => isFintualRnCompositionStale(c.cl, c.state),
    keepsForcedWhileStale: false,
    dayKind: (cl) => chileDayKind(cl.ymd),
    nextSync: (c) => rnCompositionNextSync(c.cl, c.state),
  },
  cmf_rn_portfolio: {
    label: "CMF Risky Norris filing",
    configured: always,
    stale: (c) => isCmfRnPortfolioStale(c.cl, c.state),
    keepsForcedWhileStale: false,
    dayKind: (cl) => chileDayKind(cl.ymd),
    nextSync: (c) => cmfNextSync(c.cl, c.state),
  },
  sbif_usd: {
    label: "BCentral USD",
    configured: bcentral,
    stale: (c) => isSbifObservedFxStale(maxFxBcentralDateOnOrBefore(c.cl.ymd), c.cl, c.state.sbifUsdLastErrorAt),
    keepsForcedWhileStale: false,
    dayKind: (cl) => chileDayKind(cl.ymd),
    nextSync: (c) => sbifObservedNextSync(c.cl),
  },
  sbif_eur: {
    label: "BCentral EUR",
    configured: bcentral,
    stale: (c) => isSbifObservedFxStale(maxEurDateOnOrBefore(c.cl.ymd), c.cl, c.state.sbifEurLastErrorAt),
    keepsForcedWhileStale: false,
    dayKind: (cl) => chileDayKind(cl.ymd),
    nextSync: (c) => sbifObservedNextSync(c.cl),
  },
  sbif_uf: {
    label: "BCentral UF",
    configured: bcentral,
    stale: (c) => monthlyPublished(c) && isSbifUfStale(c.cl, { forceSbif: c.forceSbif, maxUfDate: maxUfDate() }),
    keepsForcedWhileStale: false,
    dayKind: (cl) => chileDayKind(cl.ymd),
    nextSync: (c) => sbifMonthlyNextSync(c.cl),
  },
  sbif_utm: {
    label: "BCentral UTM",
    configured: bcentral,
    stale: (c) => monthlyPublished(c) && isSbifUtmStale(c.cl, { forceSbif: c.forceSbif, maxUtm: maxUtmMonthParts() }),
    keepsForcedWhileStale: false,
    dayKind: (cl) => chileDayKind(cl.ymd),
    nextSync: (c) => sbifMonthlyNextSync(c.cl),
  },
  sbif_ipc: {
    label: "BCentral IPC",
    configured: bcentral,
    stale: (c) => monthlyPublished(c) && isSbifMonthlyStale(c.cl, c.state.sbifIpcMonth, { forceSbif: c.forceSbif }),
    keepsForcedWhileStale: false,
    dayKind: (cl) => chileDayKind(cl.ymd),
    nextSync: (c) => sbifMonthlyNextSync(c.cl),
  },
  stocks_nyse: {
    label: "NYSE stocks",
    configured: always,
    stale: (c) => isStocksNyseStale(c.state, { force: c.force }),
    keepsForcedWhileStale: true,
    dayKind: nyseDayKindAt,
    nextSync: (c) => stocksNyseNextSync(c.cl),
  },
  stocks_santiago: {
    label: "Santiago stocks",
    configured: always,
    stale: (c) => isStocksSantiagoStale(c.state, { force: c.force }),
    keepsForcedWhileStale: true,
    dayKind: (cl) => chileDayKind(cl.ymd),
    nextSync: (c) => stocksSantiagoNextSync(c.cl),
  },
  stocks_london: {
    label: "London stocks",
    configured: always,
    stale: (c) => isStocksLondonStale(c.state, { force: c.force }),
    keepsForcedWhileStale: true,
    dayKind: londonDayKindAt,
    nextSync: (c) => stocksLondonNextSync(c.cl),
  },
  yahoo_fx_usd: {
    label: "Yahoo USD/CLP",
    configured: always,
    stale: (c) => isYahooFxUsdStale({ force: c.force }),
    keepsForcedWhileStale: true,
    dayKind: (cl) => forexDayKind(cl.ymd),
    nextSync: (c) => yahooFxNextSync(c.cl),
  },
  fx_pairs: {
    label: "Yahoo currency pairs (EUR/USD)",
    configured: always,
    stale: (c) => isFxPairsStale({ force: c.force }),
    keepsForcedWhileStale: true,
    dayKind: (cl) => forexDayKind(cl.ymd),
    nextSync: () => fxPairsNextSync(),
  },
  crypto_eod: {
    label: "Crypto EOD",
    configured: always,
    stale: (c) => isCryptoEodStale(c.cl, c.state, { force: c.force }),
    keepsForcedWhileStale: true,
    dayKind: (cl) => chileDayKind(cl.ymd),
    nextSync: (c) => cryptoNextSync(c.cl),
  },
};

export type SyncSourceDisplayStatus = "ok" | "stale" | "disabled";

export type SyncSourceStatusRow = {
  source: GlobalSyncSource;
  status: SyncSourceDisplayStatus;
  stale: boolean;
  /** Set when `stale` is the publisher's lag, not ours (see `publisherSchedule.ts`). */
  publisher_lag: SyncPublisherLag | null;
  next_sync: SyncWallTime | null;
  next_sync_imminent: boolean;
  today_day_kind: SyncSourceDayKind;
};

/** When a source is due next: imminent while stale, nothing while disabled. */
function scheduleMeta(source: GlobalSyncSource, ctx: SyncSourceContext, stale: boolean, disabled: boolean): SyncSourceScheduleMeta {
  if (disabled) return { next_sync: null, next_sync_imminent: false, today_day_kind: "open" };
  const def = SYNC_SOURCES[source];
  // The day kind is the source's own calendar whether or not it is stale: a market on another
  // clock (NYSE, London) reads its holiday on its own day, and the fx day every weekday.
  if (stale) return { next_sync: null, next_sync_imminent: true, today_day_kind: def.dayKind(ctx.cl) };
  return { next_sync: def.nextSync(ctx), next_sync_imminent: false, today_day_kind: def.dayKind(ctx.cl) };
}

/** One source's schedule meta at `cl` (status rows; tests). */
export function attachSyncSourceSchedule(
  source: GlobalSyncSource,
  cl: ChileWallClock,
  stale: boolean,
  disabled: boolean,
  state: GlobalSyncStateFile = loadGlobalSyncState()
): SyncSourceScheduleMeta {
  const ctx: SyncSourceContext = { cl, state, nowMs: Date.now(), force: false, forceSbif: false, bcentralConfigured: true };
  return scheduleMeta(source, ctx, stale, disabled);
}

type StatusOpts = {
  force?: boolean;
  forceSbif?: boolean;
  bcentralConfigured?: boolean;
  /** Last Fintual poll (ISO); undefined reads the goals snapshot, null means "never". */
  fintualLastCheckedAt?: string | null;
  nowMs?: number;
};

function sourceContext(cl: ChileWallClock, state: GlobalSyncStateFile, opts?: StatusOpts): SyncSourceContext {
  loadRootDotenv();
  return {
    cl,
    state,
    nowMs: opts?.nowMs ?? Date.now(),
    force: opts?.force ?? false,
    forceSbif: opts?.forceSbif ?? false,
    bcentralConfigured: opts?.bcentralConfigured ?? isBcentralConfigured(),
    fintualLastCheckedAt: opts?.fintualLastCheckedAt,
  };
}

/**
 * Each source's stale verdict: disabled when the deployment profile leaves it out or it is not
 * configured; else its own rule, or a run asked for by hand. `withPublisherLag` also classifies
 * the stale ones (reads the goals snapshot; the status rows need it, the scheduler does not).
 */
function evaluateSources(ctx: SyncSourceContext, withPublisherLag: boolean): SyncSourceStatusRow[] {
  const profileDisabled = deploymentProfile().disabledSyncSources;
  const forced = userForcedStaleSet(ctx.state);
  return GLOBAL_SYNC_SOURCES.map((source) => {
    const def = SYNC_SOURCES[source];
    if (profileDisabled.has(source) || !def.configured(ctx)) {
      return { source, status: "disabled" as const, stale: false, publisher_lag: null, ...scheduleMeta(source, ctx, false, true) };
    }
    const natural = def.stale(ctx);
    const publisher_lag = natural && withPublisherLag && def.publisherLag ? def.publisherLag.classify(ctx) : null;
    const stale = natural || forced.has(source);
    // The schedule follows the source's own rule; a forced run only marks the row stale.
    const meta = scheduleMeta(source, ctx, natural, false);
    return { source, status: stale ? ("stale" as const) : ("ok" as const), stale, publisher_lag, ...meta };
  });
}

export function allSyncSourceStatuses(
  cl: ChileWallClock,
  state: GlobalSyncStateFile,
  opts?: StatusOpts
): SyncSourceStatusRow[] {
  return evaluateSources(sourceContext(cl, state, opts), true);
}

/** The sources the scheduler runs now, in table order. */
export function staleSyncSources(
  cl: ChileWallClock,
  state: GlobalSyncStateFile,
  opts?: StatusOpts
): GlobalSyncSource[] {
  return evaluateSources(sourceContext(cl, state, opts), false)
    .filter((r) => r.stale)
    .map((r) => r.source);
}

/**
 * After a successful step: whether a run asked for by hand stays asked for (the source is still
 * naturally stale and keeps the flag, `keepsForcedWhileStale`).
 */
export function keepUserForcedStaleAfterSuccess(source: GlobalSyncSource, cl: ChileWallClock, state: GlobalSyncStateFile): boolean {
  const def = SYNC_SOURCES[source];
  return def.keepsForcedWhileStale && def.stale(sourceContext(cl, state));
}

/**
 * Sources whose accounts dim at `cl`. Our own staleness (a missed or failed poll, a due sync not
 * yet run, a signature mismatch, a forced run) always dims. A publisher's lag dims only once the
 * value is OVERDUE — from the source's publish hour until it lands; before that the display holds
 * everything the publisher has (pre-open, the live proxy, the post-close hold), so nothing is
 * behind (2026-09-21). The window is wall-clock: a value still missing at midnight reads normal
 * again from 00:00 and dims from the publish hour the next day, until it is applied.
 */
export function staleDimmingSources(rows: SyncSourceStatusRow[], cl: ChileWallClock): GlobalSyncSource[] {
  return rows
    .filter((r) => {
      if (!r.stale) return false;
      if (r.publisher_lag == null) return true;
      const lag = SYNC_SOURCES[r.source].publisherLag;
      if (!lag) throw new Error(`sync: ${r.source} carries a publisher lag but declares no publish hour`);
      return cl.hour >= lag.overdueHourChile;
    })
    .map((r) => r.source);
}

export function syncStatusPayload(): {
  chile: ChileWallClock;
  state: GlobalSyncStateFile;
  /** Every stale source — what the scheduler keeps polling. */
  stale: GlobalSyncSource[];
  /**
   * The sources whose accounts the dashboard dims right now (`staleDimmingSources`): every stale
   * source whose staleness is ours, plus a source waiting on its publisher once the value is
   * overdue (from its publish hour). Before that hour a publisher-lag source holds everything the
   * publisher has, so its accounts are not behind anything.
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
