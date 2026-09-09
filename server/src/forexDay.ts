/**
 * The forex day for CLP=X — the one frame every USD/CLP reader shares.
 *
 * Yahoo's CLP=X quote floats from the Sunday-evening reopen until the New York close and goes
 * flat overnight (the peso is an onshore currency: liquidity follows Chile / New York business
 * hours), so the app's fx day is the standard forex day ending 17:00 New York, observed at 17:05
 * so the last prints land. Chile calendar day D is the fx day that ends at 17:05 New York on D —
 * New York and Chile share the calendar date at that hour in every DST combination. Weekends read
 * Friday's close: there is no Saturday or Sunday row, and the Sunday-evening reopen is never
 * stored (it used to be, as Yahoo's Sunday-dated week-open bar — migration 180 removed 607 rows).
 * Holidays play no part: forex trades through US and Chilean holidays, and the NYSE session that
 * used to gate the live rate (pinning it for whole US holidays) is not this market's calendar.
 */
import { chileCalendarAddDays, chileWallClockAt, dateAtTimeZoneWallClock } from "./chileDate.js";
import { isWeekendYmd } from "./marketHolidays.js";

export const FX_DAY_END_HOUR_NY = 17;
export const FX_DAY_END_MINUTE_NY = 5;

/** Instant at which Chile day `ymd`'s fx rate freezes: 17:05 America/New_York on that date. */
export function fxDayEndInstant(ymd: string): Date {
  return dateAtTimeZoneWallClock(ymd, FX_DAY_END_HOUR_NY, FX_DAY_END_MINUTE_NY, "America/New_York");
}

/** Last weekday strictly before `ymd` (calendar days; holidays are forex days). */
export function priorWeekdayYmd(ymd: string): string {
  let cur = chileCalendarAddDays(ymd, -1);
  while (isWeekendYmd(cur)) cur = chileCalendarAddDays(cur, -1);
  return cur;
}

/** First weekday strictly after `ymd`. */
export function nextWeekdayYmd(ymd: string): string {
  let cur = chileCalendarAddDays(ymd, 1);
  while (isWeekendYmd(cur)) cur = chileCalendarAddDays(cur, 1);
  return cur;
}

/**
 * Live CLP=X is today's rate while the fx day is open: a weekday (Chile calendar) before its
 * 17:05 New York end. Outside it — evenings, weekends — today's rate is the stored close.
 */
export function isFxDayOpen(now: Date = new Date()): boolean {
  const cl = chileWallClockAt(now);
  if (isWeekendYmd(cl.ymd)) return false;
  return now.getTime() < fxDayEndInstant(cl.ymd).getTime();
}

/**
 * Chile day whose fx close must be in `fx_daily` now: today once its fx day has ended, otherwise
 * the last weekday before today — a missed evening stays due until the row lands.
 */
export function fxDayDueYmd(now: Date = new Date()): string {
  const cl = chileWallClockAt(now);
  if (!isWeekendYmd(cl.ymd) && now.getTime() >= fxDayEndInstant(cl.ymd).getTime()) return cl.ymd;
  return priorWeekdayYmd(cl.ymd);
}
