import { chileCalendarTodayYmd } from "./chileDate.js";
import { fintualPollDayCaughtUp } from "./fintualPublishDate.js";
import { fintualCertV2PollReconciled } from "./fintualCertV2Reconcile.js";
import { loadGlobalSyncState } from "./globalSyncState.js";
import {
  isChileBusinessDay,
  isNyseTradingDay,
  nextChileBusinessDayYmd,
  priorNyseSessionYmd,
} from "./marketHolidays.js";
import {
  isBeforeNyseRegularOpen,
  isNyseRegularSessionOpen,
  nyseWallClock,
} from "./nyseSession.js";
import {
  loadCompositeHoldings,
  loadCompositeMeta,
  proxyClpFromMeta,
  RISKY_NORRIS_PROXY_BUCKET,
  APV_PROXY_NEGLIGIBLE_REL_DIFF,
} from "./watchlistComposite.js";

/** Fintual cert / legacy series that use RN proxy for intraday MTM. */
export const RISKY_NORRIS_MTM_SERIES_KEYS = new Set([
  "fintual_cert_risky_norris",
  "fintual_cert_apv_a",
  "fintual_cert_apv_b",
  "fintual_risky_norris",
  "fintual_risky_norris_apv",
]);

export const RISKY_NORRIS_APV_MTM_SERIES_KEYS = new Set([
  "fintual_cert_apv_a",
  "fintual_cert_apv_b",
  "fintual_risky_norris_apv",
]);

/** |APV−RN|/RN at composition anchor below this → one shared proxy cuota for all RN accounts. */
export { APV_PROXY_NEGLIGIBLE_REL_DIFF } from "./watchlistComposite.js";

export function isRiskyNorrisProxyMtmSeries(seriesKey: string | null | undefined): boolean {
  const k = seriesKey?.trim();
  return k != null && RISKY_NORRIS_MTM_SERIES_KEYS.has(k);
}

export function isRiskyNorrisApvMtmSeries(seriesKey: string | null | undefined): boolean {
  const k = seriesKey?.trim();
  return k != null && RISKY_NORRIS_APV_MTM_SERIES_KEYS.has(k);
}

/**
 * Global evening Fintual sync caught up for the Chile day `ymd` (official cuotas in DB).
 *
 * Keyed by a DAY, not the clock: the proxy gate asks about the NYSE session it would be
 * tracking (`nyseWallClock(now).ymd`), never about the Chile calendar day. Chile runs ahead of
 * New York by 0–2 hours depending on the two DST calendars, so between Chile midnight and
 * New York midnight the Chile day has rolled while the session — already settled by that
 * evening's poll — has not. Asking "settled for Chile today" there was false (no poll for the
 * new day exists yet) and re-armed the proxy for the gap: 2026-09-11 00:00–01:00 the APV
 * accounts read +286k/+129k against the official cuota polled at 22:15, snapping back at
 * New York midnight. Unreachable while both zones sat at UTC−4; exposed by Chile's 2026-09-06
 * spring-forward.
 */
export function fintualGlobalSyncSettledForChileDay(ymd: string): boolean {
  const state = loadGlobalSyncState();
  const publishYmd = state.fintualLastAppliedPublishYmd ?? state.fintualLastPublishYmd;
  const sig = state.fintualLastAppliedSig ?? state.fintualLastCheckSig;
  if (!fintualPollDayCaughtUp(ymd, publishYmd, state, sig)) return false;
  const reconcileYmd = publishYmd ?? ymd;
  if (!fintualCertV2PollReconciled(reconcileYmd, state)) return false;
  return true;
}

/**
 * The NYSE session whose close the proxy would be holding right now: the current session once
 * it has opened, otherwise the previous trading session (yesterday's, or Friday's on a weekend
 * or a US holiday).
 */
function heldNyseSessionYmd(now: Date): string | null {
  const sessionYmd = nyseWallClock(now).ymd;
  if (isNyseTradingDay(sessionYmd) && !isBeforeNyseRegularOpen(now)) return sessionYmd;
  return priorNyseSessionYmd(sessionYmd);
}

/**
 * Chile-holiday proxy hold: the proxy overrides Fintual's official cuota while the fund value
 * cannot reflect the NYSE session the proxy is tracking.
 *
 * On a Chile holiday that NYSE trades, Fintual publishes a flat carry cuota for the day (the
 * fund did not trade) and forward-publishes the whole non-business block; those bars would
 * otherwise "settle" the day and snap the accounts back to a cuota that never saw the session.
 * The first cuota that CAN reflect it is the next Chile business day's, so: hold while the held
 * session (see {@link heldNyseSessionYmd}) fell on a Chile non-business day and that catch-up
 * day's evening sync has not settled. For a Friday holiday (2026-09-18, Fiestas Patrias): live
 * proxy from Friday's open, Friday's close held through the weekend and Monday pre-open,
 * Monday's live session, then Monday's evening cuota settles it. Before the holiday's own open
 * nothing is held — the last official cuota is still right. (Until 2026-09-17 the hold ended
 * at New York midnight on the holiday, so the weekend showed the flat carries and Friday's
 * move vanished until Monday.)
 *
 * Framed on the NYSE session day (`nyseWallClock(now).ymd`), never the Chile calendar day —
 * see {@link fintualGlobalSyncSettledForChileDay} for why the two differ around Chile midnight
 * (a Saturday 00:30 Chile is still Friday's session in New York).
 */
export function inChileHolidayProxyHold(now = new Date()): boolean {
  const held = heldNyseSessionYmd(now);
  if (held == null || isChileBusinessDay(held)) return false;
  const catchUpYmd = nextChileBusinessDayYmd(held);
  if (catchUpYmd == null) return false;
  return !fintualGlobalSyncSettledForChileDay(catchUpYmd);
}

/**
 * RN proxy MTM window. Follows the live/EOD basket proxy instead of the official Fintual
 * cuota when the cuota cannot yet reflect the current NYSE session.
 *
 * - Chile-holiday hold (see {@link inChileHolidayProxyHold}) comes first and overrides the
 *   "settled", pre-open and non-trading-day gates: a weekend after a Friday holiday has no
 *   session to trade, but Friday's close must stay on screen until Monday's cuota lands.
 * - Otherwise the normal business-day intraday window applies: NYSE trading, after open,
 *   before the Fintual evening sync settles.
 */
export function shouldUseRiskyNorrisProxyMtm(now = new Date()): boolean {
  if (inChileHolidayProxyHold(now)) return true;

  const sessionYmd = nyseWallClock(now).ymd;
  if (!isNyseTradingDay(sessionYmd)) return false;

  // Settled for the SESSION day, not Chile today: after Chile midnight New York can still be
  // on the session whose cuota the evening poll already landed — the proxy stays off until
  // the next open (see fintualGlobalSyncSettledForChileDay).
  if (fintualGlobalSyncSettledForChileDay(sessionYmd)) return false;
  if (isBeforeNyseRegularOpen(now)) return false;
  return true;
}

/**
 * Live or EOD RN basket proxy valor cuota (CLP) for MTM. Throws when proxy is required but cannot be computed.
 */
export function riskyNorrisProxyCuotaForMtm(seriesKey: string, now = new Date()): number {
  if (!isRiskyNorrisProxyMtmSeries(seriesKey)) {
    throw new Error(`riskyNorrisProxyCuotaForMtm: unsupported series ${seriesKey}`);
  }
  const meta = loadCompositeMeta(RISKY_NORRIS_PROXY_BUCKET);
  const holdings = loadCompositeHoldings(RISKY_NORRIS_PROXY_BUCKET);
  if (meta == null || holdings.length === 0) {
    throw new Error("Risky Norris proxy MTM: missing composite meta or holdings");
  }

  const today = chileCalendarTodayYmd();
  const preferLive = isNyseRegularSessionOpen(now);
  const proxyRn = proxyClpFromMeta(meta, holdings, today, { preferLive, now });

  if (!isRiskyNorrisApvMtmSeries(seriesKey)) {
    return proxyRn;
  }

  const anchorApv = meta.anchor_apv_fund_unit_clp;
  const anchorRn = meta.anchor_fund_unit_clp;
  if (
    anchorApv == null ||
    !Number.isFinite(anchorApv) ||
    anchorApv <= 0 ||
    !Number.isFinite(anchorRn) ||
    anchorRn <= 0
  ) {
    return proxyRn;
  }

  const relDiff = Math.abs(anchorApv - anchorRn) / anchorRn;
  if (relDiff < APV_PROXY_NEGLIGIBLE_REL_DIFF) {
    return proxyRn;
  }

  return proxyRn * (anchorApv / anchorRn);
}
