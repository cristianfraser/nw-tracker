import { monthEndUtcYmd } from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { addMonths, annualize, monthSpanInclusive, type PeriodReturnsPayload } from "./periodReturns.js";

/**
 * The Rentabilidad month windows (MTD, YTD, 1A, 3A, 5A, TOTAL) chained from DAILY returns: each
 * day's flow-adjusted `pct` of the account's or group's own daily series, from the month-end
 * before the window's first month through today. Chaining months instead treats a month's
 * deposits as if they arrived on its first day, which misstates a month with large mid-month
 * flows (Acciones: 7,6% monthly vs 12,6% daily over its history). A day without a return (nothing
 * held) is flat; a window with none at all is null. The pesos (`nominal_pl`) and the window
 * bounds stay the monthly ones; 1D/1W are daily already and are left alone. Annualized on the
 * same windows as before (more than 12 calendar months). Pure.
 */
export function withDailyChainedReturns(
  payload: PeriodReturnsPayload | null,
  points: readonly { as_of_date: string; pct: number | null }[],
  todayYmd: string = chileCalendarTodayYmd()
): PeriodReturnsPayload | null {
  if (payload == null) return null;
  const anchorMk = todayYmd.slice(0, 7);
  return {
    ...payload,
    periods: payload.periods.map((cell) => {
      if (cell.window_start_date || !cell.window_start_month) return cell;
      const startYmd = monthEndUtcYmd(addMonths(cell.window_start_month, -1));
      let prod = 1;
      let any = false;
      for (const p of points) {
        if (p.as_of_date <= startYmd || p.as_of_date > todayYmd) continue;
        if (p.pct == null || !Number.isFinite(p.pct)) continue;
        prod *= 1 + p.pct;
        any = true;
      }
      const pct = any ? prod - 1 : null;
      return {
        ...cell,
        pct,
        annualized_pct: annualize(pct, monthSpanInclusive(cell.window_start_month, anchorMk)),
      };
    }),
  };
}
