import { chileCalendarAddDays, type ChileWallClock } from "./chileDate.js";
import { isChileBusinessDay, isChileHoliday } from "./marketHolidays.js";

/** Last calendar day of a consecutive Chile holiday run (Fintual may still publish that day). */
export function isLastDayOfChileHolidayStreak(ymd: string): boolean {
  if (!isChileHoliday(ymd)) return false;
  const next = chileCalendarAddDays(ymd, 1);
  return !isChileHoliday(next);
}

/**
 * Days when Fintual may publish a new fund cuota: business days, plus the last day of a holiday streak.
 * Mid-streak holidays (e.g. Wed in Wed–Thu) are not publish days.
 */
export function isFintualFundPublishDay(ymd: string): boolean {
  if (isChileBusinessDay(ymd)) return true;
  if (isChileHoliday(ymd)) return isLastDayOfChileHolidayStreak(ymd);
  return false;
}

/** Latest Fintual publish day strictly before `beforeYmd`. */
export function priorFintualPublishYmd(beforeYmd: string, maxSteps = 14): string | null {
  let cur = chileCalendarAddDays(beforeYmd, -1);
  for (let i = 0; i < maxSteps; i++) {
    if (isFintualFundPublishDay(cur)) return cur;
    cur = chileCalendarAddDays(cur, -1);
  }
  return null;
}

export type FintualPublishDateHints = {
  /** Any mapped `real_assets/.../days` row for Chile today. */
  hasTodayInSeries: boolean;
  /** Max `last_day.date` from mapped real_assets (YYYY-MM-DD). */
  lastDayDate: string | null;
};

/**
 * `as_of_date` for evening Fintual apply: today's publish when the API has today's cuota;
 * otherwise the latest published fund day (e.g. Thursday holiday tweak polled on Friday evening).
 */
export function resolveFintualPublishYmd(
  cl: ChileWallClock,
  hints: FintualPublishDateHints
): string {
  if (cl.hour < 18) return cl.ymd;

  const last = hints.lastDayDate?.trim();
  if (last && /^\d{4}-\d{2}-\d{2}$/.test(last)) {
    // API forward-published (holiday end, often visible on a prior business evening).
    if (last > cl.ymd) return last;
  }

  if (hints.hasTodayInSeries && isFintualFundPublishDay(cl.ymd)) {
    return cl.ymd;
  }

  if (last && /^\d{4}-\d{2}-\d{2}$/.test(last)) {
    if (last < cl.ymd) return last;
    if (last === cl.ymd) return cl.ymd;
  }

  return priorFintualPublishYmd(cl.ymd) ?? last ?? cl.ymd;
}
