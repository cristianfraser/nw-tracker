import { chileCalendarAddDays, chileWallClockNow, type ChileWallClock } from "./chileDate.js";

/**
 * `as_of_date` for Fintual goal NAV from the API.
 * After 18:00 Chile the API still reflects the **prior calendar day's** close until Fintual publishes
 * the new total (often the same Friday close tweaked again on Sunday evening).
 */
export function fintualValuationAsOfYmd(cl: ChileWallClock = chileWallClockNow()): string {
  if (cl.hour >= 18) return chileCalendarAddDays(cl.ymd, -1);
  return cl.ymd;
}
