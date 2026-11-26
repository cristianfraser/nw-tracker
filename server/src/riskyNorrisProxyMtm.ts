import { chileCalendarTodayYmd } from "./chileDate.js";
import { RISKY_NORRIS_APV_SERIES_KEYS, RISKY_NORRIS_PROXY_SERIES_KEYS } from "./fintualGoals.js";
import { latestPublishedFintualCuotaDay } from "./fintualFundUnitDaily.js";
import { fintualPollDayCaughtUp } from "./fintualPublishDate.js";
import { fintualCertV2PollReconciled } from "./fintualCertV2Reconcile.js";
import { loadGlobalSyncState } from "./globalSyncState.js";
import { isChileBusinessDay, isNyseTradingDay, nextChileBusinessDayYmd } from "./marketHolidays.js";
import {
  heldProxyValuationDayYmd,
  proxyValuationDayOnOrBefore,
} from "./rnProxyValuationDay.js";
import {
  isBeforeNyseRegularOpen,
  isNyseRegularSessionOpen,
  nyseWallClock,
} from "./nyseSession.js";
import { noteLiveFxRead, noteLiveTickerRead } from "./cacheDependencies.js";
import { LIVE_FX_SYMBOL } from "./liveMarketQuotesConfig.js";
import {
  listCompositeConstituentTickers,
  loadCompositeHoldings,
  loadCompositeMeta,
  proxyClpFromMeta,
  RISKY_NORRIS_PROXY_BUCKET,
  APV_PROXY_NEGLIGIBLE_REL_DIFF,
} from "./watchlistComposite.js";

/** Fintual cert / legacy series that use RN proxy for intraday MTM (`fintualGoals.ts`). */
export const RISKY_NORRIS_MTM_SERIES_KEYS: ReadonlySet<string> = RISKY_NORRIS_PROXY_SERIES_KEYS;

export const RISKY_NORRIS_APV_MTM_SERIES_KEYS: ReadonlySet<string> = RISKY_NORRIS_APV_SERIES_KEYS;

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
 * The watchlist composite bucket whose basket proxies a fund series (the value map breaks
 * such an account down into the basket's holdings), or null for a series with no proxy.
 * Data-driven hook: a second proxied fund adds a case here, nothing else changes.
 */
export function proxyBucketSlugForSeriesKey(seriesKey: string | null | undefined): string | null {
  return isRiskyNorrisProxyMtmSeries(seriesKey) ? RISKY_NORRIS_PROXY_BUCKET : null;
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
  if (!fintualCertV2PollReconciled(reconcileYmd)) return false;
  return true;
}

/**
 * The Chile day whose cuota is the first that reflects a proxy valuation day: the day itself
 * when Chile worked that day (always so for an fx-only day), else the next Chile business day
 * (Fintual prints a flat carry for the whole non-business block).
 */
function valuationDayCuotaDay(valuationDay: string): string | null {
  return isChileBusinessDay(valuationDay) ? valuationDay : nextChileBusinessDayYmd(valuationDay);
}

/**
 * The cuota that reflects the proxy valuation day `valuationDay` (an NYSE session or an fx-only
 * day, `rnProxyValuationDay.ts`) is not in the database yet: the series' latest PUBLISHED
 * cuota (never a carry or a stand-in) is dated before the valuation day's cuota day. The
 * cases, one rule:
 * - a session on a Chile holiday, until the next Chile business day's cuota lands (Fiestas
 *   Patrias 2026-09-18: Friday's close through the weekend and Monday);
 * - a session on a Chile business day whose cuota Fintual has not published (2026-11-24: nothing
 *   by midnight, so Wednesday read Tuesday's proxy against Monday's official bar and showed
 *   Tuesday's move as its own);
 * - an fx-only day (a US holiday Chile works), until that day's own cuota lands.
 *
 * Read from the series' own rows, never from the sync state: the state's applied publish day
 * follows whatever closure date the last poll reported, and Fintual has reported an older one
 * after a newer (2026-11-24 23:20: 11-22 after 11-23). A series with no published cuota at all
 * is not one Fintual publishes (demo data), so nothing is pending for it. A later published
 * cuota closes every earlier session: a day Fintual skipped keeps its stand-in until the
 * official serie replaces it.
 */
function valuationDayCuotaPending(seriesKey: string, valuationDay: string): boolean {
  const latest = latestPublishedFintualCuotaDay(seriesKey);
  if (latest == null) return false;
  const cuotaDay = valuationDayCuotaDay(valuationDay);
  return cuotaDay != null && latest < cuotaDay;
}

/**
 * Per-DATE form of the pending-cuota hold, for historical marks: a date whose valuation day's
 * cuota (its NYSE session, or the date itself on an fx-only day) is not in the database
 * ({@link valuationDayCuotaPending}) is valued through the EOD proxy, exactly like today, instead of the last official bar on or before it. Without this the day after read the
 * whole move a second time: today = held proxy, yesterday = a bar that never saw the session
 * (2026-09-19 00:07 after the Friday holiday: APV-A/B +278k/+125k, then again on Sunday and
 * Monday pre-open). Once the cuota is written the predicate turns off and the dates read the
 * official bars again — the same reattribution a live day goes through at its evening settle.
 *
 * Never {@link fintualGlobalSyncSettledForChileDay}: that check also asks whether TODAY's
 * positions reconcile with the last poll's NAV, which is false for hours whenever cash is in
 * transit (2026-09-21 12:30), and asking it for a 2025 day re-valued every historical Chile
 * holiday through today's basket — a thrown 500 on every daily surface where a basket ticker
 * (SPYM, listed 2025-07) had no bar.
 */
export function riskyNorrisProxyAppliesOnYmd(seriesKey: string, ymd: string): boolean {
  const day = proxyValuationDayOnOrBefore(ymd);
  return day != null && valuationDayCuotaPending(seriesKey, day);
}

/**
 * Pending-cuota hold for today: the proxy overrides the official cuota while the cuota that
 * reflects the day the proxy is holding (see {@link heldProxyValuationDayYmd}) is not in the
 * database ({@link valuationDayCuotaPending}).
 *
 * On a US holiday that Chile works (an fx-only day, `isFxOnlyProxyDay`) the held day is the
 * holiday itself once its interbank window has prints (09:00 Chile): the basket sits at the last
 * session's closes and the fx leg follows the day's observado frame, until that evening's cuota
 * lands (Thanksgiving 2026-11-26: the APV accounts read flat all day while the dollar moved, and
 * the cuota then jumped by the fx move at the evening poll). Before the next session's open the
 * holiday's value is still held while its cuota is late.
 *
 * On a Chile holiday that NYSE trades, Fintual publishes a flat carry cuota for the day and
 * forward-publishes the whole non-business block; the first cuota that CAN reflect the session
 * is the next Chile business day's. For a Friday holiday (2026-09-18): live proxy from Friday's
 * open, Friday's close held through the weekend and Monday pre-open, Monday's live session, then
 * Monday's evening cuota. On a Chile business day whose cuota is late the close is held the same
 * way: past New York midnight and through the next morning, until the cuota lands. Before a
 * session's own open nothing of it is held — the previous session's cuota is still right.
 *
 * Framed on the NYSE session day, never the Chile calendar day — see
 * {@link fintualGlobalSyncSettledForChileDay} for why the two differ around Chile midnight
 * (a Saturday 00:30 Chile is still Friday's session in New York).
 */
export function inPendingCuotaProxyHold(seriesKey: string, now = new Date()): boolean {
  const held = heldProxyValuationDayYmd(now);
  return held != null && valuationDayCuotaPending(seriesKey, held);
}

/**
 * RN proxy MTM window. Follows the live/EOD basket proxy instead of the official Fintual
 * cuota when the cuota cannot yet reflect the current NYSE session.
 *
 * - The pending-cuota hold (see {@link inPendingCuotaProxyHold}) comes first and overrides the
 *   "settled", pre-open and non-trading-day gates: a weekend after a Friday holiday has no
 *   session to trade, but Friday's close must stay on screen until Monday's cuota lands, and a
 *   business day's close until its late cuota does.
 * - Otherwise the normal business-day intraday window applies: NYSE trading, after open,
 *   before the Fintual evening sync settles.
 */
export function shouldUseRiskyNorrisProxyMtm(seriesKey: string, now = new Date()): boolean {
  // The gate reports the basket whatever it decides, like `shouldUseLiveEquityQuote`: an APV
  // mark cached before the open read the official cuota and no live input, so without this the
  // session's ticks never dropped it and the accounts read 0 day P/L all session (2026-11-02).
  for (const ticker of listCompositeConstituentTickers(RISKY_NORRIS_PROXY_BUCKET)) {
    noteLiveTickerRead(ticker);
  }
  noteLiveFxRead(LIVE_FX_SYMBOL);
  if (inPendingCuotaProxyHold(seriesKey, now)) return true;

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
 *
 * `asOfYmd` (default Chile today) picks the day. The value is carried on the SESSION the day
 * reflects — the live session, else the held one (Friday's on a weekend or Monday pre-open; a
 * US holiday Chile works is its own day, at the last closes and its own fx; the date's own
 * session for a historical date, its previous one for a historical weekend day) — never on the
 * calendar day itself, so every day of a held block values identically and the
 * day P/L inside the block is 0 by construction.
 */
export function riskyNorrisProxyCuotaForMtm(seriesKey: string, now = new Date(), asOfYmd?: string): number {
  if (!isRiskyNorrisProxyMtmSeries(seriesKey)) {
    throw new Error(`riskyNorrisProxyCuotaForMtm: unsupported series ${seriesKey}`);
  }
  const meta = loadCompositeMeta(RISKY_NORRIS_PROXY_BUCKET);
  const holdings = loadCompositeHoldings(RISKY_NORRIS_PROXY_BUCKET);
  if (meta == null || holdings.length === 0) {
    throw new Error("Risky Norris proxy MTM: missing composite meta or holdings");
  }

  const today = chileCalendarTodayYmd();
  const isToday = asOfYmd == null || asOfYmd === today;
  const preferLive = isToday && isNyseRegularSessionOpen(now);
  // On an fx-only day the valuation day is the holiday itself: the basket's EOD reads resolve on
  // or before it (the last session's closes) and the fx leg is that day's observado frame.
  const valuationYmd = preferLive
    ? today
    : isToday
      ? (heldProxyValuationDayYmd(now) ?? today)
      : (proxyValuationDayOnOrBefore(asOfYmd) ?? asOfYmd);
  const proxyRn = proxyClpFromMeta(meta, holdings, valuationYmd, { preferLive, now });

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
