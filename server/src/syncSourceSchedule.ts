import { chileCalendarAddDays, dateAtTimeZoneWallClock, type ChileWallClock } from "./chileDate.js";
import {
  CRYPTO_EOD_SYNC_AFTER_HOUR_CHILE,
  CRYPTO_EOD_SYNC_AFTER_MINUTE_CHILE,
  isCryptoEodSyncWindow,
} from "./equityEodSync.js";
import {
  isYahooFxEodSyncWindow,
  YAHOO_FX_EOD_SYNC_AFTER_HOUR_CHILE,
  YAHOO_FX_EOD_SYNC_AFTER_MINUTE_CHILE,
} from "./fxYahooEodSync.js";
import { isFintualFundPublishDay } from "./fintualPublishDate.js";
import { loadGlobalSyncState } from "./globalSyncState.js";
import type { GlobalSyncSource } from "./globalSyncStale.js";
import { isChileBusinessDay, isChileHoliday, isNyseHoliday, isNyseTradingDay } from "./marketHolidays.js";
import { isAfterNyseRegularClose, nyseWallClock } from "./nyseSession.js";

const SBIF_OBSERVED_STALE_AFTER_HOUR_CHILE = 18;
/** Chile hour (inclusive) from which the daily Risky Norris composition sync is due. */
export const FINTUAL_RN_COMPOSITION_SYNC_HOUR_CHILE = 10;

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

function chileDayKind(ymd: string): SyncSourceDayKind {
  if (isChileHoliday(ymd)) return "holiday";
  if (!isChileBusinessDay(ymd)) return "weekend";
  return "open";
}

function nyDayKind(ymd: string): SyncSourceDayKind {
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

function scheduleForSource(
  source: GlobalSyncSource,
  cl: ChileWallClock,
  stale: boolean,
  disabled: boolean
): SyncSourceScheduleMeta {
  if (disabled) {
    return { next_sync: null, next_sync_imminent: false, today_day_kind: "open" };
  }
  if (stale) {
    return {
      next_sync: null,
      next_sync_imminent: true,
      today_day_kind:
        source === "stocks_nyse"
          ? nyDayKind(nyseWallClock().ymd)
          : source === "crypto_eod"
            ? chileDayKind(cl.ymd)
            : chileDayKind(cl.ymd),
    };
  }

  const ny = nyseWallClock();

  switch (source) {
    case "afp_uno": {
      const nextYmd = nextChileBusinessDayYmd(cl.ymd);
      return {
        next_sync: nextYmd ? chileTimeOnYmd(nextYmd, 0, 0) : null,
        next_sync_imminent: false,
        today_day_kind: chileDayKind(cl.ymd),
      };
    }
    case "fintual": {
      let publishYmd = isFintualFundPublishDay(cl.ymd) ? cl.ymd : nextFintualPublishDayYmd(cl.ymd);
      if (!publishYmd) publishYmd = cl.ymd;
      const nowMins = cl.hour * 60 + cl.minute;
      const dueMins = 18 * 60;
      if (publishYmd === cl.ymd && nowMins < dueMins) {
        return {
          next_sync: chileTimeToday(cl, 18, 0),
          next_sync_imminent: false,
          today_day_kind: chileDayKind(cl.ymd),
        };
      }
      // "Next" must be strictly after the current poll day.
      // `nextFintualPublishDayYmd()` includes `fromYmd` itself, so when we’re already
      // past 18:00 we must start from the following calendar day.
      const nextPub = nextFintualPublishDayYmd(chileCalendarAddDays(publishYmd, 1));
      return {
        next_sync: nextPub ? chileTimeOnYmd(nextPub, 18, 0) : chileTimeToday(cl, 18, 0),
        next_sync_imminent: false,
        today_day_kind: chileDayKind(cl.ymd),
      };
    }
    case "sbif_usd":
    case "sbif_eur":
      return {
        next_sync: nextChileBusinessTime(cl, SBIF_OBSERVED_STALE_AFTER_HOUR_CHILE, 0),
        next_sync_imminent: false,
        today_day_kind: chileDayKind(cl.ymd),
      };
    case "sbif_uf":
    case "sbif_utm":
    case "sbif_ipc":
      return {
        next_sync: nextSbifMonthlyDue(cl),
        next_sync_imminent: false,
        today_day_kind: chileDayKind(cl.ymd),
      };
    case "stocks_nyse": {
      const nowNy = ny;
      if (isNyseTradingDay(nowNy.ymd) && !isAfterNyseRegularClose(new Date())) {
        return {
          next_sync: nyTimeToday(nowNy, 16, 5),
          next_sync_imminent: false,
          today_day_kind: nyDayKind(nowNy.ymd),
        };
      }
      const scanFrom = isNyseTradingDay(nowNy.ymd) ? chileCalendarAddDays(nowNy.ymd, 1) : nowNy.ymd;
      const next = nextNyseTradingDayYmd(scanFrom);
      return {
        next_sync: next ? { ymd: next, hour: 16, minute: 5, timeZone: "America/New_York" } : null,
        next_sync_imminent: false,
        today_day_kind: nyDayKind(nowNy.ymd),
      };
    }
    case "yahoo_fx_usd": {
      const nowMins = cl.hour * 60 + cl.minute;
      const dueMins = YAHOO_FX_EOD_SYNC_AFTER_HOUR_CHILE * 60 + YAHOO_FX_EOD_SYNC_AFTER_MINUTE_CHILE;
      if (!isYahooFxEodSyncWindow(cl) && nowMins < dueMins) {
        return {
          next_sync: chileTimeToday(cl, YAHOO_FX_EOD_SYNC_AFTER_HOUR_CHILE, YAHOO_FX_EOD_SYNC_AFTER_MINUTE_CHILE),
          next_sync_imminent: false,
          today_day_kind: chileDayKind(cl.ymd),
        };
      }
      const tomorrow = chileCalendarAddDays(cl.ymd, 1);
      return {
        next_sync: chileTimeOnYmd(tomorrow, YAHOO_FX_EOD_SYNC_AFTER_HOUR_CHILE, YAHOO_FX_EOD_SYNC_AFTER_MINUTE_CHILE),
        next_sync_imminent: false,
        today_day_kind: chileDayKind(cl.ymd),
      };
    }
    case "crypto_eod": {
      const nowMins = cl.hour * 60 + cl.minute;
      const dueMins = CRYPTO_EOD_SYNC_AFTER_HOUR_CHILE * 60 + CRYPTO_EOD_SYNC_AFTER_MINUTE_CHILE;
      if (!isCryptoEodSyncWindow(cl) && nowMins < dueMins) {
        return {
          next_sync: chileTimeToday(cl, CRYPTO_EOD_SYNC_AFTER_HOUR_CHILE, CRYPTO_EOD_SYNC_AFTER_MINUTE_CHILE),
          next_sync_imminent: false,
          today_day_kind: chileDayKind(cl.ymd),
        };
      }
      const tomorrow = chileCalendarAddDays(cl.ymd, 1);
      return {
        next_sync: chileTimeOnYmd(tomorrow, CRYPTO_EOD_SYNC_AFTER_HOUR_CHILE, CRYPTO_EOD_SYNC_AFTER_MINUTE_CHILE),
        next_sync_imminent: false,
        today_day_kind: chileDayKind(cl.ymd),
      };
    }
    case "fintual_rn_composition": {
      // Due once per Chile business day at 10:00 (today if not yet reached, else next business day).
      const last = loadGlobalSyncState().fintualRnCompositionLastSyncYmd?.trim();
      const nowMins = cl.hour * 60 + cl.minute;
      const dueMins = FINTUAL_RN_COMPOSITION_SYNC_HOUR_CHILE * 60;
      const dueToday = isChileBusinessDay(cl.ymd) && nowMins < dueMins && last !== cl.ymd;
      const nextYmd = dueToday ? cl.ymd : nextChileBusinessDayYmd(cl.ymd);
      return {
        next_sync: nextYmd ? chileTimeOnYmd(nextYmd, FINTUAL_RN_COMPOSITION_SYNC_HOUR_CHILE, 0) : null,
        next_sync_imminent: false,
        today_day_kind: chileDayKind(cl.ymd),
      };
    }
    default:
      return { next_sync: null, next_sync_imminent: false, today_day_kind: "open" };
  }
}

export function attachSyncSourceSchedule(
  source: GlobalSyncSource,
  cl: ChileWallClock,
  stale: boolean,
  disabled: boolean
): SyncSourceScheduleMeta {
  return scheduleForSource(source, cl, stale, disabled);
}
