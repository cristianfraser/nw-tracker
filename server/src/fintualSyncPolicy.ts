import { chileWallClockNow, type ChileWallClock } from "./chileDate.js";

/**
 * `as_of_date` for Fintual goal NAV from `GET /api/goals`.
 * After 18:00 Chile, Fintual's UI labels the published total with **today's** calendar date.
 */
export function fintualValuationAsOfYmd(cl: ChileWallClock = chileWallClockNow()): string {
  return cl.ymd;
}
