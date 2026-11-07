import { chileCalendarAddDays, dateAtTimeZoneWallClock, type ChileWallClock } from "./chileDate.js";
import { CMF_RN_SYNC_HOUR_CHILE, cmfRnNextDueYmd } from "./cmfRnPortfolioSync.js";
import { fintualOfficialSerieNextDue } from "./fintualPublicSeriePrice.js";
import {
  CRYPTO_EOD_SYNC_AFTER_HOUR_CHILE,
  CRYPTO_EOD_SYNC_AFTER_MINUTE_CHILE,
  SANTIAGO_EOD_SYNC_AFTER_HOUR_CHILE,
  SANTIAGO_EOD_SYNC_AFTER_MINUTE_CHILE,
  isCryptoEodSyncWindow,
  isSantiagoEodSyncWindow,
} from "./equityEodSync.js";
import { FX_DAY_END_HOUR_NY, FX_DAY_END_MINUTE_NY, fxDayEndInstant, nextWeekdayYmd } from "./forexDay.js";
import { isFintualFundPublishDay } from "./fintualPublishDate.js";
import type { GlobalSyncStateFile } from "./globalSyncState.js";
import {
  isChileBusinessDay,
  isChileHoliday,
  isNyseHoliday,
  isNyseTradingDay,
  isWeekendYmd,
} from "./marketHolidays.js";
import { isAfterNyseRegularClose, nyseWallClock } from "./nyseSession.js";
import { EVENING_PUBLISH_HOUR_CHILE, nextPublishDue, type PublisherSchedule } from "./publisherSchedule.js";

/**
 * When each sync source next becomes due, one function per source; the source table
 * (`globalSyncStale.ts`, `SYNC_SOURCES`) says which one a source uses. Every function follows the
 * injected Chile wall clock (tests, replay), never a mix of `cl` and the real `new Date()`.
 */

const SBIF_OBSERVED_STALE_AFTER_HOUR_CHILE = 18;
/**
 * Chile wall time (inclusive) from which the daily Risky Norris composition sync is due. After the
 * Fintual publish hour: the Risky Norris A serie the proxy anchors on publishes day D on D+1
 * through the official public prices, which the sync refreshes itself, so an evening run anchors
 * at most one session behind (the old 10:00 run found nothing newer than D−2).
 */
export const FINTUAL_RN_COMPOSITION_SYNC_HOUR_CHILE = 18;
export const FINTUAL_RN_COMPOSITION_SYNC_MINUTE_CHILE = 30;

/**
 * A day with something new to anchor on: a Chile business day (the composition may have moved and
 * the previous business day's cuota is published), or the day after one (a Friday's cuota
 * publishes on Saturday). A Sunday, or a holiday following a weekend, brings nothing.
 */
export function isFintualRnCompositionDueDay(ymd: string): boolean {
  return isChileBusinessDay(ymd) || isChileBusinessDay(chileCalendarAddDays(ymd, -1));
}

function nextFintualRnCompositionDueYmd(ymd: string, maxSteps = 14): string | null {
  let cur = ymd;
  for (let i = 0; i < maxSteps; i++) {
    cur = chileCalendarAddDays(cur, 1);
    if (isFintualRnCompositionDueDay(cur)) return cur;
  }
  return null;
}

export type SyncWallTime = {
  ymd: string;
  hour: number;
  minute: number;
  /** IANA zone for display (`America/Santiago` or `America/New_York`). */
  timeZone: "America/Santiago" | "America/New_York";
};

/** UTC epoch ms for a scheduled sync wall time. */
export function syncWallTimeToMs(wt: SyncWallTime): number {
  return dateAtTimeZoneWallClock(wt.ymd, wt.hour, wt.minute, wt.timeZone).getTime();
}

export type SyncSourceDayKind = "open" | "weekend" | "holiday";

export type SyncSourceScheduleMeta = {
  /** When the source becomes due next (wall clock in `timeZone`). */
  next_sync: SyncWallTime | null;
  /** Scheduler may run as soon as stale (show "Ahora" in UI). */
  next_sync_imminent: boolean;
  today_day_kind: SyncSourceDayKind;
};

function chileTimeToday(cl: ChileWallClock, hour: number, minute: number): SyncWallTime {
  return { ymd: cl.ymd, hour, minute, timeZone: "America/Santiago" };
}

function chileTimeOnYmd(ymd: string, hour: number, minute: number): SyncWallTime {
  return { ymd, hour, minute, timeZone: "America/Santiago" };
}

function nyTimeToday(ny: ReturnType<typeof nyseWallClock>, hour: number, minute: number): SyncWallTime {
  return { ymd: ny.ymd, hour, minute, timeZone: "America/New_York" };
}

function nextChileBusinessDayYmd(fromYmd: string, maxSteps = 14): string | null {
  let cur = chileCalendarAddDays(fromYmd, 1);
  for (let i = 0; i < maxSteps; i++) {
    if (isChileBusinessDay(cur)) return cur;
    cur = chileCalendarAddDays(cur, 1);
  }
  return null;
}

function nextFintualPublishDayYmd(fromYmd: string, maxSteps = 14): string | null {
  let cur = fromYmd;
  for (let i = 0; i < maxSteps; i++) {
    if (isFintualFundPublishDay(cur)) return cur;
    cur = chileCalendarAddDays(cur, 1);
  }
  return null;
}

function nextNyseTradingDayYmd(fromYmd: string, maxSteps = 14): string | null {
  let cur = fromYmd;
  for (let i = 0; i < maxSteps; i++) {
    if (isNyseTradingDay(cur)) return cur;
    cur = chileCalendarAddDays(cur, 1);
  }
  return null;
}

export function chileDayKind(ymd: string): SyncSourceDayKind {
  if (isChileHoliday(ymd)) return "holiday";
  if (!isChileBusinessDay(ymd)) return "weekend";
  return "open";
}

export function nyDayKind(ymd: string): SyncSourceDayKind {
  if (isNyseHoliday(ymd)) return "holiday";
  if (!isNyseTradingDay(ymd)) return "weekend";
  return "open";
}

function nextChileBusinessTime(cl: ChileWallClock, hour: number, minute: number): SyncWallTime {
  const nowMins = cl.hour * 60 + cl.minute;
  const targetMins = hour * 60 + minute;
  if (isChileBusinessDay(cl.ymd) && nowMins < targetMins) {
    return chileTimeToday(cl, hour, minute);
  }
  const nextYmd = nextChileBusinessDayYmd(cl.ymd);
  return nextYmd ? chileTimeOnYmd(nextYmd, hour, minute) : chileTimeToday(cl, hour, minute);
}

function nextSbifMonthlyDue(cl: ChileWallClock): SyncWallTime {
  if (cl.day < 9) return chileTimeOnYmd(`${cl.monthKey}-09`, 0, 0);
  const nextM = cl.month === 12 ? 1 : cl.month + 1;
  const nextY = cl.month === 12 ? cl.year + 1 : cl.year;
  return chileTimeOnYmd(`${nextY}-${String(nextM).padStart(2, "0")}-09`, 0, 0);
}

/** The one instant every clock of a schedule reads: the injected Chile wall clock. */
export function scheduleInstant(cl: ChileWallClock): Date {
  return dateAtTimeZoneWallClock(cl.ymd, cl.hour, cl.minute, "America/Santiago");
}

/** Forex days: every weekday is one (holidays included), so the kind is weekday / weekend only. */
export function forexDayKind(ymd: string): SyncSourceDayKind {
  return isWeekendYmd(ymd) ? "weekend" : "open";
}

/** A publisher printing on business days (`publisherSchedule.ts`): the first publish hour expecting a day beyond `latestDay`. */
export function publisherNextSync(cl: ChileWallClock, latestDay: string | null, s: PublisherSchedule): SyncWallTime | null {
  const next = nextPublishDue(cl, latestDay, s);
  return next ? chileTimeOnYmd(next.ymd, next.hour, 0) : null;
}

/**
 * The evening the next Fintual cuota is due: the first publish day whose 18:00 is still ahead —
 * today before 18:00, else from tomorrow (a Sunday closing a holiday block counts). The old
 * branch only handled "today, before 18:00" and otherwise jumped to the publish day AFTER the
 * next one, so from Saturday it scheduled Monday and slept through Sunday's 18:00 while the stale
 * rule flipped (2026-09-20). A cuota already applied for a day at or after that (Fintual
 * forward-publishes a holiday block) needs no poll until the first publish day after it — the
 * same rule `isFintualSyncStale` applies.
 */
export function fintualNextSync(cl: ChileWallClock, appliedPublishYmd: string | null | undefined): SyncWallTime | null {
  const nowMins = cl.hour * 60 + cl.minute;
  let fromYmd = nowMins < EVENING_PUBLISH_HOUR_CHILE * 60 ? cl.ymd : chileCalendarAddDays(cl.ymd, 1);
  const applied = appliedPublishYmd?.trim();
  if (applied && /^\d{4}-\d{2}-\d{2}$/.test(applied) && applied >= fromYmd) {
    fromYmd = chileCalendarAddDays(applied, 1);
  }
  const nextPub = nextFintualPublishDayYmd(fromYmd);
  return nextPub ? chileTimeOnYmd(nextPub, EVENING_PUBLISH_HOUR_CHILE, 0) : null;
}

/** Banco Central dólar / euro observado: 18:00 on the next Chile business day. */
export function sbifObservedNextSync(cl: ChileWallClock): SyncWallTime {
  return nextChileBusinessTime(cl, SBIF_OBSERVED_STALE_AFTER_HOUR_CHILE, 0);
}

/** UF / UTM / IPC: the 9th of this month, or of the next one. */
export function sbifMonthlyNextSync(cl: ChileWallClock): SyncWallTime {
  return nextSbifMonthlyDue(cl);
}

/** NYSE EOD: 16:05 New York on the next trading day still before its close. */
export function stocksNyseNextSync(cl: ChileWallClock): SyncWallTime | null {
  const instant = scheduleInstant(cl);
  const nowNy = nyseWallClock(instant);
  if (isNyseTradingDay(nowNy.ymd) && !isAfterNyseRegularClose(instant)) return nyTimeToday(nowNy, 16, 5);
  const scanFrom = isNyseTradingDay(nowNy.ymd) ? chileCalendarAddDays(nowNy.ymd, 1) : nowNy.ymd;
  const next = nextNyseTradingDayYmd(scanFrom);
  return next ? { ymd: next, hour: 16, minute: 5, timeZone: "America/New_York" } : null;
}

/** The NYSE day kind of the injected clock's instant. */
export function nyseDayKindAt(cl: ChileWallClock): SyncSourceDayKind {
  return nyDayKind(nyseWallClock(scheduleInstant(cl)).ymd);
}

/**
 * Bolsa de Santiago EOD — Chile calendar only: today 17:10 while the session is still
 * open/closing, else the next Chile business day; Chilean holidays and weekends skip, NYSE
 * holidays do not.
 */
export function stocksSantiagoNextSync(cl: ChileWallClock): SyncWallTime | null {
  if (isChileBusinessDay(cl.ymd) && !isSantiagoEodSyncWindow(cl)) {
    return chileTimeToday(cl, SANTIAGO_EOD_SYNC_AFTER_HOUR_CHILE, SANTIAGO_EOD_SYNC_AFTER_MINUTE_CHILE);
  }
  const next = nextChileBusinessDayYmd(cl.ymd);
  return next ? chileTimeOnYmd(next, SANTIAGO_EOD_SYNC_AFTER_HOUR_CHILE, SANTIAGO_EOD_SYNC_AFTER_MINUTE_CHILE) : null;
}

/** Yahoo USD/CLP: the fx day end, 17:05 New York on weekdays (`forexDay.ts`). */
export function yahooFxNextSync(cl: ChileWallClock): SyncWallTime {
  const dueToday = !isWeekendYmd(cl.ymd) && scheduleInstant(cl).getTime() < fxDayEndInstant(cl.ymd).getTime();
  const ymd = dueToday ? cl.ymd : nextWeekdayYmd(cl.ymd);
  return { ymd, hour: FX_DAY_END_HOUR_NY, minute: FX_DAY_END_MINUTE_NY, timeZone: "America/New_York" };
}

/** Crypto EOD: 23:55 Chile today, else tomorrow. */
export function cryptoNextSync(cl: ChileWallClock): SyncWallTime {
  const nowMins = cl.hour * 60 + cl.minute;
  const dueMins = CRYPTO_EOD_SYNC_AFTER_HOUR_CHILE * 60 + CRYPTO_EOD_SYNC_AFTER_MINUTE_CHILE;
  if (!isCryptoEodSyncWindow(cl) && nowMins < dueMins) {
    return chileTimeToday(cl, CRYPTO_EOD_SYNC_AFTER_HOUR_CHILE, CRYPTO_EOD_SYNC_AFTER_MINUTE_CHILE);
  }
  return chileTimeOnYmd(chileCalendarAddDays(cl.ymd, 1), CRYPTO_EOD_SYNC_AFTER_HOUR_CHILE, CRYPTO_EOD_SYNC_AFTER_MINUTE_CHILE);
}

/** Risky Norris composition: once per due day at 18:30 (today if not yet reached, else the next due day). */
export function rnCompositionNextSync(cl: ChileWallClock, state: GlobalSyncStateFile): SyncWallTime | null {
  const last = state.fintualRnCompositionLastSyncYmd?.trim();
  const nowMins = cl.hour * 60 + cl.minute;
  const dueMins = FINTUAL_RN_COMPOSITION_SYNC_HOUR_CHILE * 60 + FINTUAL_RN_COMPOSITION_SYNC_MINUTE_CHILE;
  const dueToday = isFintualRnCompositionDueDay(cl.ymd) && nowMins < dueMins && last !== cl.ymd;
  const nextYmd = dueToday ? cl.ymd : nextFintualRnCompositionDueYmd(cl.ymd);
  return nextYmd
    ? chileTimeOnYmd(nextYmd, FINTUAL_RN_COMPOSITION_SYNC_HOUR_CHILE, FINTUAL_RN_COMPOSITION_SYNC_MINUTE_CHILE)
    : null;
}

/** Fintual official serie: due again while a placeholder row waits for it; nothing pending = no wake. */
export function officialSerieNextSync(cl: ChileWallClock, state: GlobalSyncStateFile): SyncWallTime | null {
  const due = fintualOfficialSerieNextDue(cl, state);
  return due ? chileTimeOnYmd(due.ymd, due.hour, due.minute) : null;
}

/** CMF filing: one attempt a day from 09:00 while the previous month's filing is not on record; else the 1st of next month. */
export function cmfNextSync(cl: ChileWallClock, state: GlobalSyncStateFile): SyncWallTime {
  return chileTimeOnYmd(cmfRnNextDueYmd(cl, state), CMF_RN_SYNC_HOUR_CHILE, 0);
}
